import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS, EMPTY_TARGET_ERROR, IDENTITY_TABLES, LEGACY_SEQUENCE_NAME, SKIPPED_TABLES, TABLES,
  assertAllowedColumns, buildManifest, legacyOrganizationPlan, validateSource,
} from '../scripts/migration/sqlite-to-mssql.js';
import { runApply } from '../scripts/migration/mssql-apply.js';
import { STAMP, legacySource, mixedSource } from './fixtures/migration-sources.mjs';

// Doble de destino en memoria: implementa el mismo puerto semántico que el
// driver real y falla si el código de apply rompe sus invariantes (IDENTITY
// apagado, columna fuera de allowlist, tablas que no deben escribirse).
function fakeDriver({ totalRows = 0, failOn = null } = {}) {
  const state = { log: [], tables: {}, identity: {}, committed: false, rolledBack: false, totalRows, failOn };
  const nextId = (table) => Math.max(0, ...(state.tables[table] || []).map((row) => Number(row.id) || 0)) + 1;
  const driver = {
    state,
    async begin() { state.log.push('begin'); },
    async lockAndAssertTargetEmpty() {
      state.log.push('lock');
      if (state.totalRows !== 0) throw new Error(EMPTY_TARGET_ERROR);
      state.log.push('empty-check');
    },
    async setIdentityInsert(table, enabled) { state.identity[table] = enabled; state.log.push(`identity:${table}:${enabled ? 'ON' : 'OFF'}`); },
    async insertRow(table, columns, data) {
      assertAllowedColumns(table, columns);
      if (state.failOn === table) throw new Error(`fallo forzado en ${table}`);
      if (IDENTITY_TABLES.has(table)) {
        if (!state.identity[table]) throw new Error(`${table}: INSERT con IDENTITY_INSERT apagado`);
        if (!Number.isSafeInteger(data.id)) throw new Error(`${table}: fila sin id explícito`);
      }
      (state.tables[table] ||= []).push({ ...data });
      state.log.push(`insert:${table}`);
    },
    async insertOrganization(row) {
      const id = nextId('organizations');
      (state.tables.organizations ||= []).push({ id, ...row });
      state.log.push(`create-organization:${id}`);
      return id;
    },
    async commit() { state.committed = true; state.log.push('commit'); },
    async rollback() { state.rolledBack = true; state.log.push('rollback'); },
  };
  return driver;
}

function assertIdentityBalanced(log) {
  const open = [];
  for (const entry of log) {
    const match = /^identity:(.+):(ON|OFF)$/.exec(entry);
    if (!match) continue;
    if (match[2] === 'ON') {
      assert.equal(open.includes(match[1]), false, `IDENTITY_INSERT de ${match[1]} ya estaba activo`);
      open.push(match[1]);
    } else {
      const index = open.indexOf(match[1]);
      assert.notEqual(index, -1, `IDENTITY_INSERT de ${match[1]} se apaga sin haberse encendido`);
      open.splice(index, 1);
    }
  }
  assert.deepEqual(open, [], 'IDENTITY_INSERT quedó activo');
}

const planFor = (source, code = 'CMUCE') => legacyOrganizationPlan(source, { code, name: 'Centro Médico UCE' });

test('M5 apply completo con doble falso: lock, IDs reales, secuencia y commit', async () => {
  const source = legacySource();
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver();
  const result = await runApply({ source, legacyOrganization: plan, manifest, driver });

  assert.equal(driver.state.committed, true, 'commit');
  assert.equal(driver.state.rolledBack, false, 'sin rollback');
  assertIdentityBalanced(driver.state.log);
  const log = driver.state.log;
  assert.ok(log.indexOf('lock') < log.findIndex((entry) => entry.startsWith('insert:')), 'el chequeo de vacuidad va antes de escribir');
  assert.equal(driver.state.tables.sessions, undefined, 'sessions no se migra');
  assert.equal(driver.state.tables.organizations.length, 1, 'solo la organización legacy');
  assert.equal(driver.state.tables.organizations[0].code, 'CMUCE');
  const organizationId = driver.state.tables.organizations[0].id;
  assert.equal(organizationId, 1);
  assert.equal(driver.state.tables.tickets[0].organization_id, organizationId, 'los tickets usan el ID real');
  assert.deepEqual(driver.state.tables.sequences, [{ name: `${LEGACY_SEQUENCE_NAME}:${organizationId}`, value: 14 }], 'secuencia por organización, sin fila global');
  assert.equal(manifest.tables.tickets.inserted_count, 2);
  assert.equal(manifest.tables.sessions.inserted_count, 0);
  assert.equal(manifest.tables.organizations.inserted_count, 1);
  assert.equal(manifest.legacy_organization.resolved_organization_id, organizationId);
  assert.equal(result.legacyOrganization.resolvedId, organizationId);
  assert.deepEqual(validateSource(source, result.legacyOrganization), []);
});

