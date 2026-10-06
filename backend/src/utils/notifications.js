import db, { contract as defaultContract } from '../db.js';
import { EventEmitter } from 'node:events';

export const notificationEvents = new EventEmitter();

// Notificaciones in-app: se muestran en la campana del header. No son correos,
// solo eventos internos del sistema (asignación, comentarios, cierre, etc.).
export function createNotification({ userId, ticketId = null, type, title, body = null, link = null }) {
  if (!userId) return null;
  const info = db
    .prepare(
      'INSERT INTO notifications (user_id, ticket_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(userId, ticketId, String(type).toUpperCase(), String(title).slice(0, 200), body ? String(body).slice(0, 500) : null, link || null);
  
  const notificationId = info.lastInsertRowid;
  notificationEvents.emit('new_notification', { id: notificationId, userId, ticketId, type, title, body, link });
  return notificationId;
}

// Variante por el contrato async (camino MSSQL). Mismo orden de columnas,
// mismo recorte de longitudes y el MISMO evento: la campana no distingue
// motor, así que el id emitido tiene que ser el que generó la base.
export async function createNotificationAsync(
  { userId, ticketId = null, type, title, body = null, link = null },
  dataContract = defaultContract,
) {
  if (!userId) return null;
  const { id } = await dataContract.insertAndGetId(
    `INSERT INTO notifications (user_id, ticket_id, type, title, body, link)
     OUTPUT INSERTED.id AS id
     VALUES (@userId, @ticketId, @type, @title, @body, @link)`,
    {
      userId,
      ticketId,
      type: String(type).toUpperCase(),
      title: String(title).slice(0, 200),
      body: body ? String(body).slice(0, 500) : null,
      link: link || null,
    },
  );
  notificationEvents.emit('new_notification', { id, userId, ticketId, type, title, body, link });
  return id;
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
export function notifyAdmins({ type, title, body = null, ticketId = null, link = null }) {
  const admins = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE u.active = 1 AND p.code = 'settings.manage'`
    )
    .all();
  return createNotifications({ userIds: admins.map((a) => a.id), type, title, body, ticketId, link });
}

// Notifica a técnicos/soporte (quienes pueden ver todos los tickets).
const STAFF_SQL = `
  SELECT u.id FROM users u
  JOIN roles r ON r.id = u.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE u.active = 1 AND p.code = 'ticket.view.all'`;

export function notifyStaff({ type, title, body = null, ticketId = null, excludeUserId = null, link = null }) {
  const staff = db.prepare(STAFF_SQL).all();
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

/**
 * Mismo aviso por el contrato async. Comparte STAFF_SQL con la variante
 * síncrona para que el destinatario no pueda diferir entre motores; se usa en
 * el POST /api/tickets de SQL Server, donde `db.prepare` no existe.
 */
export async function notifyStaffAsync(
  { type, title, body = null, ticketId = null, excludeUserId = null, link = null },
  dataContract = defaultContract,
) {
  const staff = await dataContract.queryMany(STAFF_SQL);
  const exclude = Number(excludeUserId);
  const userIds = staff.map((s) => s.id).filter((id) => Number(id) !== exclude);
  const inserted = [];
  for (const userId of [...new Set(userIds)]) {
    const id = await createNotificationAsync({ userId, ticketId, type, title, body, link }, dataContract);
    if (id) inserted.push(id);
  }
  return inserted;
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