import test from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import {
  COLUMNS, EMPTY_TARGET_ERROR, TABLES, assertAllowedColumns, buildManifest, legacyOrganizationPlan,
  sanitizeManifest, summarizeValidationErrors,
} from '../scripts/migration/sqlite-to-mssql.js';
import {
  MIGRATION_APPLOCK, appLockStatement, createMssqlDriver, identityInsertStatement, insertStatement,
  organizationInsertStatement, runApply, targetEmptyStatement,
} from '../scripts/migration/mssql-apply.js';
import { legacySource, mixedSource } from './fixtures/migration-sources.mjs';

const planFor = (source, code = 'CMUCE') => legacyOrganizationPlan(source, { code, name: 'Centro Médico UCE' });

// Doble mínimo de la API de node-mssql: registra cada sentencia y devuelve las
// respuestas que el driver real espera del servidor.
function fakeMssql({ lockResult = 0, totalRows = 0, organizationId = 42, failInsertTable = null, failIdentityOffTable = null } = {}) {
  const state = { queries: [], batches: [], begun: 0, committed: 0, rolledBack: 0, sessions: new Set(), directRequestCalls: 0 };
  class FakeRequest {
    constructor(scope) { this.transaction = scope; this.session = scope?.session; this.values = {}; }
    input(name, value) { this.values[name] = value; return this; }
    async batch(text) { state.batches.push({ text, session: this.session }); return this.query(text); }
    async query(text) {
      state.queries.push({ text, values: { ...this.values }, inTransaction: Boolean(this.transaction), session: this.session });
      if (this.session) state.sessions.add(this.session);
      if (text.includes('sp_getapplock')) return { recordset: [{ lock_result: lockResult }] };
      if (text.includes('@@SPID')) return { recordset: [{ spid: 712 }] };
      if (text.includes('COUNT(*)')) return { recordset: [{ count: totalRows }] };
      if (text.includes('OUTPUT INSERTED.id')) return { recordset: [{ id: organizationId }] };
      const table = /^INSERT dbo\.(\w+)/.exec(text)?.[1] || null;
      if (table && table === failInsertTable) throw new Error(`fallo primario en ${table}`);
      const identityOff = /^SET IDENTITY_INSERT dbo\.(\w+) OFF$/.exec(text)?.[1] || null;
      if (identityOff && identityOff === failIdentityOffTable) throw new Error(`fallo de limpieza en ${identityOff}`);
      return { recordset: [] };
    }
  }
  class FakeTransaction {
    constructor() { this.session = Symbol('pinned-session'); }
    async begin() { state.begun += 1; }
    async commit() { state.committed += 1; }
    async rollback() { state.rolledBack += 1; }
    request() { return new FakeRequest(this); }
  }
  class ForbiddenDirectRequest {
    constructor() { state.directRequestCalls += 1; throw new Error('el driver debe usar transaction.request()'); }
  }
  return { state, sql: { Request: ForbiddenDirectRequest, Transaction: FakeTransaction } };
}

async function applyWithFakeMssql(options, source = legacySource()) {
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const fake = fakeMssql(options);
  const error = await runApply({ source, legacyOrganization: plan, manifest, driver: createMssqlDriver(fake.sql, {}) }).then(() => null, (thrown) => thrown);
  return { ...fake, plan, manifest, error };
}

test('M5 las sentencias SQL solo usan identificadores de la allowlist COLUMNS', () => {
  assert.equal(insertStatement('tickets', ['id', 'title']), 'INSERT dbo.tickets ([id], [title]) VALUES (@id, @title)');
  assert.throws(() => insertStatement('tickets', ['title', 'bogus_column']), /columna bogus_column no existe en el esquema destino/);
  assert.throws(() => insertStatement('tickets', ['title]; DROP TABLE users;--']), /columna|tabla/);
  assert.throws(() => insertStatement('tickets_backup', ['id']), /tabla tickets_backup no existe en el esquema destino/);
  assert.throws(() => insertStatement('tickets', []), /al menos una columna/);
  assert.throws(() => assertAllowedColumns('sequences', ['name', 'value', 'extra']), /columna extra/);
  assert.equal(identityInsertStatement('users', true), 'SET IDENTITY_INSERT dbo.users ON');
  assert.equal(identityInsertStatement('users', false), 'SET IDENTITY_INSERT dbo.users OFF');
  assert.throws(() => identityInsertStatement('users_extra', true), /no existe en el esquema destino/);
  assert.equal(organizationInsertStatement(), 'INSERT dbo.organizations ([code], [name], [active], [created_at]) OUTPUT INSERTED.id VALUES (@code, @name, @active, @created_at)');
});

