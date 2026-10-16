import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TABLES, LEGACY_SEQUENCE_NAME, buildManifest, legacyOrganizationInsertRow, legacyOrganizationPlan,
  legacySequencePlan, legacySequenceRow, resolveLegacyOrganization, sequenceRowsForMigration,
  transformRow, validateSource,
} from '../scripts/migration/sqlite-to-mssql.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const emptySource = () => Object.fromEntries(TABLES.map((table) => [table, []]));
const STAMP = '2026-01-05T10:00:00.000Z';

// Origen legacy ficticio: sin columna organization_id en ninguna tabla tenant,
// con el contador global atrasado (5) frente al máximo real de tickets (14).
function legacySource() {
  const source = emptySource();
  source.departments = [{ id: 1, name: 'Dirección', active: 1, created_at: STAMP }];
  source.users = [{ id: 1, email: 'admin@cmuce.test', department_id: 1, active: 1, created_at: STAMP }];
  source.tickets = [
    { id: 1, ticket_number: 'TCK-000014', reporter_id: 1, created_at: STAMP },
    { id: 2, ticket_number: 'TCK-000005', reporter_id: 1, created_at: STAMP },
  ];
  source.sequences = [{ name: LEGACY_SEQUENCE_NAME, value: 5 }];
  return source;
}

// Origen multiempresa ficticio: todo etiquetado con su organización real.
function multiOrgSource() {
  const source = emptySource();
  source.organizations = [
    { id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP },
    { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP },
  ];
  source.departments = [
    { id: 1, organization_id: 7, name: 'Operaciones', active: 1, created_at: STAMP },
    { id: 2, organization_id: 9, name: 'Ventas', active: 1, created_at: STAMP },
  ];
  source.tickets = [
    { id: 1, organization_id: 7, ticket_number: 'TCK-000003', created_at: STAMP },
    { id: 2, organization_id: 9, ticket_number: 'TCK-000003', created_at: STAMP },
  ];
  return source;
}

const legacyPlan = (source) => legacyOrganizationPlan(source, { code: 'CMUCE', name: 'Centro Médico UCE' });

test('M5 la organización legacy se crea con el código indicado, sin ID fijado ni código hardcodeado', () => {
  const plan = legacyPlan(legacySource());
  const row = legacyOrganizationInsertRow(plan, STAMP);
  assert.deepEqual(row, { code: 'CMUCE', name: 'Centro Médico UCE', active: true, created_at: STAMP });
  assert.equal('id' in row, false, 'el ID lo asigna el destino, nunca el origen');
  // El código es un parámetro: sirve para cualquier otro cliente legacy.
  const otra = legacyOrganizationPlan(legacySource(), { code: 'OTRA', name: 'Otro Cliente' });
  assert.equal(legacyOrganizationInsertRow(otra, STAMP).code, 'OTRA');
  assert.equal(legacyOrganizationInsertRow(otra, STAMP).name, 'Otro Cliente');
  assert.throws(() => legacyOrganizationInsertRow(null), /requiere el plan/);
  assert.throws(() => legacyOrganizationInsertRow(plan, '2026-01-05'), /sin timezone/);
});

test('M5 resuelve el ID numérico real y no asume organization_id=1', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  const resolved = resolveLegacyOrganization(plan, 42);
  assert.equal(resolved.resolvedId, 42);
  for (const table of ['departments', 'users', 'tickets']) {
    const row = source[table][0];
    const output = transformRow(table, row, source, resolved);
    assert.equal(output.organization_id, 42, `${table} debe usar el ID real`);
    assert.notEqual(output.organization_id, 1, 'nunca se asume el ID 1');
  }
  for (const invalid of [0, -3, null, undefined, 'abc', 1.5]) {
    assert.throws(() => resolveLegacyOrganization(plan, invalid), /ID real devuelto por el destino/);
  }
  assert.throws(() => resolveLegacyOrganization(null, 42), /requiere el plan/);
});

test('M5 sin resolver (dry-run) el marcador se mantiene y con el ID real desaparece', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  assert.equal(transformRow('tickets', source.tickets[0], source, plan).organization_id, 'legacy-org:CMUCE');
  const resolved = resolveLegacyOrganization(plan, 42);
  assert.equal(transformRow('tickets', source.tickets[0], source, resolved).organization_id, 42);
  assert.equal(plan.marker, 'legacy-org:CMUCE');
});

