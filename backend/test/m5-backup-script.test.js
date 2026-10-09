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

const backup = readCode('backup-m5.sql');
const readonly = readCode('m5-notifications-readonly.sql');

describe('backup M5: script exclusivo y no destructivo', () => {
  it('se declara exclusivo de SIFHA_Tickets_M5_Validation en TI-DESK-01\\SIFHADEV', () => {
    assert.match(backup, /SIFHA_Tickets_M5_Validation/);
    assert.match(backup, /TI-DESK-01\\SIFHADEV/);
    assert.match(backup, /SERVERPROPERTY\('ServerName'\)/);
    assert.match(backup, /SERVERPROPERTY\('InstanceName'\)/);
    assert.match(backup, /DB_NAME\(\)/);
    assert.match(backup, /ABORTADO:[\s\S]*?RETURN;/);
  });

  it('nunca toca SIFHA_Tickets_DEV', () => {
    assert.doesNotMatch(backup, /SIFHA_Tickets_DEV/i);
  });

  it('usa COPY_ONLY, CHECKSUM, COMPRESSION e INIT', () => {
    assert.match(backup, /COPY_ONLY/);
    assert.match(backup, /CHECKSUM/);
    assert.match(backup, /COMPRESSION/);
    assert.match(backup, /\bINIT\b/);
  });

  it('genera un nombre unico con fecha y hora', () => {
    assert.match(backup, /SIFHA_Tickets_M5_Validation_FULL_/);
    assert.match(backup, /CONVERT\(NVARCHAR\(8\),\s*@now,\s*112\)/);
    assert.match(backup, /CONVERT\(NVARCHAR\(8\),\s*@now,\s*108\)/);
  });

  it('no sobrescribe respaldos: aborta si el archivo existe', () => {
    assert.match(backup, /xp_fileexist/);
    assert.match(backup, /@file_exists = 1/);
  });

  it('solo usa RESTORE VERIFYONLY (no restaura datos)', () => {
    assert.match(backup, /RESTORE VERIFYONLY/);
    assert.doesNotMatch(backup, /RESTORE\s+DATABASE/i);
    assert.doesNotMatch(backup, /WITH\s+RECOVERY/i);
  });

  it('no ejecuta operaciones destructivas ni de datos', () => {
    assert.doesNotMatch(backup, /\b(ALTER|DROP|TRUNCATE|DELETE|UPDATE|MERGE)\b/i);
    // Se permite INSERT INTO @tabla_variable (captura de xp_fileexist), pero no
    // inserciones en tablas reales.
    assert.doesNotMatch(backup, /\bINSERT\s+INTO\s+(?!@)/i);
  });
});

describe('comprobaciones M5: script de solo lectura', () => {
  it('se declara exclusivo de la base autorizada', () => {
    assert.match(readonly, /SIFHA_Tickets_M5_Validation/);
    assert.match(readonly, /TI-DESK-01\\SIFHADEV/);
    assert.match(readonly, /ABORTADO:[\s\S]*?RETURN;/);
  });

  it('solo lee: ninguna operacion que modifique datos o esquema', () => {
    assert.doesNotMatch(readonly, /\b(ALTER|DROP|CREATE|TRUNCATE|DELETE|UPDATE|INSERT|MERGE)\b/i);
  });

  it('incluye la huella y el estado del esquema', () => {
    assert.match(readonly, /CHECKSUM_AGG/);
    assert.match(readonly, /ISNULL\(organization_id,\s*-1\)/);
    assert.match(readonly, /is_nullable/);
    assert.match(readonly, /CK_notifications_ticket_requires_org/);
  });
});