test('M5 el chequeo de destino vacío cubre las 24 tablas, sessions incluida', () => {
  const statement = targetEmptyStatement();
  assert.equal((statement.match(/COUNT\(\*\)/g) || []).length, TABLES.length, 'un recuento por tabla');
  assert.equal(TABLES.length, 24);
  for (const table of TABLES) assert.ok(statement.includes(`FROM dbo.${table}`), `falta dbo.${table}`);
  assert.ok(statement.includes('FROM dbo.sessions'), 'sessions también debe estar vacía');
  assert.throws(() => targetEmptyStatement([]), /requiere la lista/);
  assert.throws(() => targetEmptyStatement(['unknown_table']), /no existe en el esquema destino/);
});

test('M5 el bloqueo de migración se toma con sp_getapplock en dueño de transacción', () => {
  const lock = appLockStatement();
  assert.ok(lock.includes('sp_getapplock'));
  assert.ok(lock.includes(`N'${MIGRATION_APPLOCK}'`));
  assert.ok(lock.includes("LockOwner = 'Transaction'"));
  assert.ok(lock.includes('LockTimeout'));
  assert.ok(lock.includes('SELECT @lock_result'));
});

test('M5 el driver real emite bloqueo, recuento, IDENTITY emparejado y parámetros permitidos', async () => {
  const { state, error } = await applyWithFakeMssql({});
  assert.equal(error, null, error?.message);
  assert.equal(state.begun, 1);
  assert.equal(state.committed, 1, 'commit');
  assert.equal(state.rolledBack, 0, 'sin rollback');
  assert.match(state.queries[0].text, /sp_getapplock/, 'primer paso: bloqueo');
  assert.match(state.queries[1].text, /COUNT\(\*\)/, 'segundo paso: destino vacío dentro de la transacción');
  assert.equal(state.queries.every((query) => query.inTransaction), true, 'todas las sentencias van en la transacción');
  assert.equal(state.sessions.size, 1, 'ON, INSERT y OFF comparten una sola sesión física retenida por la transacción');
  assert.equal(state.directRequestCalls, 0, 'no se construyen Request sueltos fuera de transaction.request()');
  const identityBatches = state.batches.filter(({ text }) => text.startsWith('SET IDENTITY_INSERT'));
  assert.ok(identityBatches.length > 0, 'IDENTITY_INSERT se emite por batch(), fuera del alcance de sp_executesql');
  assert.equal(identityBatches.every(({ session }) => session === [...state.sessions][0]), true, 'los batches de identidad usan la sesión retenida');

  const inserts = state.queries.filter((query) => query.text.startsWith('INSERT'));
  assert.ok(inserts.length > 0);
  for (const { text, values } of inserts) {
    const table = /^INSERT dbo\.(\w+)/.exec(text)[1];
    const columns = [...text.matchAll(/\[([a-z0-9_]+)\]/g)].map((match) => match[1]);
    assert.doesNotThrow(() => assertAllowedColumns(table, columns), text);
    for (const column of columns) assert.ok(Object.hasOwn(values, column), `${table}.${column} sin parámetro`);
    for (const name of Object.keys(values)) assert.ok(COLUMNS[table].includes(name), `${name} fuera de allowlist en ${table}`);
  }

  const toggles = new Map();
  for (const { text } of state.queries) {
    const match = /^SET IDENTITY_INSERT dbo\.(\w+) (ON|OFF)$/.exec(text);
    if (!match) continue;
    toggles.set(match[1], (toggles.get(match[1]) || 0) + (match[2] === 'ON' ? 1 : -1));
  }
  assert.deepEqual([...toggles.values()].filter((balance) => balance !== 0), [], 'cada IDENTITY_INSERT ON tiene su OFF');
  assert.equal(toggles.has('sessions'), false, 'sessions ni se inserta ni se toca');
  assert.ok(state.queries.some((query) => /OUTPUT INSERTED\.id/.test(query.text)), 'la organización legacy se crea leyendo el ID real');
});

test('M5 usa la API real node-mssql Transaction.request para fijar la sesión', () => {
  // No abre red ni base: verifica directamente el contrato del driver instalado.
  const transaction = new sql.Transaction({});
  const first = transaction.request();
  const second = transaction.request();
  assert.equal(first.parent, transaction);
  assert.equal(second.parent, transaction);
  assert.notEqual(first, second, 'cada sentencia puede tener su Request, pero ambos pertenecen a la misma Transaction');
});

