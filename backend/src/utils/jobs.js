import db from '../db/runtime.js';
import { nowIso } from './time.js';
import { OPEN_STATUSES, computeSlaDue } from './sla.js';
import { createNotification, createNotifications, notifyAdmins } from './notifications.js';
import { getRuleSettings } from './options.js';
import { withSettingsCache } from './settingsStore.js';
import { insertTicketHistory } from './ticketChildWrites.js';

// Tareas de mantenimiento programadas: detección de SLA vencido y reglas de
// escalación automática. Se ejecutan de forma periódica (ver startJobs).

const PRIORITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
export const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

async function alreadyNotified(ticketId, type) {
  return Boolean(await db.queryOne('SELECT 1 FROM notifications WHERE ticket_id = ? AND type = ? LIMIT 1', ticketId, type));
}

async function targetUsersFor(ticket) {
  // V3.6/V3.7: un ticket legacy sin organización no tiene destinatarios
  // seguros. La defensa central de notifications.js se niega a crear
  // notificaciones para él (exige que usuario y ticket compartan organización),
  // así que aquí se devuelve vacío en lugar de lanzar una consulta GLOBAL que
  // barriera los administradores de todas las empresas.
  if (ticket.organization_id == null) return [];
  if (ticket.assigned_to_id) return [ticket.assigned_to_id];
  if (ticket.assigned_team_id) {
    const members = (await db.queryMany('SELECT user_id FROM team_members WHERE team_id = ?', ticket.assigned_team_id))
      .map((r) => r.user_id);
    if (members.length) return members;
  }
  // ETAPA 3: el fallback recae en los administradores de la MISMA organización
  // del ticket. Sin este filtro, un SLA vencido acabaría en la bandeja de
  // administradores de organizaciones no relacionadas.
  const admins = await db.queryMany(
    `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.active = 1 AND p.code = 'settings.manage' AND u.organization_id = ?`,
    ticket.organization_id,
  );
  return admins.map((a) => a.id);
}

