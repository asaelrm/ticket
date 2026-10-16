import db, { currentEngine } from '../db/runtime.js';
import { EventEmitter } from 'node:events';
import { SUPERADMIN_ROLE_CODE } from '../orgPolicy.js';

export const notificationEvents = new EventEmitter();

// Notificaciones in-app: se muestran en la campana del header. No son correos,
// solo eventos internos del sistema (asignación, comentarios, cierre, etc.).
//
// ETAPA 3 (defensa central): antes de crear una notificación ligada a un
// ticket, el destinatario debe pertenecer a la MISMA organización del ticket.
// Es la red de seguridad que cubre cualquier flujo (normal, jobs o datos
// legacy corruptos): si el usuario no existe, no tiene org o la org no
// coincide, la notificación no se crea. Las notificaciones de sistema o no
// ligadas a tickets (password reset, avisos globales) pasan ticketId = null.
//
// MULTIEMPRESA (MSSQL): el esquema destino exige `organization_id` en
// `notifications`, con FK compuesta (organization_id, user_id) -> users y
// (organization_id, ticket_id) -> tickets. La organización NUNCA llega del
// cliente: se deriva en el servidor. Con ticket, manda la organización del
// ticket; sin ticket, la del destinatario. `NULL` queda reservado para un aviso
// global legítimo dirigido a un SUPERADMIN sin organización. SQLite no tiene la
// columna y conserva su comportamiento anterior.
//
// El servicio se construye con una fábrica para inyectar el runtime y la
// detección de motor en las pruebas (contrato MSSQL falso, sin conexión real).
const RECIPIENT_IN_TICKET_ORG = `SELECT u.organization_id AS user_org, t.organization_id AS ticket_org
     FROM users u, tickets t WHERE u.id = ? AND t.id = ?`;

