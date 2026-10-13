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

const afterGroupD = readCode('verify-after-groupD-scratch-test.sql');
const finalReconciliation = readCode('verify-final-reconciliation-scratch-test.sql');

const verifiers = [
  ['verify-after-groupD-scratch-test.sql', afterGroupD],
  ['verify-final-reconciliation-scratch-test.sql', finalReconciliation],
];

describe('verificadores scratch del grupo D: destino correcto', () => {
  for (const [name, code] of verifiers) {
    it(`${name} exige SIFHA_GroupD_ScratchTest en SIFHADEV`, () => {
      // La guarda debe apuntar a la base scratch (no a DEV): si exigiera DEV
      // abortaria contra el destino documentado y permitiria correr en DEV.
      assert.match(code, /DB_NAME\(\)/);
      assert.match(code, /SERVERPROPERTY\('InstanceName'\)/);
      assert.match(code, /UPPER\(N'SIFHA_GroupD_ScratchTest'\)/);
      assert.match(code, /UPPER\(ISNULL\(@inst, N''\)\) <> N'SIFHADEV'/);
      assert.doesNotMatch(code, /SIFHA_TICKETS_DEV/i);
      // Aborta (RETURN) si la identidad no coincide.
      assert.match(code, /RAISERROR\(N'ABORTADO:[\s\S]*?RETURN;/);
    });

    it(`${name} es 100% de solo lectura`, () => {
      assert.doesNotMatch(code, /\b(ALTER|DROP|CREATE|TRUNCATE|DELETE|UPDATE|INSERT|MERGE)\b/i);
    });
  }
});
