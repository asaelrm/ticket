import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, UNIQUE_KEYS, validateSource } from '../scripts/migration/sqlite-to-mssql.js';
import { emptySource, STAMP } from './fixtures/migration-sources.mjs';

// Hallazgo 3: el precheck de unicidad se declara desde las restricciones REALES
// de src/db/mssql/schema.sql (paridad verificada en migrate-schema-parity) y se
// ejecuta antes de escribir cualquier fila. Las claves compuestas por
// organización se comparan contra la organización derivada, no contra la
// columna cruda.

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.join(here, '..', 'src', 'db', 'mssql', 'schema.sql'), 'utf8');

const dupError = (errors, columns) => errors.filter((e) => e.error === `duplicado ${columns}`);

function base() {
  const s = emptySource();
  s.organizations = [
    { id: 7, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP },
    { id: 9, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP },
  ];
  return s;
}

test('M5 el precheck cubre roles.code, permissions.code, organizations.code y usuarios', () => {
  const roles = base();
  roles.roles = [{ id: 1, code: 'ADMIN', name: 'A', active: 1, created_at: STAMP }, { id: 2, code: 'admin', name: 'B', active: 1, created_at: STAMP }];
  assert.equal(dupError(validateSource(roles), 'code').length, 1, 'roles.code es UNIQUE y la comparación ignora mayúsculas');

  const permissions = base();
  permissions.permissions = [{ id: 1, code: 'ticket.view.all', created_at: STAMP }, { id: 2, code: 'ticket.view.all', created_at: STAMP }];
  assert.equal(dupError(validateSource(permissions), 'code').length, 1, 'permissions.code es UNIQUE');

  const organizations = base();
  organizations.organizations.push({ id: 11, code: 'alfa', name: 'Otra', active: 1, created_at: STAMP });
  assert.equal(dupError(validateSource(organizations), 'code').length, 1, 'organizations.code es UNIQUE');

  const users = base();
  users.roles = [{ id: 1, code: 'ADMIN', name: 'A', active: 1, created_at: STAMP }];
  users.users = [
    { id: 1, organization_id: 7, role_id: 1, username: 'operador', email: 'op@empresa.test', active: 1, created_at: STAMP },
    { id: 2, organization_id: 9, role_id: 1, username: 'operador', email: 'OTRO@empresa.test', active: 1, created_at: STAMP },
    { id: 3, organization_id: 9, role_id: 1, username: 'otro', email: 'OP@empresa.test', active: 1, created_at: STAMP },
  ];
  const errors = validateSource(users);
  assert.equal(dupError(errors, 'username').length, 1, 'UQ_users_username es global, no por organización');
  assert.equal(dupError(errors, 'email').length, 1, 'UQ_users_email es global, no por organización');
});

test('M5 el precheck cubre stored_name, settings.key, sequences.name y las claves compuestas', () => {
  const attachments = base();
  attachments.tickets = [{ id: 1, organization_id: 7, ticket_number: 'TCK-000001', created_at: STAMP }];
  attachments.ticket_attachments = [
    { id: 1, organization_id: 7, ticket_id: 1, stored_name: 'a.bin', original_name: 'a', mime_type: 'application/octet-stream', size_bytes: 1, created_at: STAMP },
    { id: 2, organization_id: 7, ticket_id: 1, stored_name: 'A.BIN', original_name: 'b', mime_type: 'application/octet-stream', size_bytes: 1, created_at: STAMP },
  ];
  assert.equal(dupError(validateSource(attachments), 'stored_name').length, 1, 'UQ_ticket_attachments_stored_name es global');

  const settings = base();
  settings.settings = [{ key: 'ticket_prefix', value: 'TCK', created_at: STAMP }, { key: 'TICKET_PREFIX', value: 'OTRO', created_at: STAMP }];
  assert.equal(dupError(validateSource(settings), 'key').length, 1, 'PK_settings sobre [key]');

  const sequences = base();
  sequences.sequences = [{ name: 'ticket_number:7', value: 1 }, { name: 'Ticket_Number:7', value: 2 }];
  assert.equal(dupError(validateSource(sequences), 'name').length, 1, 'PK_sequences sobre name');

  const memberships = base();
  memberships.roles = [{ id: 1, code: 'ADMIN', name: 'A', active: 1, created_at: STAMP }];
  memberships.users = [{ id: 1, organization_id: 7, role_id: 1, username: 'operador', email: 'op@empresa.test', active: 1, created_at: STAMP }];
  memberships.teams = [{ id: 1, organization_id: 7, name: 'Mesa', active: 1, created_at: STAMP }];
  memberships.team_members = [
    { organization_id: 7, team_id: 1, user_id: 1 },
    { organization_id: 7, team_id: 1, user_id: 1 },
  ];
  assert.equal(dupError(validateSource(memberships), 'team_id+user_id').length, 1, 'PK_team_members (team_id, user_id)');

  const links = base();
  links.roles = [{ id: 1, code: 'ADMIN', name: 'A', active: 1, created_at: STAMP }];
  links.permissions = [{ id: 1, code: 'ticket.view.all', created_at: STAMP }];
  links.role_permissions = [{ role_id: 1, permission_id: 1 }, { role_id: 1, permission_id: 1 }];
  assert.equal(dupError(validateSource(links), 'role_id+permission_id').length, 1, 'PK_role_permissions (role_id, permission_id)');

  const kbLinks = base();
  kbLinks.tickets = [{ id: 1, organization_id: 7, ticket_number: 'TCK-000001', created_at: STAMP }];
  kbLinks.kb_articles = [{ id: 1, organization_id: 7, title: 'Guía', summary: 's', description: 'd', solution: 'x', created_at: STAMP }];
  kbLinks.kb_ticket_articles = [
    { organization_id: 7, article_id: 1, ticket_id: 1, created_at: STAMP },
    { organization_id: 7, article_id: 1, ticket_id: 1, created_at: STAMP },
  ];
  assert.equal(dupError(validateSource(kbLinks), 'article_id+ticket_id').length, 1, 'PK_kb_ticket_articles (article_id, ticket_id)');
});

