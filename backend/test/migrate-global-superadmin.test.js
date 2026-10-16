import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_TABLES, SUPERADMIN_GLOBAL_PERMISSION, SUPERADMIN_ROLE_CODE,
  legacyOrganizationPlan, transformRow, userOrganizationError, validateSource,
} from '../scripts/migration/sqlite-to-mssql.js';
import { SUPERADMIN_ROLE_CODE as POLICY_ROLE_CODE } from '../src/orgPolicy.js';
import { PERMISSIONS } from '../src/seed.js';
import { requireOrg } from '../src/middleware/org.js';
import { canViewTicket } from '../src/routes/tickets.js';
import { emptySource, STAMP } from './fixtures/migration-sources.mjs';

// Hallazgo 1: el esquema MSSQL permite users.organization_id NULL, pero esa
// apertura es EXCLUSIVA de una cuenta SUPERADMIN global. `users` no entra en
// GLOBAL_TABLES: la excepción es por fila y se decide con rol + permisos.

function multiOrgSource() {
  const source = emptySource();
  source.organizations = [
    { id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP },
    { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP },
  ];
  source.roles = [
    { id: 1, code: 'ADMIN', name: 'Administrador', active: 1, created_at: STAMP },
    { id: 9, code: 'SUPERADMIN', name: 'Superadministrador', active: 1, created_at: STAMP },
  ];
  source.permissions = [
    { id: 1, code: 'ticket.view.all', description: 'Ver todos', created_at: STAMP },
    { id: 2, code: SUPERADMIN_GLOBAL_PERMISSION, description: 'Gestionar organizaciones', created_at: STAMP },
  ];
  source.role_permissions = [{ role_id: 9, permission_id: 2 }];
  source.departments = [{ id: 1, organization_id: 7, name: 'TI', active: 1, created_at: STAMP }];
  return source;
}

const globalUser = () => ({
  id: 10, organization_id: null, department_id: null, role_id: 9, name: 'Super', last_name: 'Admin',
  username: 'root.global', email: 'root@empresa.test', password_hash: 'x'.repeat(20), active: 1, created_at: STAMP,
});

test('M5 users sigue siendo tabla tenant: el NULL global es una excepción por fila', () => {
  assert.equal(GLOBAL_TABLES.has('users'), false, 'users NO se añade a GLOBAL_TABLES');
  const source = multiOrgSource();
  source.users = [globalUser()];
  assert.equal(transformRow('users', source.users[0], source).organization_id, null, 'el SUPERADMIN global queda sin organización');
  assert.deepEqual(validateSource(source), [], 'una cuenta global válida no produce errores de precheck');
  assert.equal(legacyOrganizationPlan(source, { code: 'CMUCE', name: 'Centro Médico UCE' }), null,
    'una cuenta global no dispara la creación del tenant legacy');
});

test('M5 un usuario normal jamás queda sin organización', () => {
  const source = multiOrgSource();
  source.users = [{ ...globalUser(), id: 11, role_id: 1, username: 'admin.alfa', email: 'admin@empresa.test', department_id: 1 }];
  const errors = validateSource(source);
  assert.ok(errors.some((e) => e.table === 'users' && /usuario normal debe pertenecer a una organización/.test(e.error)),
    JSON.stringify(errors));
  // Sin plan legacy la fila se rechaza; con plan hereda el tenant legacy.
  const legacy = emptySource();
  legacy.roles = [{ id: 1, code: 'ADMIN', name: 'Administrador', active: 1, created_at: STAMP }];
  legacy.departments = [{ id: 1, name: 'TI', active: 1, created_at: STAMP }];
  legacy.users = [{ id: 1, role_id: 1, department_id: 1, active: 1, created_at: STAMP }];
  const plan = legacyOrganizationPlan(legacy, { code: 'CMUCE', name: 'Centro Médico UCE' });
  assert.ok(plan, 'el usuario sin etiqueta exige el tenant legacy');
  assert.equal(transformRow('users', legacy.users[0], legacy, plan).organization_id, 'legacy-org:CMUCE');
  assert.deepEqual(validateSource(legacy, plan), []);
});

test('M5 se rechaza un NULL de organización sin rol SUPERADMIN válido', () => {
  const source = multiOrgSource();
  // Rol SUPERADMIN sin el permiso global reservado.
  source.role_permissions = [];
  source.users = [globalUser()];
  assert.match(userOrganizationError(source.users[0], source, null), /no tiene el permiso global organization\.manage/);
  assert.match(String(validateSource(source).find((e) => e.table === 'users')?.error), /permiso global organization\.manage/);
});

test('M5 se rechaza un SUPERADMIN global con departamento o con organización propia', () => {
  const withDepartment = { ...globalUser(), department_id: 1 };
  assert.match(userOrganizationError(withDepartment, multiOrgSource(), null), /no puede pertenecer a un departamento/);
  const withOrganization = { ...globalUser(), organization_id: 7 };
  assert.match(userOrganizationError(withOrganization, multiOrgSource(), 7), /organization_id debe ser NULL/);
  const source = multiOrgSource();
  source.users = [withOrganization];
  assert.ok(validateSource(source).some((e) => e.table === 'users' && /organization_id debe ser NULL/.test(e.error)));
});

test('M5 una fila tenant no puede apuntar a una cuenta global', () => {
  const source = multiOrgSource();
  source.users = [globalUser()];
  source.tickets = [{ id: 1, organization_id: 7, ticket_number: 'TCK-000001', reporter_id: 10, created_at: STAMP }];
  const errors = validateSource(source);
  assert.ok(errors.some((e) => e.table === 'tickets' && /referencia users#10 sin organización/.test(e.error)),
    `la FK compuesta del destino no encontraría la clave: ${JSON.stringify(errors)}`);
});

test('M5 la política del migrador coincide con la del runtime', () => {
  assert.equal(SUPERADMIN_ROLE_CODE, POLICY_ROLE_CODE, 'el código de rol debe ser el mismo que src/orgPolicy.js');
  assert.ok(PERMISSIONS.some(([code]) => code === SUPERADMIN_GLOBAL_PERMISSION),
    'el permiso global debe existir en el catálogo de src/seed.js');
});

test('M5 un SUPERADMIN global no usa rutas tenant sin contexto de organización', () => {
  const response = () => ({ statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; return this; } });
  const res = response();
  requireOrg({ user: { organization_id: null } }, res, () => assert.fail('sin contexto no debe continuar'));
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /organización de contexto/);
  const ok = response();
  requireOrg({ user: { organization_id: 7 } }, ok, () => {});
  assert.equal(ok.statusCode, null, 'con contexto de organización la ruta continúa');

  const ticket = { id: 1, organization_id: 7, reporter_id: 1 };
  const global = { id: 10, organization_id: null, permissions: ['ticket.view.all', SUPERADMIN_GLOBAL_PERMISSION] };
  assert.equal(canViewTicket(global, ticket), false, 'sin contexto el recurso tenant ni siquiera existe para él');
  const scoped = { id: 11, organization_id: 7, permissions: ['ticket.view.all'] };
  assert.equal(canViewTicket(scoped, ticket), true, 'con contexto sigue viendo solo la de su organización');
});
