import db, { nowIso } from '../db.js';
import { OPEN_STATUSES, computeSlaDue } from './sla.js';
import { createNotification, createNotifications, notifyAdmins } from './notifications.js';
import { getRuleSettings } from './options.js';

// Tareas de mantenimiento programadas: detección de SLA vencido y reglas de
// escalación automática. Se ejecutan de forma periódica (ver startJobs).

const PRIORITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
export const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

function alreadyNotified(ticketId, type) {
  return Boolean(db.prepare('SELECT 1 FROM notifications WHERE ticket_id = ? AND type = ? LIMIT 1').get(ticketId, type));
}

function targetUsersFor(ticket) {
  if (ticket.assigned_to_id) return [ticket.assigned_to_id];
  if (ticket.assigned_team_id) {
    const members = db
      .prepare('SELECT user_id FROM team_members WHERE team_id = ?')
      .all(ticket.assigned_team_id)
      .map((r) => r.user_id);
    if (members.length) return members;
  }
  const admins = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE u.active = 1 AND p.code = 'settings.manage'`
    )
    .all();
  return admins.map((a) => a.id);
}

function notifyOverdueTickets() {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name,
              r.email AS reporter_email,
              COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name
       FROM tickets t
       JOIN users r ON r.id = t.reporter_id
       LEFT JOIN users au ON au.id = t.assigned_to_id
       WHERE t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         AND t.sla_due_at IS NOT NULL
         AND t.sla_due_at < ?`
    )
    .all(...OPEN_STATUSES, now);

  let count = 0;
  for (const ticket of rows) {
    if (alreadyNotified(ticket.id, 'SLA_OVERDUE')) continue;
    const users = targetUsersFor(ticket);
    const ids = createNotifications({
      userIds: users,
      ticketId: ticket.id,
      type: 'SLA_OVERDUE',
      title: `Vence SLA: ${ticket.ticket_number}`,
      body: `El ticket "${ticket.title}" está vencido en SLA.`,
      link: `/app/tickets/${ticket.id}`,
    });
    count += ids.length;
  }
  return count;
}

function escalateUnassigned() {
  const rules = getRuleSettings();
  const hours = rules.rule_unassigned_hours;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  const target = rules.rule_unassigned_priority.toUpperCase();
  if (!(target in PRIORITY_RANK)) return 0;
  const targetRank = PRIORITY_RANK[target];

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name
       FROM tickets t JOIN users r ON r.id = t.reporter_id
       WHERE t.status = 'OPEN' AND t.assigned_to_id IS NULL AND t.assigned_team_id IS NULL
         AND t.created_at < ?
         AND t.priority NOT IN ('CRITICAL')`
    )
    .all(cutoff);

  let count = 0;
  for (const ticket of rows) {
    const currentRank = PRIORITY_RANK[ticket.priority] ?? 0;
    if (currentRank >= targetRank) continue;
    const newPriority = target;
    db.prepare('UPDATE tickets SET priority = ?, sla_due_at = ?, updated_at = ? WHERE id = ?').run(
      newPriority,
      computeSlaDue(newPriority),
      nowIso(),
      ticket.id
    );
    db.prepare(
      'INSERT INTO ticket_history (ticket_id, user_id, action, description, old_value, new_value) VALUES (?, NULL, ?, ?, ?, ?)'
    ).run(
      ticket.id,
      'ESCALATED',
      `Escalación automática: prioridad ${PRIORITY_LABEL[ticket.priority]} → ${PRIORITY_LABEL[newPriority]}`,
      ticket.priority,
      newPriority
    );
    notifyAdmins({
      ticketId: ticket.id,
      type: 'ESCALATED',
      title: `Ticket sin asignar escalado: ${ticket.ticket_number}`,
      body: `"${ticket.title}" subió a prioridad ${PRIORITY_LABEL[newPriority]} por falta de asignación.`,
      link: `/app/tickets/${ticket.id}`,
    });
    count += 1;
  }
  return count;
}

function alertCriticalLongOpen() {
  const rules = getRuleSettings();
  const hours = rules.rule_critical_hours;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name,
              COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name
       FROM tickets t
       JOIN users r ON r.id = t.reporter_id
       LEFT JOIN users au ON au.id = t.assigned_to_id
       WHERE t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
         AND t.priority = 'CRITICAL' AND t.created_at < ?`
    )
    .all(...OPEN_STATUSES, cutoff);

  let count = 0;
  for (const ticket of rows) {
    if (alreadyNotified(ticket.id, 'CRITICAL_UNRESOLVED')) continue;
    const ids = notifyAdmins({
      ticketId: ticket.id,
      type: 'CRITICAL_UNRESOLVED',
      title: `Crítico sin resolver: ${ticket.ticket_number}`,
      body: `"${ticket.title}" lleva más de ${hours} h con prioridad crítica.`,
      link: `/app/tickets/${ticket.id}`,
    });
    count += ids.length;
  }
  return count;
}

/**
 * Ejecuta el mantenimiento programado una vez.
 * Devuelve un resumen de acciones realizadas (útil para pruebas/manual).
 */
export function runMaintenance() {
  return {
    overdue: notifyOverdueTickets(),
    escalated: escalateUnassigned(),
    critical: alertCriticalLongOpen(),
  };
}

let started = false;

/**
 * Inicia el job periódico (cada 10 minutos). No hace nada en modo test y
 * es seguro llamarlo más de una vez (arranca una sola vez).
 */
export function startJobs() {
  if (started || process.env.NODE_ENV === 'test') return;
  started = true;
  const INTERVAL_MS = 10 * 60 * 1000;
  const timer = setInterval(() => {
    try {
      runMaintenance();
    } catch (err) {
      console.error('[jobs] Error en el mantenimiento programado:', err?.message || err);
    }
  }, INTERVAL_MS);
  timer.unref();
  try {
    runMaintenance();
  } catch (err) {
    console.error('[jobs] Error en el mantenimiento inicial:', err?.message || err);
  }
}