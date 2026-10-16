import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPERADMIN_GLOBAL_PERMISSION,
  isLegitimateGlobalNotification,
  organizationFor,
  reconciliationPlan,
  transformRow,
  validateSource,
} from '../scripts/migration/sqlite-to-mssql.js';
import { emptySource, STAMP } from './fixtures/migration-sources.mjs';

// `notifications.organization_id` es NULL en MSSQL SOLO para un aviso global
// (sin ticket) a una cuenta SUPERADMIN global legítima. Cualquier otro NULL se
// rechaza en el precheck; una notificación con ticket_id y sin organización es
// un dato corrupto (la FK compuesta (organization_id, ticket_id) no lo
// detectaría por sí sola).

const ORG_A = { id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP };
const ORG_B = { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP };

function baseSource() {
  const s = emptySource();
  s.organizations = [ORG_A, ORG_B];
  s.roles = [
    { id: 1, code: 'ADMIN', name: 'Administrador', active: 1, created_at: STAMP },
    { id: 9, code: 'SUPERADMIN', name: 'Superadministrador', active: 1, created_at: STAMP },
  ];
  s.permissions = [
    { id: 2, code: SUPERADMIN_GLOBAL_PERMISSION, description: 'Gestionar organizaciones', created_at: STAMP },
  ];
  s.role_permissions = [{ role_id: 9, permission_id: 2 }];
  s.departments = [{ id: 1, organization_id: 7, name: 'TI', active: 1, created_at: STAMP }];
  s.users = [
    { id: 20, organization_id: 7, department_id: 1, role_id: 1, name: 'Admin', last_name: 'A', username: 'admin.a', email: 'admin.a@empresa.test', password_hash: 'x'.repeat(20), active: 1, created_at: STAMP },
    { id: 21, organization_id: 9, department_id: null, role_id: 1, name: 'Admin', last_name: 'B', username: 'admin.b', email: 'admin.b@empresa.test', password_hash: 'x'.repeat(20), active: 1, created_at: STAMP },
    { id: 30, organization_id: null, department_id: null, role_id: 9, name: 'Super', last_name: 'Admin', username: 'root.global', email: 'root@empresa.test', password_hash: 'x'.repeat(20), active: 1, created_at: STAMP },
  ];
  s.tickets = [{ id: 1, organization_id: 7, ticket_number: 'TCK-000001', reporter_id: 20, created_at: STAMP }];
  return s;
}

const note = (overrides = {}) => ({
  id: 1, user_id: 20, ticket_id: null, type: 'TEST', title: 'Aviso', body: null, link: null,
  read_at: null, created_at: STAMP, ...overrides,
});

test('M5 una notificación de ticket toma la organización de su destinatario en esa organización', () => {
  const s = baseSource();
  s.notifications = [note({ id: 1, user_id: 20, ticket_id: 1 })];
  assert.equal(organizationFor('notifications', s.notifications[0], s), 7);
  assert.equal(transformRow('notifications', s.notifications[0], s).organization_id, 7);
  assert.deepEqual(validateSource(s), []);
});

test('M5 una notificación de ticket no puede cruzar de organización', () => {
  const s = baseSource();
  // Destinatario de B para un ticket de A: la FK compuesta del destino fallaría.
  s.notifications = [note({ id: 1, user_id: 21, ticket_id: 1 })];
  const errors = validateSource(s);
  assert.ok(
    errors.some((e) => e.table === 'notifications' && /aislamiento: organization_id 9 difiere de tickets#1 \(7\)/.test(e.error)),
    JSON.stringify(errors),
  );
});

test('M5 una notificación sin ticket a un usuario de empresa toma la organización del destinatario', () => {
  const s = baseSource();
  s.notifications = [note({ id: 1, user_id: 20, ticket_id: null })];
  assert.equal(transformRow('notifications', s.notifications[0], s).organization_id, 7);
  assert.deepEqual(validateSource(s), []);
});

test('M5 un aviso global a un SUPERADMIN sin organización queda con organization_id NULL', () => {
  const s = baseSource();
  s.notifications = [note({ id: 1, user_id: 30, ticket_id: null })];
  assert.equal(isLegitimateGlobalNotification(s.notifications[0], s), true);
  assert.equal(transformRow('notifications', s.notifications[0], s).organization_id, null);
  assert.deepEqual(validateSource(s), [], 'el NULL legítimo no produce errores de precheck');
});

test('M5 se rechaza un NULL con ticket presente (notificación corrupta)', () => {
  const s = baseSource();
  // SUPERADMIN sin organización recibiendo una notificación de ticket: el
  // destinatario no pertenece a la organización del ticket.
  const row = note({ id: 1, user_id: 30, ticket_id: 1 });
  assert.equal(isLegitimateGlobalNotification(row, s), false);
  assert.throws(
    () => transformRow('notifications', row, s),
    /notifications#1: organization_id NULL con ticket_id 1; una notificación de ticket debe pertenecer a la organización del ticket/,
  );
});

test('M5 se rechaza un NULL cuyo destinatario no es un SUPERADMIN global', () => {
  const s = baseSource();
  s.users.push({ id: 31, organization_id: null, department_id: null, role_id: 1, name: 'Sin', last_name: 'Org', username: 'sin.org', email: 'sin.org@empresa.test', password_hash: 'x'.repeat(20), active: 1, created_at: STAMP });
  const row = note({ id: 1, user_id: 31, ticket_id: null });
  assert.equal(isLegitimateGlobalNotification(row, s), false);
  assert.throws(
    () => transformRow('notifications', row, s),
    /notifications#1: organization_id NULL no permitido: el destinatario no es un SUPERADMIN global legítimo/,
  );
  s.notifications = [row];
  const errors = validateSource(s);
  assert.ok(errors.some((e) => e.table === 'notifications' && /no es un SUPERADMIN global legítimo/.test(e.error)), JSON.stringify(errors));
});

test('M5 isLegitimateGlobalNotification exige SUPERADMIN sin organización y con el permiso global', () => {
  const noTicket = note({ user_id: 30, ticket_id: null });
  assert.equal(isLegitimateGlobalNotification(noTicket, baseSource()), true);

  // Con ticket nunca es un aviso global.
  assert.equal(isLegitimateGlobalNotification(note({ user_id: 30, ticket_id: 1 }), baseSource()), false);

  // SUPERADMIN con departamento: cuenta global inválida.
  const withDepartment = baseSource();
  withDepartment.users[2] = { ...withDepartment.users[2], department_id: 1 };
  assert.equal(isLegitimateGlobalNotification(noTicket, withDepartment), false);

  // SUPERADMIN sin el permiso global reservado.
  const withoutPermission = baseSource();
  withoutPermission.role_permissions = [];
  assert.equal(isLegitimateGlobalNotification(noTicket, withoutPermission), false);

  // Usuario normal sin organización (no autorizado).
  const normal = baseSource();
  normal.users[0] = { ...normal.users[0], department_id: null, organization_id: null };
  assert.equal(isLegitimateGlobalNotification(note({ user_id: 20, ticket_id: null }), normal), false);
});

test('M5 el plan de reconciliación declara la política de NULL de notifications', () => {
  const policy = reconciliationPlan().nullPolicy.notifications;
  assert.equal(policy.column, 'organization_id');
  assert.match(policy.allowedWhen, /ticket_id IS NULL/);
  assert.match(policy.allowedWhen, /SUPERADMIN global/i);
});
