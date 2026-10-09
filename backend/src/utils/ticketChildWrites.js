// Escrituras de las tablas hijas de tickets que cuelgan del padre: historial
// (ticket_history), comentarios (ticket_comments) y adjuntos
// (ticket_attachments).
//
// Motivo: el esquema MSSQL (src/db/mssql/schema.sql) declara organization_id
// NOT NULL en esas tablas, con clave foránea compuesta
// (organization_id, ticket_id) -> tickets(organization_id, id). El esquema
// SQLite (src/db.js) NO tiene esa columna en las tablas hijas: se aíslan a
// través de su padre. Por eso la sentencia se construye según el esquema
// ACTIVO: no se añade organization_id cuando el motor no la tiene.
//
// La organización no llega del cliente ni de un valor arbitrario: se lee del
// propio ticket en la misma base. Si el ticket no existe o no tiene
// organización, la escritura se rechaza antes de tocar la tabla (nunca se
// escribe NULL ni un valor inventado). Cuando el llamador ya conoce la
// organización del ticket puede pasarla como `organizationId`; el helper la
// contrasta con la del ticket y rechaza cualquier cruce entre organizaciones.
//
// La fábrica `createTicketChildWrites` permite inyectar el runtime y la
// detección de motor para probar el comportamiento MSSQL sin conectar a SQL
// Server.

import runtime, { currentEngine } from '../db/runtime.js';

export function createTicketChildWrites(rt = runtime, engine = currentEngine) {
  const writesOrganizationId = () => engine() === 'mssql';

  function assertSameOrganization(ticketId, ticketOrganizationId, declaredOrganizationId) {
    if (declaredOrganizationId === null || declaredOrganizationId === undefined) return;
    if (Number(declaredOrganizationId) !== Number(ticketOrganizationId)) {
      throw new Error(
        `La organización ${declaredOrganizationId} no corresponde al ticket ${ticketId} (pertenece a ${ticketOrganizationId}).`,
      );
    }
  }

  async function organizationIdForTicket(ticketId, declaredOrganizationId) {
    const row = await rt.queryOne('SELECT organization_id FROM tickets WHERE id = ?', ticketId);
    if (!row) {
      throw new Error(`No se puede escribir en una tabla hija: no existe el ticket ${ticketId}.`);
    }
    if (row.organization_id === null || row.organization_id === undefined) {
      throw new Error(`No se puede escribir en una tabla hija: el ticket ${ticketId} no tiene organización.`);
    }
    assertSameOrganization(ticketId, row.organization_id, declaredOrganizationId);
    return row.organization_id;
  }

  async function insertTicketHistory(
    ticketId,
    userId,
    action,
    description,
    oldValue = null,
    newValue = null,
    { organizationId } = {},
  ) {
    if (writesOrganizationId()) {
      const org = await organizationIdForTicket(ticketId, organizationId);
      return rt.execute(
        'INSERT INTO ticket_history (organization_id, ticket_id, user_id, action, description, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
        org, ticketId, userId, action, description, oldValue, newValue,
      );
    }
    return rt.execute(
      'INSERT INTO ticket_history (ticket_id, user_id, action, description, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      ticketId, userId, action, description, oldValue, newValue,
    );
  }

  async function insertTicketComment(ticketId, userId, message, isInternal = false, { organizationId } = {}) {
    if (writesOrganizationId()) {
      const org = await organizationIdForTicket(ticketId, organizationId);
      return rt.insertAndGetId(
        'INSERT INTO ticket_comments (organization_id, ticket_id, user_id, message, is_internal) VALUES (?, ?, ?, ?, ?)',
        org, ticketId, userId, message, isInternal ? 1 : 0,
      );
    }
    return rt.insertAndGetId(
      'INSERT INTO ticket_comments (ticket_id, user_id, message, is_internal) VALUES (?, ?, ?, ?)',
      ticketId, userId, message, isInternal ? 1 : 0,
    );
  }

  async function insertTicketAttachment(
    { ticketId, commentId = null, originalName, storedName, mimeType, sizeBytes, uploaderId },
    { organizationId } = {},
  ) {
    if (writesOrganizationId()) {
      const org = await organizationIdForTicket(ticketId, organizationId);
      return rt.insertAndGetId(
        'INSERT INTO ticket_attachments (organization_id, ticket_id, comment_id, original_name, stored_name, mime_type, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        org, ticketId, commentId, originalName, storedName, mimeType, sizeBytes, uploaderId,
      );
    }
    return rt.insertAndGetId(
      'INSERT INTO ticket_attachments (ticket_id, comment_id, original_name, stored_name, mime_type, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ticketId, commentId, originalName, storedName, mimeType, sizeBytes, uploaderId,
    );
  }

  return { organizationIdForTicket, insertTicketHistory, insertTicketComment, insertTicketAttachment };
}

const defaultWrites = createTicketChildWrites();

export const {
  organizationIdForTicket,
  insertTicketHistory,
  insertTicketComment,
  insertTicketAttachment,
} = defaultWrites;