test('M5 diagnóstico opt-in prueba ON, INSERT y OFF de roles en el mismo SPID sin exponer filas', async () => {
  const source = legacySource();
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const fake = fakeMssql();
  const events = [];
  await runApply({
    source,
    legacyOrganization: plan,
    manifest,
    driver: createMssqlDriver(fake.sql, {}, { onDiagnostic: (event) => events.push(event) }),
  });
  const roles = events.filter((event) => event.table === 'roles');
  assert.deepEqual(roles.map((event) => event.stage), ['identity_on:before', 'identity_on:after', 'insert:before', 'insert:after', 'identity_off:before', 'identity_off:after']);
  assert.deepEqual(new Set(roles.map((event) => event.spid)), new Set([712]));
  assert.equal(Object.keys(roles[0]).sort().join(','), 'spid,stage,table', 'el diagnóstico no incluye valores de filas');
});

test('M5 el driver real se niega si el destino no está vacío y no escribe nada', async () => {
  const { state, error } = await applyWithFakeMssql({ totalRows: 2 });
  assert.ok(error instanceof Error);
  assert.equal(error.message, EMPTY_TARGET_ERROR);
  assert.equal(state.committed, 0);
  assert.equal(state.rolledBack, 1, 'rollback');
  assert.equal(state.queries.some((query) => query.text.startsWith('INSERT')), false, 'ningún INSERT');
  assert.equal(state.queries.length, 2, 'solo bloqueo y recuento');
});

test('M5 el driver real revierte si el bloqueo de migración no se concede', async () => {
  const { state, error } = await applyWithFakeMssql({ lockResult: -1 });
  assert.ok(error instanceof Error);
  assert.match(error.message, /bloqueo de migración/);
  assert.equal(state.committed, 0);
  assert.equal(state.rolledBack, 1);
  assert.equal(state.queries.length, 1, 'se corta antes del recuento');
});

test('M5 preserva el error primario si también falla IDENTITY_INSERT OFF', async () => {
  const { state, error } = await applyWithFakeMssql({ failInsertTable: 'roles', failIdentityOffTable: 'roles' });
  assert.ok(error instanceof Error);
  assert.match(error.message, /fallo primario en roles/);
  assert.match(error.identityInsertCleanupError?.message || '', /fallo de limpieza en roles/);
  assert.equal(state.rolledBack, 1);
  assert.equal(state.committed, 0);
});

test('M5 el manifest solo publica campos de la allowlist y enmascara nombres sensibles', () => {
  const source = mixedSource();
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  manifest.debug = { password_hash: 'no-debe-salir' };
  manifest.tables.tickets.row_sample = { title: 'dato del origen' };
  const safe = sanitizeManifest(manifest);
  assert.equal(Object.hasOwn(safe, 'debug'), false, 'campo desconocido eliminado');
  assert.equal(Object.hasOwn(safe.tables.tickets, 'row_sample'), false, 'las filas nunca salen en el manifest');
  const text = JSON.stringify(safe);
  assert.equal(text.includes('password_hash'), false);
  assert.equal(text.includes('no-debe-salir'), false);
  assert.deepEqual(Object.keys(safe).sort(), ['legacy_organization', 'source_fingerprint', 'started_at', 'tables', 'target']);
  assert.deepEqual(Object.keys(safe.tables.tickets).sort(), ['error_count', 'inserted_count', 'planned_insert_count', 'skipped_count', 'source_count']);
  assert.equal(safe.legacy_organization.organization_action, 'create');
  assert.deepEqual(Object.keys(safe.legacy_organization).sort(), ['associated_records', 'legacy_org_code', 'organization_action', 'planned_creation', 'planned_organization_row', 'reused_organization_id', 'sequence_reconciliation']);

  const summary = summarizeValidationErrors([{ table: 'users', id: 1, error: 'users#1: columna password_reset_token no permitida' }]);
  const key = Object.keys(summary)[0];
  assert.equal(key.includes('token'), false, `el resumen enmascara nombres sensibles: ${key}`);
  assert.ok(key.includes('***'));
});

test('M5 el manifest del snapshot mixto declara reutilización y no creación', () => {
  const source = mixedSource();
  source.organizations.push({ id: 7, code: 'CMUCE', name: 'Centro Médico UCE', active: 1, created_at: '2026-01-05T10:00:00.000Z' });
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, planFor(source));
  assert.equal(manifest.legacy_organization.organization_action, 'reuse');
  assert.equal(manifest.legacy_organization.planned_creation, false);
  assert.equal(manifest.legacy_organization.reused_organization_id, 7);
  assert.equal(manifest.legacy_organization.planned_organization_row, null);
  assert.equal(manifest.tables.organizations.planned_insert_count, 3, 'las tres organizaciones del origen, sin crear otra');
});
