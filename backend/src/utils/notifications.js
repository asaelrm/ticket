import db from '../db.js';

// Notificaciones in-app: se muestran en la campana del header. No son correos,
// solo eventos internos del sistema (asignación, comentarios, cierre, etc.).
export function createNotification({ userId, ticketId = null, type, title, body = null, link = null }) {
  if (!userId) return null;
  const info = db
    .prepare(
      'INSERT INTO notifications (user_id, ticket_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(userId, ticketId, String(type).toUpperCase(), String(title).slice(0, 200), body ? String(body).slice(0, 500) : null, link || null);
  return info.lastInsertRowid;
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
export function notifyAdmins({ type, title, body = null, ticketId = null }) {
  const admins = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE u.active = 1 AND p.code = 'settings.manage'`
    )
    .all();
  return createNotifications({ userIds: admins.map((a) => a.id), type, title, body, ticketId });
}

// Notifica a técnicos/soporte (quienes pueden ver todos los tickets).
export function notifyStaff({ type, title, body = null, ticketId = null, excludeUserId = null }) {
  const staff = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE u.active = 1 AND p.code = 'ticket.view.all'`
    )
    .all();
  return createNotifications({
    userIds: staff.map((s) => s.id).filter((id) => id !== excludeUserId),
    type,
    title,
    body,
    ticketId,
  });
}

// Notificación dirigida a los participantes naturales de un ticket
// (reportante/tecnico), excluyendo al actor que origina el evento.
export function notifyTicketParticipants(ticket, { type, actorId, titleForReporter, titleForAssignee }) {
  const ids = [];
  if (ticket.reporter_id && Number(ticket.reporter_id) !== Number(actorId)) ids.push(ticket.reporter_id);
  if (ticket.assigned_to_id && Number(ticket.assigned_to_id) !== Number(actorId)) ids.push(ticket.assigned_to_id);
  if (!ids.length) return [];

  const link = `/app/tickets/${ticket.id}`;
  const inserted = [];
  if (ticket.reporter_id && Number(ticket.reporter_id) !== Number(actorId)) {
    inserted.push(createNotification({ userId: ticket.reporter_id, ticketId: ticket.id, type, title: titleForReporter, body: `${ticket.ticket_number} · ${ticket.title}`, link }));
  }
  if (ticket.assigned_to_id && Number(ticket.assigned_to_id) !== Number(actorId)) {
    inserted.push(createNotification({ userId: ticket.assigned_to_id, ticketId: ticket.id, type, title: titleForAssignee, body: `${ticket.ticket_number} · ${ticket.title}`, link }));
  }
  return inserted;
}