async function notifyOverdueTickets() {
  const now = nowIso();
  const rows = await db.queryMany(
    `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name,
            r.email AS reporter_email,
            COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name
     FROM tickets t
     JOIN users r ON r.id = t.reporter_id
     LEFT JOIN users au ON au.id = t.assigned_to_id
     WHERE t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       AND t.sla_due_at IS NOT NULL
       AND t.sla_due_at < ?`,
    ...OPEN_STATUSES,
    now,
  );

  let count = 0;
  for (const ticket of rows) {
    if (await alreadyNotified(ticket.id, 'SLA_OVERDUE')) continue;
    const users = await targetUsersFor(ticket);
    const ids = await createNotifications({
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

async function escalateUnassigned() {
  // V1: cada organización tiene sus propias reglas de escalación, así que el
  // corte por horas ya no puede aplicarse en la consulta (sería un único valor
  // para todas). Se recuperan los candidatos y cada ticket se juzga con las
  // reglas de SU organización.
  const rows = await db.queryMany(
    `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name
     FROM tickets t JOIN users r ON r.id = t.reporter_id
     WHERE t.status = 'OPEN' AND t.assigned_to_id IS NULL AND t.assigned_team_id IS NULL
       AND t.priority NOT IN ('CRITICAL')`,
  );

  let count = 0;
  for (const ticket of rows) {
    const rules = await getRuleSettings(ticket.organization_id);
    const hours = rules.rule_unassigned_hours;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const target = rules.rule_unassigned_priority.toUpperCase();
    if (!(target in PRIORITY_RANK)) continue;
    const targetRank = PRIORITY_RANK[target];

    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    if (ticket.created_at >= cutoff) continue;

    const currentRank = PRIORITY_RANK[ticket.priority] ?? 0;
    if (currentRank >= targetRank) continue;
    const newPriority = target;
    await db.execute(
      'UPDATE tickets SET priority = ?, sla_due_at = ?, updated_at = ? WHERE id = ?',
      newPriority,
      await computeSlaDue(newPriority, new Date(), ticket.organization_id),
      nowIso(),
      ticket.id,
    );
    await insertTicketHistory(
      ticket.id,
      null,
      'ESCALATED',
      `Escalación automática: prioridad ${PRIORITY_LABEL[ticket.priority]} → ${PRIORITY_LABEL[newPriority]}`,
      ticket.priority,
      newPriority,
      { organizationId: ticket.organization_id },
    );
    await notifyAdmins({
      ticketId: ticket.id,
      type: 'ESCALATED',
      title: `Ticket sin asignar escalado: ${ticket.ticket_number}`,
      body: `"${ticket.title}" subió a prioridad ${PRIORITY_LABEL[newPriority]} por falta de asignación.`,
      link: `/app/tickets/${ticket.id}`,
      organizationId: ticket.organization_id,
    });
    count += 1;
  }
  return count;
}

async function alertCriticalLongOpen() {
  // Mismo motivo que en escalateUnassigned: el umbral de horas es distinto por
  // organización, así que se comprueba ticket a ticket.
  const rows = await db.queryMany(
    `SELECT t.*, r.name || ' ' || r.last_name AS reporter_name,
            COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name
     FROM tickets t
     JOIN users r ON r.id = t.reporter_id
     LEFT JOIN users au ON au.id = t.assigned_to_id
     WHERE t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       AND t.priority = 'CRITICAL'`,
    ...OPEN_STATUSES,
  );

  let count = 0;
  for (const ticket of rows) {
    const hours = (await getRuleSettings(ticket.organization_id)).rule_critical_hours;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    if (ticket.created_at >= cutoff) continue;
    if (await alreadyNotified(ticket.id, 'CRITICAL_UNRESOLVED')) continue;
    const ids = await notifyAdmins({
      ticketId: ticket.id,
      type: 'CRITICAL_UNRESOLVED',
      title: `Crítico sin resolver: ${ticket.ticket_number}`,
      body: `"${ticket.title}" lleva más de ${hours} h con prioridad crítica.`,
      link: `/app/tickets/${ticket.id}`,
      organizationId: ticket.organization_id,
    });
    count += ids.length;
  }
  return count;
}

// Poda de notificaciones antiguas: las leídas se eliminan tras 90 días y las
// no leídas tras un año, para evitar que la tabla crezca sin límite.
async function pruneNotifications() {
  const readBefore = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const unreadBefore = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const read = await db.execute('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?', readBefore);
  const unread = await db.execute('DELETE FROM notifications WHERE read_at IS NULL AND created_at < ?', unreadBefore);
  return Number(read.rowsAffected || 0) + Number(unread.rowsAffected || 0);
}

/**
 * Ejecuta el mantenimiento programado una vez.
 * Devuelve un resumen de acciones realizadas (útil para pruebas/manual).
 *
 * Toda la pasada corre dentro de `withSettingsCache`: cada ticket consulta las
 * reglas de escalación y el SLA de SU organización y, sin caché, eso multiplicaba
 * los SELECT de configuración por el número de tickets abiertos (N+1 de
 * configuración). La caché dura exactamente esta ejecución (el AsyncLocalStorage
 * la aísla del resto de peticiones y jobs mientras dura).
 */
export async function runMaintenance() {
  return withSettingsCache(async () => ({
    overdue: await notifyOverdueTickets(),
    escalated: await escalateUnassigned(),
    critical: await alertCriticalLongOpen(),
    pruned: await pruneNotifications(),
  }));
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
    runMaintenance().catch((err) => {
      console.error('[jobs] Error en el mantenimiento programado:', err?.message || err);
    });
  }, INTERVAL_MS);
  timer.unref();
  runMaintenance().catch((err) => {
    console.error('[jobs] Error en el mantenimiento inicial:', err?.message || err);
  });
}