test('M5 multiempresa: las filas ya etiquetadas conservan su organización y el origen limpio valida sin errores', () => {
  const source = multiOrgSource();
  assert.equal(legacyOrganizationPlan(source, { code: 'CMUCE', name: 'Centro Médico UCE' }), null, 'sin filas huérfanas no hay organización que crear');
  assert.equal(transformRow('tickets', source.tickets[0], source, null).organization_id, 7);
  assert.equal(transformRow('tickets', source.tickets[1], source, null).organization_id, 9);
  assert.deepEqual(validateSource(source), []);
  // El mismo número de ticket en organizaciones distintas no es duplicado.
  assert.equal(validateSource(source).filter((e) => e.error.startsWith('duplicado')).length, 0);
});

test('M5 multiempresa: las filas sin etiquetar heredan la organización creada sin pisar las existentes', () => {
  const source = multiOrgSource();
  source.teams = [{ id: 1, name: 'Mesa de ayuda', active: 1, created_at: STAMP }];
  const plan = legacyPlan(source);
  assert.ok(plan, 'una tabla entera sin organización exige el plan legacy');
  const resolved = resolveLegacyOrganization(plan, 42);
  assert.equal(transformRow('teams', source.teams[0], source, resolved).organization_id, 42);
  assert.equal(transformRow('tickets', source.tickets[0], source, resolved).organization_id, 7);
  assert.equal(transformRow('tickets', source.tickets[1], source, resolved).organization_id, 9);
  assert.deepEqual(validateSource(source, resolved), []);
});

test('M5 aislamiento: un hijo en otra organización que su padre se rechaza', () => {
  const source = multiOrgSource();
  source.ticket_comments = [{ id: 1, ticket_id: 1, organization_id: 9, created_at: STAMP }];
  const errors = validateSource(source);
  assert.ok(errors.some((e) => e.table === 'ticket_comments' && /aislamiento/.test(e.error)), JSON.stringify(errors));
});

test('M5 aislamiento: un organization_id inexistente en el origen se rechaza', () => {
  const source = multiOrgSource();
  source.departments[0].organization_id = 99;
  const errors = validateSource(source);
  assert.ok(errors.some((e) => /organization_id 99 no existe en organizations del origen/.test(e.error)), JSON.stringify(errors));
});

test('M5 la secuencia usa el máximo real de la organización y no el contador legacy', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  assert.equal(plan.sequence.legacy_sequence_value, 5, 'el contador legacy queda solo como referencia');
  assert.equal(plan.sequence.max_ticket_number, 14);
  assert.equal(plan.sequence.reconciled_value, 14);
  assert.equal(plan.sequence.next_ticket_number, 15, 'el próximo ticket es TCK-000015');
  // El valor guardado es el último número emitido: nextTicketNumber suma 1 al usarlo.
  assert.deepEqual(legacySequenceRow(plan, 42), { name: `${LEGACY_SEQUENCE_NAME}:42`, value: 14 });
  assert.throws(() => legacySequenceRow(plan, 0), /ID real devuelto por el destino/);
});

test('M5 la secuencia ignora los tickets de otras organizaciones', () => {
  const source = legacySource();
  source.organizations = [{ id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP }];
  source.tickets.push({ id: 3, organization_id: 9, ticket_number: 'TCK-000099', created_at: STAMP });
  const plan = legacyPlan(source);
  assert.ok(plan);
  assert.equal(plan.sequence.max_ticket_number, 14, 'el máximo ajeno (99) no contamina la secuencia legacy');
  assert.equal(plan.sequence.next_ticket_number, 15);
});

test('M5 multiempresa: solo se sustituye la fila global, las secuencias de otras organizaciones quedan intactas', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  source.sequences = [
    { name: LEGACY_SEQUENCE_NAME, value: 5 },
    { name: `${LEGACY_SEQUENCE_NAME}:7`, value: 3 },
    { name: `${LEGACY_SEQUENCE_NAME}:9`, value: 120 },
  ];
  const rows = sequenceRowsForMigration(source, plan, 42);
  assert.deepEqual(rows, [
    { name: `${LEGACY_SEQUENCE_NAME}:7`, value: 3 },
    { name: `${LEGACY_SEQUENCE_NAME}:9`, value: 120 },
    { name: `${LEGACY_SEQUENCE_NAME}:42`, value: 14 },
  ]);
  assert.equal(rows.some((r) => r.name === LEGACY_SEQUENCE_NAME), false, 'la fila global atrasada no viaja al destino');
  // Tampoco viaja sin organización legacy: la clave global no existe en el
  // runtime multiempresa y su valor lo absorbe cada organización por su máximo.
  assert.deepEqual(sequenceRowsForMigration(source, null).map((r) => r.name), [`${LEGACY_SEQUENCE_NAME}:7`, `${LEGACY_SEQUENCE_NAME}:9`]);
});