test('M5 la PK de id se detecta antes de escribir y las claves compuestas por organización se respetan', () => {
  const repeatedId = base();
  repeatedId.tickets = [
    { id: 1, organization_id: 7, ticket_number: 'TCK-000001', created_at: STAMP },
    { id: 1, organization_id: 9, ticket_number: 'TCK-000009', created_at: STAMP },
  ];
  assert.equal(dupError(validateSource(repeatedId), 'id').length, 1, 'el id de la PK no puede repetirse');

  const perOrg = base();
  perOrg.departments = [
    { id: 1, organization_id: 7, name: 'TI', active: 1, created_at: STAMP },
    { id: 2, organization_id: 9, name: 'TI', active: 1, created_at: STAMP },
  ];
  perOrg.tickets = [
    { id: 1, organization_id: 7, ticket_number: 'TCK-000001', created_at: STAMP },
    { id: 2, organization_id: 9, ticket_number: 'TCK-000001', created_at: STAMP },
  ];
  perOrg.org_settings = [
    { organization_id: 7, key: 'sla_hours', value: '24', created_at: STAMP },
    { organization_id: 9, key: 'sla_hours', value: '48', created_at: STAMP },
  ];
  const errors = validateSource(perOrg);
  assert.deepEqual(errors.filter((e) => e.error.startsWith('duplicado')), [],
    'el mismo nombre/número en dos organizaciones es legítimo');
});

test('M5 categories.color NO es UNIQUE en el esquema y el precheck no lo trata como tal', () => {
  assert.match(ddl, /CK_categories_color CHECK \(color LIKE/, 'el esquema solo declara un CHECK de formato');
  assert.doesNotMatch(ddl, /UNIQUE\s*\(\s*color\s*\)/i, 'el esquema no declara UNIQUE sobre color');
  assert.equal(Object.values(UNIQUE_KEYS).flat().some((key) => key.columns.includes('color')), false,
    'ninguna clave del precheck incluye color');

  const source = base();
  source.categories = [
    { id: 1, organization_id: 7, name: 'Red', color: '#2563eb', active: 1, created_at: STAMP },
    { id: 2, organization_id: 7, name: 'Cable', color: '#2563eb', active: 1, created_at: STAMP },
  ];
  assert.deepEqual(validateSource(source).filter((e) => e.error.startsWith('duplicado')), [],
    'dos categorías pueden compartir color en la misma organización');
});

test('M5 UNIQUE_KEYS declara exactamente las tablas y claves del esquema destino', () => {
  assert.deepEqual(Object.keys(UNIQUE_KEYS).sort(), [...TABLES].sort(), 'cada tabla del destino tiene sus claves declaradas');
  for (const [table, keys] of Object.entries(UNIQUE_KEYS)) {
    assert.ok(keys.length, `${table} debe declarar al menos su PK`);
    for (const key of keys) {
      assert.ok(key.columns.length >= 1, `${table}: clave sin columnas`);
      assert.equal(typeof key.exempt === 'string' || key.exempt === undefined, true, `${table}: exempt debe ser un texto`);
      if (key.exempt) assert.ok(key.exempt.length > 0, `${table}: exempt sin justificación`);
      else assert.equal(key.exempt, undefined, `${table}: clave ${key.columns.join('+')} debe ser chequeada`);
    }
  }
});
