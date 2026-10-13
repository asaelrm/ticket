import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(here, '..', 'scripts', 'migration');

function readCode(name) {
  const raw = fs.readFileSync(path.join(migrationDir, name), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

// Preflight/inventario/verificadores destinados a SIFHA_Tickets_DEV. Todos son
// de solo lectura y deben autoprotegerse por identidad antes de leer nada.
const devReadonlyScripts = [
  'reconcile-dev-inventory.sql',
  'verify-after-groupB.sql',
  'verify-after-groupC.sql',
  'verify-after-groupD.sql',
  'verify-final-reconciliation.sql',
  'diagnose-dev-account-readonly.sql',
];

describe('scripts de solo lectura de SIFHA_Tickets_DEV', () => {
  for (const name of devReadonlyScripts) {
    it(`${name} se protege por identidad (base + instancia)`, () => {
      const code = readCode(name);
      assert.match(code, /N'SIFHA_TICKETS_DEV'/i);
      assert.match(code, /UPPER\(/);
      assert.match(code, /SIFHADEV/);
      assert.match(code, /DB_NAME\(\)/);
      assert.match(code, /SERVERPROPERTY\('InstanceName'\)/);
      assert.match(code, /RAISERROR\([\s\S]*?RETURN;/);
    });

    it(`${name} no ejecuta escrituras persistentes`, () => {
      const code = readCode(name);
      // Sentencias de escritura/DDL al inicio de una linea (fuera de comentarios
      // y de cadenas de SQL dinamico).
      assert.doesNotMatch(code, /^[ \t]*(ALTER|DROP|TRUNCATE|DELETE|UPDATE|MERGE|CREATE)\b/im);
      // INSERT solo permitido sobre variables de tabla (@...); nada sobre dbo.*.
      assert.doesNotMatch(code, /^[ \t]*INSERT\s+INTO\s+(?!@)/im);
    });
  }

  it('diagnose-dev-account-readonly.sql no usa SQL dinamico', () => {
    const code = readCode('diagnose-dev-account-readonly.sql');
    assert.doesNotMatch(code, /\bEXEC\b/i);
    assert.doesNotMatch(code, /sp_executesql/i);
  });
});