test('M5 la secuencia nunca baja: el máximo real manda sobre el valor guardado', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  source.sequences = [{ name: LEGACY_SEQUENCE_NAME, value: 5 }, { name: `${LEGACY_SEQUENCE_NAME}:7`, value: 18 }, { name: `${LEGACY_SEQUENCE_NAME}:9`, value: 3 }];
  source.organizations = [{ id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP }, { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP }];
  source.tickets.push({ id: 3, organization_id: 7, ticket_number: 'TCK-000014', created_at: STAMP });
  source.tickets.push({ id: 4, organization_id: 9, ticket_number: 'TCK-000001', created_at: STAMP });
  const rows = sequenceRowsForMigration(source, plan, 42);
  assert.deepEqual(rows, [
    // 7: guardado 18 > máximo real 14 -> se conserva 18.
    { name: `${LEGACY_SEQUENCE_NAME}:7`, value: 18 },
    // 9: guardado 3 < máximo real 1 -> se queda en 3 (no baja) y el máximo de
    // la organización 9 (1) tampoco la sube.
    { name: `${LEGACY_SEQUENCE_NAME}:9`, value: 3 },
    { name: `${LEGACY_SEQUENCE_NAME}:42`, value: 14 },
  ]);
});

test('M5 la secuencia nunca baja: el contador global legacy se absorbe en la organización', () => {
  const source = legacySource();
  source.sequences = [{ name: LEGACY_SEQUENCE_NAME, value: 30 }];
  source.tickets = [{ id: 1, ticket_number: 'TCK-000014', reporter_id: 1, created_at: STAMP }];
  const plan = legacyPlan(source);
  assert.equal(plan.sequence.max_ticket_number, 14);
  assert.equal(plan.sequence.reconciled_value, 30, 'el contador existente (30) queda por encima del máximo real (14)');
  assert.equal(plan.sequence.next_ticket_number, 31);
  assert.deepEqual(sequenceRowsForMigration(source, plan, 42), [{ name: `${LEGACY_SEQUENCE_NAME}:42`, value: 30 }]);
});

test('M5 el manifest declara la creación de la organización y la secuencia planificada', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  const manifest = buildManifest(source, { instance: 'SIFHADEV', database: 'DESTINO' }, plan);
  assert.equal(manifest.tables.organizations.planned_insert_count, 1);
  assert.equal(manifest.tables.sequences.planned_insert_count, 1);
  assert.equal(manifest.legacy_organization.legacy_org_code, 'CMUCE');
  assert.deepEqual(manifest.legacy_organization.planned_organization_row, { code: 'CMUCE', name: 'Centro Médico UCE', active: true });
  assert.equal(manifest.legacy_organization.sequence_reconciliation.planned_sequence_name, `${LEGACY_SEQUENCE_NAME}:<organization_id>`);
  assert.equal(manifest.legacy_organization.sequence_reconciliation.legacy_global_sequence_rows, 1);
  assert.equal(manifest.legacy_organization.sequence_reconciliation.reconciled_value, 14);
  assert.equal(manifest.tables.sessions.planned_insert_count, 0);
});

test('M5 el origen ficticio legacy valida sin errores con la organización resuelta', () => {
  const source = legacySource();
  const plan = legacyPlan(source);
  assert.deepEqual(validateSource(source, plan), []);
  assert.deepEqual(validateSource(source, resolveLegacyOrganization(plan, 42)), []);
});

test('M5 el código del cliente no está codificado y apply resuelve el ID real', () => {
  const migrator = path.join(here, '..', 'scripts', 'migrate-sqlite-to-mssql.js');
  const library = path.join(here, '..', 'scripts', 'migration', 'sqlite-to-mssql.js');
  const applyModule = path.join(here, '..', 'scripts', 'migration', 'mssql-apply.js');
  for (const file of [migrator, library, applyModule]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('CMUCE'), false, `${path.basename(file)} no debe codificar el código del primer cliente`);
    assert.equal(/organization_id\s*=\s*1\b/.test(text), false, `${path.basename(file)} no debe fijar organization_id = 1`);
  }
  // El comportamiento de APPLY vive en el módulo con puerto semántico; el
  // script solo lo invoca con el driver real.
  const apply = [migrator, library, applyModule].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.ok(apply.includes('OUTPUT INSERTED.id'), 'apply debe leer el ID creado por el destino');
  assert.ok(apply.includes('resolveLegacyOrganization'), 'apply debe resolver el marcador con ese ID');
  assert.ok(apply.includes('sequenceRowsForMigration'), 'apply debe escribir la secuencia por organización');
  assert.ok(apply.includes('validateSource(source, activeLegacy)'), 'apply debe revalidar el aislamiento con el ID real');
  assert.ok(apply.includes('Destino no está vacío; APPLY se niega'), 'apply debe detenerse si el destino no está vacío');
  assert.ok(apply.includes('sp_getapplock'), 'el chequeo de vacuidad debe ir bloqueado dentro de la transacción');
});
