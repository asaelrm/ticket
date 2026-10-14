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

// Script de permisos minimos para SIFHA_Tickets_DEV. No es de solo lectura:
// concede pertenencia a roles de base, por lo que debe autoprotegerse por
// identidad y no escalar privilegios.
describe('grant-app-account-minimal.sql (permisos minimos DEV)', () => {
  const name = 'grant-app-account-minimal.sql';

  it('se protege por identidad (base + instancia + servidor)', () => {
    const code = readCode(name);
    assert.match(code, /N'SIFHA_TICKETS_DEV'/i);
    assert.match(code, /SIFHADEV/);
    assert.match(code, /DB_NAME\(\)/);
    assert.match(code, /SERVERPROPERTY\('InstanceName'\)/);
    assert.match(code, /RAISERROR\([\s\S]*?RETURN;/);
  });

  it('concede minimo privilegio de aplicacion (datareader + datawriter)', () => {
    const code = readCode(name);
    assert.match(code, /ALTER ROLE db_datareader ADD MEMBER/i);
    assert.match(code, /ALTER ROLE db_datawriter ADD MEMBER/i);
  });

  it('no concede db_owner, db_ddladmin, sysadmin ni securityadmin', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_owner\]?/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_ddladmin\]?/i);
    assert.doesNotMatch(code, /ALTER\s+SERVER\s+ROLE/i);
    assert.doesNotMatch(code, /\bdb_owner\b\s+ADD\s+MEMBER/i);
    assert.doesNotMatch(code, /\bdb_ddladmin\b\s+ADD\s+MEMBER/i);
  });

  it('no crea ni altera logins/usuarios (deja la creacion al administrador)', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /\bCREATE\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bALTER\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bCREATE\s+USER\b/i);
    assert.doesNotMatch(code, /\bDROP\s+/i);
  });

  it('usa QUOTENAME al componer SQL dinamico de ADD MEMBER', () => {
    const code = readCode(name);
    assert.match(code, /QUOTENAME\(/);
  });
});
