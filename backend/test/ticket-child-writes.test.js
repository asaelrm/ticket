// Escrituras de tablas hijas de tickets según el esquema activo.
//
// El esquema MSSQL exige organization_id NOT NULL en ticket_history y
// ticket_comments (con FK compuesta (organization_id, ticket_id) -> tickets).
// El esquema SQLite NO tiene esa columna. Estas pruebas comprueban que:
//   - en MSSQL la sentencia incluye organization_id tomado del ticket real;
//   - en SQLite la sentencia NO incluye organization_id (columna inexistente) y
//     no se consulta siquiera el ticket;
//   - la organización se rechaza/valida: ticket inexistente, ticket sin
//     organización y cruce entre organizaciones fallan antes de escribir.
//
// El caso MSSQL usa un runtime real creado con `createRuntime` y un contrato
// FALSO: se ejerce la traducción a T-SQL y la validación del número de
// parámetros, sin abrir ninguna conexión de SQL Server.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/db/runtime.js';
import { createTicketChildWrites } from '../src/utils/ticketChildWrites.js';

const MSSQL_HISTORY = /INSERT INTO ticket_history \(organization_id, ticket_id, user_id, action, description, old_value, new_value\)/;
const MSSQL_COMMENT = /INSERT INTO ticket_comments \(organization_id, ticket_id, user_id, message, is_internal\)/;
const MSSQL_ATTACHMENT = /INSERT INTO ticket_attachments \(organization_id, ticket_id, comment_id, original_name, stored_name, mime_type, size_bytes, uploader_id\)/;
const SQLITE_HISTORY = /INSERT INTO ticket_history \(ticket_id, user_id, action, description, old_value, new_value\)/;
const SQLITE_COMMENT = /INSERT INTO ticket_comments \(ticket_id, user_id, message, is_internal\)/;
const SQLITE_ATTACHMENT = /INSERT INTO ticket_attachments \(ticket_id, comment_id, original_name, stored_name, mime_type, size_bytes, uploader_id\)/;

// Runtime SQLite falso: no traduce, solo registra.
function fakeSqliteRuntime({ ticket }) {
  const calls = { queryOne: [], execute: [], insertAndGetId: [] };
  const rt = {
    async queryOne(sql, ...params) { calls.queryOne.push({ sql, params }); return ticket; },
    async queryMany() { return []; },
    async execute(sql, ...params) { calls.execute.push({ sql, params }); return { rowsAffected: 1 }; },
    async insertAndGetId(sql, ...params) { calls.insertAndGetId.push({ sql, params }); return { id: 99, rowsAffected: 1 }; },
  };
  return { writes: createTicketChildWrites(rt, () => 'sqlite'), calls };
}

// Runtime MSSQL real sobre un contrato falso (sin conexión).
function fakeMssqlRuntime({ ticket = { id: 10, organization_id: 7 } } = {}) {
  const calls = { queryOne: [], execute: [], insertAndGetId: [] };
  const contract = {
    async queryOne(sql, params) { calls.queryOne.push({ sql, params }); return ticket; },
    async queryMany() { return []; },
    async execute(sql, params) { calls.execute.push({ sql, params }); return { rowsAffected: 1 }; },
    async insertAndGetId(sql, params) { calls.insertAndGetId.push({ sql, params }); return { id: 99, rowsAffected: 1 }; },
    async transactionAsync(cb) { return cb(this); },
    async close() {},
  };
  const rt = createRuntime({ engine: 'mssql', contract });
  return { writes: createTicketChildWrites(rt, () => 'mssql'), calls };
}

