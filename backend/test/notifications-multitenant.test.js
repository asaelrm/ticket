// Notificaciones multiempresa: la organización se deriva en el SERVIDOR y la
// sentencia cambia según el esquema activo.
//
// El esquema MSSQL exige `organization_id` en `notifications` (FK compuesta con
// users y tickets); el esquema SQLite NO tiene esa columna. Estas pruebas
// comprueban, con un runtime real sobre un contrato FALSO (sin conexión):
//   - MSSQL incluye organization_id: del ticket cuando existe, del destinatario
//     cuando no, y NULL solo para un aviso global a un SUPERADMIN sin org;
//   - se rechaza/omite cualquier cruce de organización y cualquier NULL no
//     autorizado;
//   - SQLite conserva su sentencia e inserción anteriores (compatibilidad).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/db/runtime.js';
import { createNotificationService } from '../src/utils/notifications.js';

const MSSQL_INSERT = /INSERT INTO notifications \(organization_id, user_id, ticket_id, type, title, body, link\)/;
const SQLITE_INSERT = /INSERT INTO notifications \(user_id, ticket_id, type, title, body, link\)/;

// Runtime MSSQL real sobre un contrato falso: ejercita la traducción a T-SQL y
// la validación del número de parámetros sin abrir ninguna conexión.
function fakeMssqlRuntime(responses = {}) {
  const calls = { queryOne: [], insertAndGetId: [] };
  const contract = {
    async queryOne(sql, params) {
      calls.queryOne.push({ sql, params });
      if (/FROM users u, tickets t/.test(sql)) return responses.recipient ?? null;
      if (/FROM tickets WHERE id/.test(sql)) return responses.ticket ?? null;
      if (/FROM users u JOIN roles/.test(sql)) return responses.user ?? null;
      return null;
    },
    async queryMany() { return []; },
    async execute() { return { rowsAffected: 0 }; },
    async insertAndGetId(sql, params) { calls.insertAndGetId.push({ sql, params }); return { id: 77, rowsAffected: 1 }; },
    async transactionAsync(callback) { return callback(this); },
    async close() {},
  };
  const rt = createRuntime({ engine: 'mssql', contract });
  return { service: createNotificationService(rt, () => 'mssql'), calls };
}

// Runtime SQLite falso: no traduce ni consulta; solo registra.
function fakeSqliteRuntime(responses = {}) {
  const calls = { queryOne: [], insertAndGetId: [] };
  const rt = {
    async queryOne(sql, ...params) { calls.queryOne.push({ sql, params }); return responses.recipient ?? null; },
    async queryMany() { return []; },
    async execute() { return { rowsAffected: 0 }; },
    async insertAndGetId(sql, ...params) { calls.insertAndGetId.push({ sql, params }); return { id: 88, rowsAffected: 1 }; },
  };
  return { service: createNotificationService(rt, () => 'sqlite'), calls };
}

