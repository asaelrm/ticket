import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredSchema, validateMssqlSchema } from '../src/db/mssql/schemaValidator.js';
import { catalogFromSchema } from './fixtures/mssql-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'scripts', 'migration', 'notifications-organization-nullable.sql');
const script = fs.readFileSync(scriptPath, 'utf8');

// Cuerpo efectivo sin comentarios: evita que el plan de recuperacion (que
// menciona DROP CONSTRAINT) cuente como una operacion destructiva real.
function stripSqlComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

const code = stripSqlComments(script);

// Fachada de consulta minima, igual que en mssql-schema-validator.test.js.
function catalogQuery(catalog) {
  return async (statement) => {
    if (/sys\.columns/i.test(statement)) return catalog.columns;
    if (/sys\.objects/i.test(statement)) return catalog.constraints;
    return catalog.tables;
  };
}

describe('fix M5 dbo.notifications: script estatico', () => {
  it('se declara exclusivo de SIFHA_Tickets_M5_Validation en TI-DESK-01\\SIFHADEV', () => {
    assert.match(script, /SIFHA_Tickets_M5_Validation/);
    assert.match(script, /TI-DESK-01\\SIFHADEV/);
    assert.match(code, /SERVERPROPERTY\('ServerName'\)/);
    assert.match(code, /SERVERPROPERTY\('InstanceName'\)/);
    assert.match(code, /DB_NAME\(\)/);
    // Aborta (RETURN) si la identidad no coincide, antes de tocar nada.
    assert.match(code, /ABORTADO:[\s\S]*?RETURN;/);
  });

  it('cambia SOLO la nulabilidad de organization_id y no toca body/link', () => {
    const altered = [...code.matchAll(/ALTER COLUMN\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    assert.ok(altered.length >= 1, 'debe contener un ALTER COLUMN');
    assert.deepEqual([...new Set(altered)], ['organization_id']);
    assert.match(code, /ALTER TABLE dbo\.notifications ALTER COLUMN organization_id INT NULL/);
    assert.doesNotMatch(code, /ALTER COLUMN\s+body/i);
    assert.doesNotMatch(code, /ALTER COLUMN\s+link/i);
  });

  it('agrega el CHECK canonico con validacion WITH CHECK', () => {
    assert.match(code, /WITH CHECK/);
    assert.match(
      code,
      /ADD CONSTRAINT CK_notifications_ticket_requires_org\s+CHECK\s*\(organization_id IS NOT NULL OR ticket_id IS NULL\)/,
    );
  });

  it('es idempotente y transaccional', () => {
    assert.match(code, /SET XACT_ABORT ON/);
    assert.match(code, /BEGIN TRANSACTION/);
    assert.match(code, /COMMIT TRANSACTION/);
    assert.match(code, /ROLLBACK TRANSACTION/);
    // Idempotencia: no ALTER si ya es NULL; no ADD si el CHECK ya existe.
    assert.match(code, /c\.is_nullable = 0/);
    assert.match(code, /CK_notifications_ticket_requires_org[\s\S]*?IF NOT EXISTS|IF NOT EXISTS[\s\S]*?CK_notifications_ticket_requires_org/);
  });

  it('no ejecuta cambios destructivos ni de datos', () => {
    assert.doesNotMatch(code, /\b(DELETE|UPDATE|INSERT|MERGE|TRUNCATE)\b/i);
    assert.doesNotMatch(code, /\bDROP\b/i);
    assert.doesNotMatch(code, /\bCREATE\s+INDEX\b/i);
  });
});

describe('fix M5 dbo.notifications: simulacion sin tocar la base', () => {
  it('el estado actual de M5 falla la validacion exactamente por los dos bloqueos', async () => {
    const current = catalogFromSchema(requiredSchema(), {
      forceNotNull: 'notifications.organization_id',
      dropConstraint: 'notifications.CK_notifications_ticket_requires_org',
    });
    const result = await validateMssqlSchema(catalogQuery(current));
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('notifications.organization_id') && e.includes('NOT NULL')),
      'debe reportar organization_id NOT NULL',
    );
    assert.ok(
      result.errors.some((e) => e.includes('CK_notifications_ticket_requires_org')),
      'debe reportar el CHECK faltante',
    );
    assert.equal(result.errors.length, 2, `solo se esperan 2 errores, no ${result.errors.length}`);
  });

  it('tras aplicar el fix (columna NULL + CHECK presente) la validacion pasa', async () => {
    const fixed = catalogFromSchema(requiredSchema());
    const result = await validateMssqlSchema(catalogQuery(fixed));
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });
});