export function createNotificationService(rt = db, engine = currentEngine) {
  const writesOrganizationId = () => engine() === 'mssql';

  async function recipientInTicketOrg(userId, ticketId) {
    const row = await rt.queryOne(RECIPIENT_IN_TICKET_ORG, userId, ticketId);
    if (!row || row.user_org == null || row.ticket_org == null) return false;
    return Number(row.user_org) === Number(row.ticket_org);
  }

  // Organización del servidor para una notificación. Rechaza cualquier estado
  // que no permita decidir una organización legítima.
  async function organizationIdFor({ userId, ticketId }) {
    if (ticketId != null) {
      const ticket = await rt.queryOne('SELECT organization_id FROM tickets WHERE id = ?', ticketId);
      if (!ticket) throw new Error(`No se puede notificar: no existe el ticket ${ticketId}.`);
      if (ticket.organization_id == null) throw new Error(`No se puede notificar: el ticket ${ticketId} no tiene organización.`);
      return ticket.organization_id;
    }
    const user = await rt.queryOne(
      `SELECT u.organization_id AS organization_id, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      userId,
    );
    if (!user) throw new Error(`No se puede notificar: no existe el usuario ${userId}.`);
    if (user.organization_id != null) return user.organization_id;
    if (user.role_code === SUPERADMIN_ROLE_CODE) return null;
    throw new Error(`No se puede notificar: el usuario ${userId} no tiene organización y no es un SUPERADMIN global.`);
  }

  async function createNotification({ userId, ticketId = null, type, title, body = null, link = null }) {
    if (!userId) return null;
    if (ticketId != null && !(await recipientInTicketOrg(userId, ticketId))) return null;

    let info;
    if (writesOrganizationId()) {
      const organizationId = await organizationIdFor({ userId, ticketId });
      info = await rt.insertAndGetId(
        'INSERT INTO notifications (organization_id, user_id, ticket_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)',
        organizationId,
        userId,
        ticketId,
        String(type).toUpperCase(),
        String(title).slice(0, 200),
        body ? String(body).slice(0, 500) : null,
        link || null,
      );
    } else {
      info = await rt.insertAndGetId(
        'INSERT INTO notifications (user_id, ticket_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)',
        userId,
        ticketId,
        String(type).toUpperCase(),
        String(title).slice(0, 200),
        body ? String(body).slice(0, 500) : null,
        link || null,
      );
    }

    const notificationId = info.id;
    notificationEvents.emit('new_notification', { id: notificationId, userId, ticketId, type, title, body, link });
    return notificationId;
  }

  return { createNotification, recipientInTicketOrg, organizationIdFor };
}

const defaultService = createNotificationService();

export const createNotification = defaultService.createNotification;

export async function createNotifications({ userIds = [], ...rest }) {
  const ids = [...new Set(userIds.map((u) => Number(u)).filter(Boolean))];
  const inserted = [];
  for (const id of ids) {
    const nid = await createNotification({ ...rest, userId: id });
    if (nid) inserted.push(nid);
  }
  return inserted;
}

// ETAPA 3 / V3: alcance de una alerta con contexto de ticket.
//
// Cuando la alerta lleva `ticketId`, la organización que manda es SIEMPRE la
// del ticket (dato de servidor), no la que el llamante pudiera pasar. Devuelve
//   { scope: null }   → sin ámbito: no se notifica a nadie
//   { scope: orgId }   → administradores/técnicos SOLO de esa organización
//
// Dos casos quedan cubiertos aquí, en la entrada, y no en cada llamante:
//   - ticket legacy con organization_id NULL: no hay forma segura de decidir a
//     qué empresa pertenece, así que no se lanza la consulta global contra los
//     administradores de TODAS las organizaciones (evita el "broadcast" que
//     exige la regla V3.7).
//   - ticket inexistente: nada que notificar.
// Una alerta SIN ticket (aviso global del sistema) conserva el `organizationId`
// del llamante y, si tampoco lo lleva, el comportamiento histórico: todos los
// administradores activos.
async function notificationScope({ ticketId, organizationId }) {
  if (ticketId == null) return { scope: organizationId ?? null, global: organizationId == null };
  const row = await db.queryOne('SELECT organization_id FROM tickets WHERE id = ?', ticketId);
  if (!row) return { scope: null, global: false };
  if (row.organization_id == null) return { scope: null, global: false };
  return { scope: row.organization_id, global: false };
}

// Notifica a todos los administradores activos (para alertas del sistema).
// ETAPA 3: cuando la alerta tiene contexto de organización, el aviso solo
// alcanza a administradores de ESA organización.
export async function notifyAdmins({ type, title, body = null, ticketId = null, link = null, organizationId = null }) {
  const { scope, global } = await notificationScope({ ticketId, organizationId });
  if (scope === null && !global) return [];
  let sql = `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.active = 1 AND p.code = 'settings.manage'`;
  const params = [];
  if (scope != null) {
    sql += ` AND u.organization_id = ?`;
    params.push(scope);
  }
  const admins = await db.queryMany(sql, ...params);
  return createNotifications({ userIds: admins.map((a) => a.id), type, title, body, ticketId, link });
}

// Notifica a técnicos/soporte (quienes pueden ver todos los tickets).
// ETAPA 3: mismo criterio que notifyAdmins. Los avisos de ticket (NEW_TICKET,
// SLAs, etc.) pasan `organizationId: ticket.organization_id` y solo llegan a
// personal de la MISMA org; una alerta global sin contexto conserva todos los
// técnicos activos.
export async function notifyStaff({ type, title, body = null, ticketId = null, excludeUserId = null, link = null, organizationId = null }) {
  const { scope, global } = await notificationScope({ ticketId, organizationId });
  if (scope === null && !global) return [];
  let sql = `SELECT u.id FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE u.active = 1 AND p.code = 'ticket.view.all'`;
  const params = [];
  if (scope != null) {
    sql += ` AND u.organization_id = ?`;
    params.push(scope);
  }
  const staff = await db.queryMany(sql, ...params);
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
export async function notifyTicketParticipants(ticket, { type, actorId, titleForReporter, titleForAssignee }) {
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
  const created = [];
  for (const t of targets) {
    const nid = await createNotification({
      userId: t.userId,
      ticketId: ticket.id,
      type,
      title: t.title,
      body: `${ticket.ticket_number} · ${ticket.title}`,
      link,
    });
    created.push(nid);
  }
  return created;
}