describe('notificaciones multiempresa (MSSQL)', () => {
  it('una notificación de ticket incluye organization_id tomada del ticket', async () => {
    const { service, calls } = fakeMssqlRuntime({
      recipient: { user_org: 7, ticket_org: 7 },
      ticket: { organization_id: 7 },
    });
    const id = await service.createNotification({ userId: 20, ticketId: 1, type: 'sla', title: 'Alerta', body: 'Vencido', link: '/app/tickets/1' });

    assert.equal(id, 77);
    assert.equal(calls.queryOne.length, 2, 'primero verifica el destinatario, luego lee el ticket');
    assert.equal(calls.queryOne[0].params.p0, 20);
    assert.equal(calls.queryOne[0].params.p1, 1);
    assert.equal(calls.insertAndGetId.length, 1);
    assert.match(calls.insertAndGetId[0].sql, MSSQL_INSERT);
    assert.deepEqual(calls.insertAndGetId[0].params, {
      p0: 7, p1: 20, p2: 1, p3: 'SLA', p4: 'Alerta', p5: 'Vencido', p6: '/app/tickets/1',
    });
  });

  it('rechaza un cruce entre organizaciones sin insertar nada', async () => {
    const { service, calls } = fakeMssqlRuntime({
      recipient: { user_org: 9, ticket_org: 7 },
    });
    const id = await service.createNotification({ userId: 21, ticketId: 1, type: 'SLA', title: 'Alerta' });

    assert.equal(id, null, 'el destinatario no pertenece a la organización del ticket');
    assert.equal(calls.insertAndGetId.length, 0, 'no se consulta el ticket ni se inserta');
  });

  it('una notificación sin ticket a un usuario de empresa usa la organización del destinatario', async () => {
    const { service, calls } = fakeMssqlRuntime({ user: { organization_id: 9, role_code: 'ADMIN' } });
    await service.createNotification({ userId: 21, type: 'SYSTEM', title: 'Aviso' });

    assert.match(calls.insertAndGetId[0].sql, MSSQL_INSERT);
    assert.equal(calls.insertAndGetId[0].params.p0, 9);
    assert.equal(calls.insertAndGetId[0].params.p2, null);
  });

  it('un aviso global a un SUPERADMIN sin organización inserta organization_id NULL', async () => {
    const { service, calls } = fakeMssqlRuntime({ user: { organization_id: null, role_code: 'SUPERADMIN' } });
    const id = await service.createNotification({ userId: 30, type: 'SYSTEM', title: 'Aviso global' });

    assert.equal(id, 77);
    assert.match(calls.insertAndGetId[0].sql, MSSQL_INSERT);
    assert.equal(calls.insertAndGetId[0].params.p0, null);
  });

  it('rechaza el NULL de un usuario sin organización que no es SUPERADMIN', async () => {
    const { service, calls } = fakeMssqlRuntime({ user: { organization_id: null, role_code: 'ADMIN' } });
    await assert.rejects(
      () => service.createNotification({ userId: 31, type: 'SYSTEM', title: 'Aviso' }),
      /el usuario 31 no tiene organización y no es un SUPERADMIN global/,
    );
    assert.equal(calls.insertAndGetId.length, 0);
  });

  it('rechaza organizationIdFor de un ticket sin organización', async () => {
    const { service, calls } = fakeMssqlRuntime({ ticket: { organization_id: null } });
    await assert.rejects(
      () => service.organizationIdFor({ userId: 20, ticketId: 1 }),
      /el ticket 1 no tiene organización/,
    );
    assert.equal(calls.insertAndGetId.length, 0);
  });

  it('rechaza organizationIdFor de un ticket inexistente', async () => {
    const { service } = fakeMssqlRuntime({ ticket: null });
    await assert.rejects(
      () => service.organizationIdFor({ userId: 20, ticketId: 404 }),
      /no existe el ticket 404/,
    );
  });
});

describe('notificaciones multiempresa (SQLite, compatibilidad)', () => {
  it('una notificación de ticket omite organization_id y conserva los parámetros', async () => {
    const { service, calls } = fakeSqliteRuntime({ recipient: { user_org: 7, ticket_org: 7 } });
    const id = await service.createNotification({ userId: 20, ticketId: 1, type: 'sla', title: 'Alerta', body: 'Vencido', link: '/app/tickets/1' });

    assert.equal(id, 88);
    assert.equal(calls.insertAndGetId.length, 1);
    assert.match(calls.insertAndGetId[0].sql, SQLITE_INSERT);
    assert.doesNotMatch(calls.insertAndGetId[0].sql, /organization_id/);
    assert.deepEqual(calls.insertAndGetId[0].params, [20, 1, 'SLA', 'Alerta', 'Vencido', '/app/tickets/1']);
  });

  it('una notificación sin ticket no consulta organización y omite la columna', async () => {
    const { service, calls } = fakeSqliteRuntime();
    await service.createNotification({ userId: 20, type: 'SYSTEM', title: 'Aviso' });

    assert.equal(calls.queryOne.length, 0, 'en SQLite no se resuelve la organización');
    assert.match(calls.insertAndGetId[0].sql, SQLITE_INSERT);
    assert.deepEqual(calls.insertAndGetId[0].params, [20, null, 'SYSTEM', 'Aviso', null, null]);
  });

  it('en SQLite un cruce de ticket sigue rechazándose por el guard existente', async () => {
    const { service, calls } = fakeSqliteRuntime({ recipient: { user_org: 9, ticket_org: 7 } });
    const id = await service.createNotification({ userId: 21, ticketId: 1, type: 'SLA', title: 'Alerta' });
    assert.equal(id, null);
    assert.equal(calls.insertAndGetId.length, 0);
  });
});
