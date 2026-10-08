import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS, IDENTITY_TABLES, TABLES, TENANT_FKS } from '../scripts/migration/sqlite-to-mssql.js';

// Paridad entre la allowlist del migrador y src/db/mssql/schema.sql: si alguien
// cambia el esquema destino sin actualizar COLUMNS/TENANT_FKS/IDENTITY_TABLES,
// las pruebas fallan antes de que APPLY toque el servidor.
const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.join(here, '..', 'src', 'db', 'mssql', 'schema.sql'), 'utf8');
const COLUMN_TYPE = /^(\[?\w+\]?)\s+(identity|bigint|int|nvarchar|varchar|bit|datetime2|decimal|varbinary|date|time|uniqueidentifier|float|real|smallint|tinyint|text|ntext)\b/i;

function parseSchema() {
  const columns = {};
  const identities = new Set();
  const foreignKeys = [];
  const pattern = /CREATE TABLE dbo\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let match;
  while ((match = pattern.exec(ddl))) {
    const table = match[1];
    const body = match[2];
    const names = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(line)) continue;
      const column = COLUMN_TYPE.exec(line);
      if (!column) continue;
      names.push(column[1].replace(/[[\]]/g, ''));
      if (/\bIDENTITY\s*\(/i.test(line)) identities.add(table);
    }
    columns[table] = names;
    const fk = /FOREIGN KEY \(([^)]+)\)\s*REFERENCES dbo\.(\w+)\s*\(([^)]+)\)/g;
    let ref;
    while ((ref = fk.exec(body))) {
      foreignKeys.push({
        table,
        columns: ref[1].split(',').map((value) => value.trim()),
        parent: ref[2],
        parentColumns: ref[3].split(',').map((value) => value.trim()),
      });
    }
  }
  return { columns, identities, foreignKeys };
}

const schema = parseSchema();
const sorted = (values) => [...values].sort();

test('M5 COLUMNS replica exactamente las columnas de cada tabla en schema.sql', () => {
  assert.deepEqual(sorted(Object.keys(COLUMNS)), sorted(Object.keys(schema.columns)));
  assert.deepEqual(sorted(TABLES), sorted(Object.keys(schema.columns)), 'TABLES debe ser el inventario completo del destino');
  assert.equal(TABLES.length, 24, 'el destino tiene 24 tablas');
  for (const table of TABLES) {
    assert.deepEqual(sorted(COLUMNS[table]), sorted(schema.columns[table]), `COLUMNS.${table} no coincide con schema.sql`);
  }
});

test('M5 IDENTITY_TABLES coincide con las tablas IDENTITY del esquema', () => {
  assert.deepEqual(sorted(IDENTITY_TABLES), sorted(schema.identities));
});

test('M5 TENANT_FKS se deriva de todas las FKs definidas en schema.sql', () => {
  const expected = [];
  for (const { table, columns, parent } of schema.foreignKeys) {
    if (columns.length === 1 && columns[0] === 'organization_id') continue; // ya cubierta por el chequeo dedicado
    if (columns.length === 1) { expected.push([table, columns[0], parent, false]); continue; }
    assert.equal(columns[0], 'organization_id', `${table}: FK compuesta inesperada (${columns.join(', ')})`);
    expected.push([table, columns[1], parent, true]);
  }
  assert.deepEqual(TENANT_FKS, expected);
  assert.equal(TENANT_FKS.length, 36, 'todas las FKs tenant del esquema están cubiertas');
  for (const [, , parent] of TENANT_FKS) assert.ok(TABLES.includes(parent), `${parent} debe ser una tabla del destino`);
});

test('M5 cada FK compuesta exige la misma organización y las simples solo existencia', () => {
  for (const [, column, , sameOrg] of TENANT_FKS) {
    assert.equal(typeof sameOrg, 'boolean', `${column} declara sameOrg explícito`);
  }
  const plain = TENANT_FKS.filter(([, , , sameOrg]) => !sameOrg).map(([table, column]) => `${table}.${column}`);
  assert.deepEqual(sorted(plain), sorted(['role_permissions.role_id', 'role_permissions.permission_id', 'users.role_id', 'settings.updated_by', 'org_settings.updated_by']));
});
