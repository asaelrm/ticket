import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMssqlSchema,
  requiredSchema,
  validateMssqlSchema,
  describeSchemaFailures,
} from '../src/db/mssql/schemaValidator.js';
import { createRuntime } from '../src/db/runtime.js';
import { COLUMNS, TABLES } from '../scripts/migration/sqlite-to-mssql.js';
import { catalogFromSchema, fakeContract } from './fixtures/mssql-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.join(here, '..', 'src', 'db', 'mssql', 'schema.sql'), 'utf8');
const sorted = (values) => [...values].sort();

// Fachada de consulta mínima sobre un catálogo ya construido (sin traducción).
function catalogQuery(catalog) {
  return async (statement) => {
    if (/sys\.columns/i.test(statement)) return catalog.columns;
    if (/sys\.objects/i.test(statement)) return catalog.constraints;
    return catalog.tables;
  };
}

describe('validador de esquema MSSQL: parser del DDL canónico', () => {
  it('extrae las 24 tablas y las columnas de cada una, en paridad con el migrador', () => {
    const schema = parseMssqlSchema(ddl);
    assert.equal(schema.size, 24);
    assert.deepEqual(sorted([...schema.keys()]), sorted(TABLES));
    for (const table of TABLES) {
      assert.deepEqual(
        sorted([...schema.get(table).columns.keys()]),
        sorted(COLUMNS[table]),
        `columnas de ${table}`,
      );
    }
  });

  it('marca correctamente nulabilidad, IDENTITY y las restricciones esenciales', () => {
    const schema = parseMssqlSchema(ddl);
    assert.equal(schema.get('team_members').columns.get('organization_id').notNull, true);
    assert.equal(schema.get('notifications').columns.get('organization_id').notNull, false);
    assert.equal(schema.get('tickets').columns.get('id').identity, true);
    assert.equal(schema.get('team_members').columns.has('id'), false);
    assert.ok(schema.get('notifications').constraints.has('CK_notifications_ticket_requires_org'));
    assert.ok(schema.get('team_members').constraints.has('FK_team_members_team_same_org'));
    assert.ok(schema.get('tickets').constraints.has('UQ_tickets_organization_ticket_number'));
  });

  it('requiredSchema() está cacheado y coincide con el parseo directo', () => {
    assert.equal(requiredSchema(), requiredSchema());
    assert.deepEqual(sorted([...requiredSchema().keys()]), sorted([...parseMssqlSchema(ddl).keys()]));
  });
});

describe('validador de esquema MSSQL: compatibilidad', () => {
  it('acepta un catálogo que coincide con el esquema y no reporta errores', async () => {
    const catalog = catalogFromSchema(requiredSchema());
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.counts.tables, 24);
  });

  it('funciona a través de la fachada de runtime (traduce las consultas de catálogo)', async () => {
    const catalog = catalogFromSchema(requiredSchema());
    const contract = fakeContract(catalog);
    const runtime = createRuntime({ engine: 'mssql', contract });
    const result = await validateMssqlSchema(runtime);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('falla si falta una tabla', async () => {
    const catalog = catalogFromSchema(requiredSchema(), { dropTable: 'teams' });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('falta la tabla dbo.teams')));
  });

  it('falla si falta una columna', async () => {
    const catalog = catalogFromSchema(requiredSchema(), { dropColumn: 'tickets.organization_id' });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('falta la columna dbo.tickets.organization_id')));
  });

  it('falla si una columna NOT NULL admite NULL', async () => {
    const catalog = catalogFromSchema(requiredSchema(), { forceNullable: 'team_members.organization_id' });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('team_members.organization_id') && e.includes('NOT NULL')));
  });

  it('falla si una columna IDENTITY no lo es', async () => {
    const catalog = catalogFromSchema(requiredSchema(), { dropIdentity: 'tickets' });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('tickets.id') && e.includes('IDENTITY')));
  });

  it('falla si falta una restricción esencial (FK compuesta)', async () => {
    const catalog = catalogFromSchema(requiredSchema(), {
      dropConstraint: 'team_members.FK_team_members_team_same_org',
    });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('FK_team_members_team_same_org')));
  });

  it('falla si falta el CHECK que exige organización en notificaciones de ticket', async () => {
    const catalog = catalogFromSchema(requiredSchema(), {
      dropConstraint: 'notifications.CK_notifications_ticket_requires_org',
    });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('CK_notifications_ticket_requires_org')));
  });

  it('un destino vacío produce errores claros, no una excepción', async () => {
    const result = await validateMssqlSchema(catalogQuery(catalogFromSchema(requiredSchema(), { empty: true })));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('falta la tabla dbo.organizations')));
  });

  it('tablas, columnas y restricciones de más son avisos, no errores', async () => {
    const catalog = catalogFromSchema(requiredSchema(), {
      addTable: 'audit_extra',
      addColumn: 'teams.extra_column',
      addConstraint: 'teams.CK_extra',
    });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('audit_extra')));
    assert.ok(result.warnings.some((w) => w.includes('extra_column')));
    assert.ok(result.warnings.some((w) => w.includes('CK_extra')));
  });
});

describe('validador de esquema MSSQL: mensaje de arranque', () => {
  it('describe los fallos y aclara que no se migró ni se sembró', async () => {
    const catalog = catalogFromSchema(requiredSchema(), { dropTable: 'teams' });
    const result = await validateMssqlSchema(catalogQuery(catalog));
    const message = describeSchemaFailures(result);
    assert.match(message, /no puede arrancar/);
    assert.match(message, /falta la tabla dbo\.teams/);
    assert.match(message, /no ejecutó migraciones, seed ni restauró instantáneas/);
  });
});