test('M5 apply de snapshot mixto: las organizaciones del origen entran primero y la legacy no choca con sus IDs', async () => {
  const source = mixedSource();
  const plan = planFor(source);
  assert.equal(plan.mode, 'create', 'el código no está en el origen, así que se crea');
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver();
  await runApply({ source, legacyOrganization: plan, manifest, driver });

  const log = driver.state.log;
  const firstSourceInsert = log.indexOf('insert:organizations');
  const createIndex = log.indexOf('create-organization:6');
  assert.ok(firstSourceInsert !== -1 && createIndex > firstSourceInsert, 'la organización legacy se crea después de las del origen');
  assert.deepEqual(driver.state.tables.organizations.map((row) => [row.id, row.code]), [[1, 'ALFA'], [5, 'BETA'], [6, 'CMUCE']], 'IDs existentes conservados y la nueva sigue el contador');
  assert.equal(driver.state.tables.teams[0].organization_id, 6, 'las filas sin etiquetar van a la organización creada');
  assert.equal(driver.state.tables.tickets[0].organization_id, 1, 'las filas etiquetadas conservan su organización');
  assert.equal(manifest.tables.organizations.inserted_count, 3);
  assert.equal(manifest.tables.sequences.inserted_count, 1, 'la fila global no viaja y se añade la de la organización');
  assert.equal(driver.state.committed, true);
  assertIdentityBalanced(log);
});

test('M5 apply de snapshot mixto: si el código ya existe en el origen se reutiliza su ID', async () => {
  const source = mixedSource();
  source.organizations.push({ id: 7, code: 'CMUCE', name: 'Centro Médico UCE', active: 1, created_at: STAMP });
  source.teams[0].name = 'Mesa heredada';
  const plan = planFor(source);
  assert.equal(plan.mode, 'reuse');
  assert.equal(plan.existingId, 7);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver();
  const result = await runApply({ source, legacyOrganization: plan, manifest, driver });

  assert.equal(driver.state.log.some((entry) => entry.startsWith('create-organization')), false, 'no se crea una segunda organización con el mismo código');
  assert.deepEqual(driver.state.tables.organizations.map((row) => [row.id, row.code]), [[1, 'ALFA'], [5, 'BETA'], [7, 'CMUCE']]);
  assert.equal(driver.state.tables.teams[0].organization_id, 7, 'las filas sin etiquetar se resuelven contra el ID existente');
  assert.equal(result.legacyOrganization.resolvedId, 7);
  assert.equal(manifest.tables.organizations.inserted_count, 3, 'solo las organizaciones del origen');
  assert.equal(manifest.legacy_organization.planned_creation, false);
  assert.equal(manifest.legacy_organization.reused_organization_id, 7);
  assert.equal(manifest.legacy_organization.organization_action, 'reuse');
  assert.equal(driver.state.committed, true);
});

test('M5 apply se niega a escribir si el destino no está vacío', async () => {
  const source = legacySource();
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver({ totalRows: 1 });
  await assert.rejects(() => runApply({ source, legacyOrganization: plan, manifest, driver }), new RegExp(EMPTY_TARGET_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(driver.state.rolledBack, true, 'rollback');
  assert.equal(driver.state.committed, false);
  assert.deepEqual(driver.state.tables, {}, 'no se insertó ninguna fila');
  assert.equal(driver.state.log.includes('empty-check'), false);
  assert.equal(manifest.tables.tickets.inserted_count, 0);
});

test('M5 apply revierte todo y apaga IDENTITY_INSERT si una tabla falla a mitad', async () => {
  const source = legacySource();
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver({ failOn: 'tickets' });
  await assert.rejects(() => runApply({ source, legacyOrganization: plan, manifest, driver }), /fallo forzado en tickets/);
  assert.equal(driver.state.rolledBack, true, 'rollback');
  assert.equal(driver.state.committed, false);
  assertIdentityBalanced(driver.state.log);
  assert.ok(driver.state.log.includes('identity:tickets:ON') && driver.state.log.includes('identity:tickets:OFF'), 'se enciende y se apaga aunque falle una fila');
  assert.ok(driver.state.log.indexOf('insert:tickets') === -1, 'ningún ticket se insertó');
  assert.equal(manifest.tables.organizations.inserted_count, 1, 'el contador refleja solo lo que llegó a escribirse antes del fallo');
});

test('M5 el doble recibe tablas y columnas que siempre están en el esquema destino', async () => {
  const source = legacySource();
  source.settings = [{ key: 'ticket_prefix', value: 'TCK', updated_at: STAMP, created_at: STAMP }];
  const plan = planFor(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'VALIDACION' }, plan);
  const driver = fakeDriver();
  await runApply({ source, legacyOrganization: plan, manifest, driver });
  const written = Object.keys(driver.state.tables);
  assert.deepEqual(written.sort(), ['departments', 'organizations', 'roles', 'sequences', 'settings', 'tickets', 'users']);
  assert.equal(written.every((table) => TABLES.includes(table)), true);
  for (const table of written) {
    for (const row of driver.state.tables[table]) assert.equal(Object.keys(row).every((column) => COLUMNS[table].includes(column)), true, `${table}: columna fuera de allowlist`);
  }
  assert.equal(SKIPPED_TABLES.has('sessions') && driver.state.tables.sessions, undefined);
});
