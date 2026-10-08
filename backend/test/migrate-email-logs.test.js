import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyOrganizationPlan, organizationFor, transformRow, validateSource } from '../scripts/migration/sqlite-to-mssql.js';
import { emptySource, STAMP } from './fixtures/migration-sources.mjs';

// Hallazgo 2: la organización de un email_logs se DERIVA del ticket que
// notifica. Un registro explícito debe coincidir con ese ticket y uno huérfano
// (sin ticket y sin organización) se rechaza en el precheck: nunca se asigna
// automáticamente a la organización legacy por el solo hecho de existir.

const ORG_A = { id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP };
const ORG_B = { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP };

function source() {
  const s = emptySource();
  s.organizations = [ORG_A, ORG_B];
  s.tickets = [{ id: 1, organization_id: 7, ticket_number: 'TCK-000001', created_at: STAMP }];
  return s;
}

const log = (overrides = {}) => ({
  id: 1, kind: 'comment', to_email: 'paciente@correo.test', subject: 'Su ticket TCK-000001',
  ticket_id: 1, status: 'dev', created_at: STAMP, ...overrides,
});

test('M5 email_logs deriva la organización desde su ticket', () => {
  const s = source();
  const row = log({ organization_id: null });
  assert.equal(organizationFor('email_logs', row, s), 7, 'la organización sale del ticket, no de la columna');
  assert.equal(transformRow('email_logs', row, s).organization_id, 7);
  s.email_logs = [row];
  assert.deepEqual(validateSource(s), []);
});

test('M5 un organization_id explícito debe coincidir con el ticket asociado', () => {
  const matching = source();
  matching.email_logs = [log({ organization_id: 7 })];
  assert.deepEqual(validateSource(matching), [], 'la organización explícita y la del ticket coinciden');

  const mismatched = source();
  mismatched.email_logs = [log({ organization_id: 9 })];
  const errors = validateSource(mismatched);
  assert.ok(errors.some((e) => e.table === 'email_logs' && /organization_id 9 difiere de la organización del ticket 1 \(7\)/.test(e.error)),
    JSON.stringify(errors));
});

test('M5 un email_log huérfano se rechaza en el precheck con un mensaje sanitizado', () => {
  const s = source();
  s.email_logs = [log({ ticket_id: null, organization_id: null })];
  const errors = validateSource(s);
  const orphan = errors.find((e) => e.table === 'email_logs');
  assert.ok(orphan, JSON.stringify(errors));
  assert.match(orphan.error, /sin ticket_id ni organization_id explícito; se requiere decisión explícita/);
  assert.doesNotMatch(orphan.error, /paciente@correo\.test|Su ticket TCK/, 'el mensaje no expone destinatario ni asunto');
});

test('M5 un email_log huérfano no se asigna a la organización legacy', () => {
  const s = emptySource();
  s.departments = [{ id: 1, name: 'TI', active: 1, created_at: STAMP }];
  s.email_logs = [log({ ticket_id: null, organization_id: null })];
  const plan = legacyOrganizationPlan(s, { code: 'CMUCE', name: 'Centro Médico UCE' });
  assert.ok(plan, 'el departamento sin etiqueta dispara el tenant legacy');
  assert.equal(organizationFor('email_logs', s.email_logs[0], s, plan), null,
    'el correo huérfano no hereda CMUCE');
  assert.throws(() => transformRow('email_logs', s.email_logs[0], s, plan), /sin ticket_id ni organization_id/);
  assert.ok(validateSource(s, plan).some((e) => e.table === 'email_logs'));
});

test('M5 el email_log de un ticket legacy hereda la organización del ticket', () => {
  const s = emptySource();
  s.departments = [{ id: 1, name: 'TI', active: 1, created_at: STAMP }];
  s.tickets = [{ id: 1, ticket_number: 'TCK-000001', created_at: STAMP }];
  s.email_logs = [log({ organization_id: null })];
  const plan = legacyOrganizationPlan(s, { code: 'CMUCE', name: 'Centro Médico UCE' });
  assert.equal(organizationFor('email_logs', s.email_logs[0], s, plan), 'legacy-org:CMUCE',
    'el ticket manda: el log sigue al ticket, etiquetado o legacy');
  assert.deepEqual(validateSource(s, plan), []);
});

test('M5 un ticket_id inexistente se reporta como referencia rota, no como fila válida', () => {
  const s = source();
  s.email_logs = [log({ ticket_id: 404, organization_id: null })];
  const errors = validateSource(s);
  assert.ok(errors.some((e) => e.table === 'email_logs' && /ticket_id referencia tickets inexistente/.test(e.error)),
    JSON.stringify(errors));
  assert.ok(errors.some((e) => e.table === 'email_logs' && /el ticket referenciado no existe en el origen/.test(e.error)),
    JSON.stringify(errors));

  const withOrganization = source();
  withOrganization.email_logs = [log({ ticket_id: 404, organization_id: 7 })];
  const explicit = validateSource(withOrganization);
  assert.ok(explicit.some((e) => /ticket_id referencia tickets inexistente/.test(e.error)), JSON.stringify(explicit));
  assert.equal(explicit.some((e) => /organization_id .* requiere decisión/.test(e.error)), false,
    'con organización explícita la fila no se rechaza por falta de organización');
});
