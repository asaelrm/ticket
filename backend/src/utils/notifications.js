import db from '../db.js';
import { EventEmitter } from 'node:events';

export const notificationEvents = new EventEmitter();

// ETAPA 3 (defensa central): antes de crear una notificación ligada a un
// ticket, el destinatario debe pertenecer a la MISMA organización del ticket.
// Es la red de seguridad que cubre cualquier flujo (normal, jobs o datos
// legacy corruptos): si el usuario no existe, no tiene org o la org no
// coincide, la notificación no se crea. Las notificaciones de sistema o no
// ligadas a tickets (password reset, avisos globales) pasan ticketId = null.
function recipientInTicketOrg(userId, ticketId) {
  const row = db
    .prepare(
      `SELECT u.organization_id AS user_org, t.organization_id AS ticket_org
       FROM users u, tickets t WHERE u.id = ? AND t.id = ?`
    )
    .get(userId, ticketId);
  if (!row || row.user_org == null || row.ticket_org == null) return false;
  return Number(row.user_org) === Number(row.ticket_org);
}

// Notificaciones in-app: se muestran en la campana del header. No son correos,
// solo eventos internos del sistema (asignación, comentarios, cierre, etc.).
export function createNotification({ userId, ticketId = null, type, title, body = null, link = null }) {
  if (!userId) return null;
  if (ticketId != null && !recipientInTicketOrg(userId, ticketId)) return null;
  const info = db
    .prepare(
      'INSERT INTO notifications (user_id, ticket_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(userId, ticketId, String(type).toUpperCase(), String(title).slice(0, 200), body ? String(body).slice(0, 500) : null, link || null);
  
  const notificationId = info.lastInsertRowid;
  notificationEvents.emit('new_notification', { id: notificationId, userId, ticketId, type, title, body, link });
  return notificationId;
}

export function createNotifications({ userIds = [], ...rest }) {
  const ids = [...new Set(userIds.map((u) => Number(u)).filter(Boolean))];
  const inserted = [];
  for (const id of ids) {
    const nid = createNotification({ ...rest, userId: id });
    if (nid) inserted.push(nid);
  }
  return inserted;
}

// Notifica a todos los administradores activos (para alertas del sistema).
// ETAPA 3: cuando `organizationId` viene dado (p. ej. la org del ticket que
// disparó la alerta), el aviso solo alcanza a administradores de ESA
// organización. Sin `organizationId` (alertas globales del sistema, sin
// contexto de ticket) se conserva el comportamiento original: todos los
// administradores activos.
export function notifyAdmins({ type, title, body = null, ticketId = null, link = null, organizationId = null }) {
  let sql = `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.active = 1 AND p.code = 'settings.manage'`;
  const params = [];
  if (organizationId != null) {
    sql += ` AND u.organization_id = ?`;
    params.push(organizationId);
  }
  const admins = db.prepare(sql).all(...params);
  return createNotifications({ userIds: admins.map((a) => a.id), type, title, body, ticketId, link });
}

// Notifica a técnicos/soporte (quienes pueden ver todos los tickets).
// ETAPA 3: mismo criterio que notifyAdmins. Los avisos de ticket (NEW_TICKET,
// SLAs, etc.) pasan `organizationId: ticket.organization_id` y solo llegan a
// personal de la MISMA org; una alerta global sin contexto conserva todos los
// técnicos activos.
export function notifyStaff({ type, title, body = null, ticketId = null, excludeUserId = null, link = null, organizationId = null }) {
  let sql = `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.active = 1 AND p.code = 'ticket.view.all'`;
  const params = [];
  if (organizationId != null) {
    sql += ` AND u.organization_id = ?`;
    params.push(organizationId);
  }
  const staff = db.prepare(sql).all(...params);
  const exclude = Number(excludeUserId);
  return createNotifications({
    userIds: staff.map((s) => s.id).filter((id) => Number(id) !== exclude),
    type,
    title,
    body,
    ticketId,
    link,
  });
}

// Notificación dirigida a los participantes naturales de un ticket
// (reportante/tecnico), excluyendo al actor que origina el evento.
export function notifyTicketParticipants(ticket, { type, actorId, titleForReporter, titleForAssignee }) {
  const actor = Number(actorId);
  const reporterId = ticket.reporter_id ? Number(ticket.reporter_id) : null;
  const assigneeId = ticket.assigned_to_id ? Number(ticket.assigned_to_id) : null;

  const targets = [];
  if (reporterId && reporterId !== actor) targets.push({ userId: reporterId, title: titleForReporter });
  // Si el asignado es también el reportante, evitamos una notificación duplicada.
  if (assigneeId && assigneeId !== actor && assigneeId !== reporterId) {
    targets.push({ userId: assigneeId, title: titleForAssignee });
  }
  if (!targets.length) return [];

  const link = `/app/tickets/${ticket.id}`;
  return targets.map((t) =>
    createNotification({
      userId: t.userId,
      ticketId: ticket.id,
      type,
      title: t.title,
      body: `${ticket.ticket_number} · ${ticket.title}`,
      link,
    })
  );
}