describe('tablas hijas de tickets: organization_id según el esquema activo', () => {
  it('MSSQL: el historial incluye organization_id leído del ticket real', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketHistory(10, 3, 'CREATED', 'Ticket creado', null, null);

    assert.equal(calls.queryOne.length, 1, 'se resuelve la organización desde el ticket');
    assert.match(calls.queryOne[0].sql, /SELECT organization_id FROM tickets WHERE id = /);
    assert.equal(calls.queryOne[0].params.p0, 10);

    assert.equal(calls.execute.length, 1);
    assert.match(calls.execute[0].sql, MSSQL_HISTORY);
    assert.deepEqual(calls.execute[0].params, {
      p0: 7, p1: 10, p2: 3, p3: 'CREATED', p4: 'Ticket creado', p5: null, p6: null,
    });
  });

  it('MSSQL: el comentario incluye organization_id leído del ticket real', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketComment(10, 3, 'Nota interna', true);

    assert.equal(calls.queryOne.length, 1);
    assert.equal(calls.insertAndGetId.length, 1);
    assert.match(calls.insertAndGetId[0].sql, MSSQL_COMMENT);
    assert.deepEqual(calls.insertAndGetId[0].params, {
      p0: 7, p1: 10, p2: 3, p3: 'Nota interna', p4: 1,
    });
  });

  it('MSSQL: el historial de sistema (sin usuario) también lleva organization_id', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 42, organization_id: 5 } });
    await writes.insertTicketHistory(42, null, 'ESCALATED', 'Escalación', 'LOW', 'HIGH', { organizationId: 5 });

    assert.deepEqual(calls.execute[0].params, {
      p0: 5, p1: 42, p2: null, p3: 'ESCALATED', p4: 'Escalación', p5: 'LOW', p6: 'HIGH',
    });
  });

  it('SQLite: el historial omite organization_id y no consulta el ticket', async () => {
    const { writes, calls } = fakeSqliteRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketHistory(10, 3, 'CREATED', 'Ticket creado');

    assert.equal(calls.queryOne.length, 0, 'en SQLite no hace falta resolver la organización');
    assert.equal(calls.execute.length, 1);
    assert.match(calls.execute[0].sql, SQLITE_HISTORY);
    assert.doesNotMatch(calls.execute[0].sql, /organization_id/);
    assert.deepEqual(calls.execute[0].params, [10, 3, 'CREATED', 'Ticket creado', null, null]);
  });

  it('SQLite: el comentario omite organization_id y no consulta el ticket', async () => {
    const { writes, calls } = fakeSqliteRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketComment(10, 3, 'Comentario', false);

    assert.equal(calls.queryOne.length, 0);
    assert.match(calls.insertAndGetId[0].sql, SQLITE_COMMENT);
    assert.doesNotMatch(calls.insertAndGetId[0].sql, /organization_id/);
    assert.deepEqual(calls.insertAndGetId[0].params, [10, 3, 'Comentario', 0]);
  });

  it('rechaza el historial de un ticket inexistente sin escribir nada', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: null });
    await assert.rejects(
      () => writes.insertTicketHistory(10, 3, 'X', 'desc'),
      /no existe el ticket 10/,
    );
    assert.equal(calls.execute.length, 0, 'no debe insertarse ninguna fila');
  });

  it('rechaza el comentario de un ticket sin organización sin escribir nada', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: null } });
    await assert.rejects(
      () => writes.insertTicketComment(10, 3, 'X', false),
      /el ticket 10 no tiene organización/,
    );
    assert.equal(calls.insertAndGetId.length, 0);
  });

  it('rechaza un cruce de organización en el historial (organization_id ajeno)', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await assert.rejects(
      () => writes.insertTicketHistory(10, 3, 'X', 'desc', null, null, { organizationId: 8 }),
      /La organización 8 no corresponde al ticket 10 \(pertenece a 7\)/,
    );
    assert.equal(calls.execute.length, 0, 'el cruce se rechaza ANTES de insertar');
  });

  it('rechaza un cruce de organización en el comentario (organization_id ajeno)', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await assert.rejects(
      () => writes.insertTicketComment(10, 3, 'X', false, { organizationId: 8 }),
      /La organización 8 no corresponde al ticket 10 \(pertenece a 7\)/,
    );
    assert.equal(calls.insertAndGetId.length, 0);
  });

  it('acepta la organización declarada cuando coincide con la del ticket', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketComment(10, 3, 'X', false, { organizationId: 7 });
    assert.equal(calls.insertAndGetId.length, 1);
  });
});

describe('adjuntos de ticket: organization_id según el esquema activo', () => {
  const attachment = {
    ticketId: 10,
    commentId: 4,
    originalName: 'evidencia.txt',
    storedName: 'abc123.txt',
    mimeType: 'text/plain',
    sizeBytes: 42,
    uploaderId: 3,
  };

  it('MSSQL: el adjunto incluye organization_id leído del ticket real', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketAttachment(attachment);

    assert.equal(calls.queryOne.length, 1);
    assert.equal(calls.queryOne[0].params.p0, 10);
    assert.equal(calls.insertAndGetId.length, 1);
    assert.match(calls.insertAndGetId[0].sql, MSSQL_ATTACHMENT);
    assert.deepEqual(calls.insertAndGetId[0].params, {
      p0: 7, p1: 10, p2: 4, p3: 'evidencia.txt', p4: 'abc123.txt', p5: 'text/plain', p6: 42, p7: 3,
    });
  });

  it('MSSQL: admite adjunto sin comentario (comment_id NULL)', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketAttachment({ ...attachment, commentId: null });
    assert.equal(calls.insertAndGetId[0].params.p2, null);
    assert.equal(calls.insertAndGetId[0].params.p0, 7);
  });

  it('SQLite: el adjunto omite organization_id y no consulta el ticket', async () => {
    const { writes, calls } = fakeSqliteRuntime({ ticket: { id: 10, organization_id: 7 } });
    await writes.insertTicketAttachment(attachment);

    assert.equal(calls.queryOne.length, 0, 'en SQLite no hace falta resolver la organización');
    assert.equal(calls.insertAndGetId.length, 1);
    assert.match(calls.insertAndGetId[0].sql, SQLITE_ATTACHMENT);
    assert.doesNotMatch(calls.insertAndGetId[0].sql, /organization_id/);
    assert.deepEqual(calls.insertAndGetId[0].params, [10, 4, 'evidencia.txt', 'abc123.txt', 'text/plain', 42, 3]);
  });

  it('rechaza el adjunto de un ticket inexistente sin escribir nada', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: null });
    await assert.rejects(
      () => writes.insertTicketAttachment(attachment),
      /no existe el ticket 10/,
    );
    assert.equal(calls.insertAndGetId.length, 0);
  });

  it('rechaza un cruce de organización en el adjunto (organization_id ajeno)', async () => {
    const { writes, calls } = fakeMssqlRuntime({ ticket: { id: 10, organization_id: 7 } });
    await assert.rejects(
      () => writes.insertTicketAttachment(attachment, { organizationId: 8 }),
      /La organización 8 no corresponde al ticket 10 \(pertenece a 7\)/,
    );
    assert.equal(calls.insertAndGetId.length, 0, 'el cruce se rechaza ANTES de insertar');
  });
});
