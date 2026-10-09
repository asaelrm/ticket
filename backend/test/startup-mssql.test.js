// Arranque seguro: en modo MSSQL el servidor valida el esquema (solo lectura) y
// NUNCA migra, siembra, restaura la instantánea del directorio ni abre/crea el
// archivo SQLite. Si el esquema es incompatible, el servidor HTTP no se inicia.
//
// Todo se comprueba en procesos hijos reales con un contrato MSSQL FALSO en
// memoria (test/fixtures/mssql-catalog.mjs): no se abre ninguna conexión con SQL
// Server y no se toca ninguna base de datos. El caso SQLite sirve de control y
// usa el arranque real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'startup-mssql.mjs');
const dirsAbiertos = [];

after(() => {
  for (const dir of dirsAbiertos) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Si no se puede borrar, que no tumbe el resultado de las pruebas.
    }
  }
});

const MSSQL_ENV = {
  DB_CLIENT: 'mssql',
  MSSQL_RUNTIME: 'true',
  DB_SERVER: 'servidor-de-prueba',
  DB_DATABASE: 'base-de-prueba',
  DB_USER: 'usuario',
  DB_PASSWORD: 'secreto',
};

// Ejecuta el fixture en un proceso nuevo y controlado. El hijo no usa
// --env-file: recibe el entorno explícito, sin filtrar el `.env` del repo.
function ejecutar(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-arranque-'));
  dirsAbiertos.push(dir);
  const dbFile = path.join(dir, 'tickets.db');
  const snapshotFile = path.join(dir, 'directory.json');
  fs.writeFileSync(snapshotFile, JSON.stringify({ version: 3, departments: [], users: [] }));

  const r = spawnSync(process.execPath, [fixture], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '0',
      DATA_DIR: dir,
      UPLOAD_DIR: path.join(dir, 'uploads'),
      DB_FILE: dbFile,
      DIRECTORY_SYNC: 'true',
      DIRECTORY_SNAPSHOT_FILE: snapshotFile,
      ...extra,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { ...r, dbFile };
}

function reportado(r) {
  assert.equal(r.status, 0, `el proceso hijo falló:\n${r.stdout || ''}${r.stderr || ''}`);
  return JSON.parse(r.stdout.trim());
}

describe('arranque MSSQL: valida el esquema y no toca la base', () => {
  it('con esquema compatible arranca sin migrar, sin sembrar y sin crear SQLite', () => {
    const r = ejecutar(MSSQL_ENV);
    const out = reportado(r);
    assert.equal(out.engine, 'mssql');
    assert.equal(out.error, null);
    assert.equal(out.listenCalls.length, 1, 'debería abrir el puerto una vez');
    assert.equal(out.writes, 0, 'el arranque validó con escrituras; debería ser solo lectura');
    assert.equal(out.dbFileExists, false, 'el arranque MSSQL abrió o creó el archivo SQLite');
    assert.equal(
      fs.existsSync(r.dbFile),
      false,
      'el arranque MSSQL abrió o creó el archivo SQLite',
    );
  });

  it('no restaura la instantánea del directorio aunque esté habilitada', () => {
    const r = ejecutar(MSSQL_ENV);
    const out = reportado(r);
    assert.equal(out.snapshotApplied, false);
    assert.equal(out.writes, 0, 'restaurar la instantánea implicaría escrituras');
  });

  it('una tabla faltante impide arrancar el servidor HTTP', () => {
    const r = ejecutar({
      ...MSSQL_ENV,
      STARTUP_TEST_MUTATION: JSON.stringify({ dropTable: 'teams' }),
    });
    const out = reportado(r);
    assert.equal(out.listenCalls.length, 0, 'no debería abrir el puerto');
    assert.equal(out.dbFileExists, false);
    assert.match(out.error, /falta la tabla dbo\.teams/);
  });

  it('una columna faltante impide arrancar el servidor HTTP', () => {
    const r = ejecutar({
      ...MSSQL_ENV,
      STARTUP_TEST_MUTATION: JSON.stringify({ dropColumn: 'tickets.organization_id' }),
    });
    const out = reportado(r);
    assert.equal(out.listenCalls.length, 0);
    assert.match(out.error, /falta la columna dbo\.tickets\.organization_id/);
  });

  it('una restricción esencial faltante impide arrancar el servidor HTTP', () => {
    const r = ejecutar({
      ...MSSQL_ENV,
      STARTUP_TEST_MUTATION: JSON.stringify({
        dropConstraint: 'team_members.FK_team_members_team_same_org',
      }),
    });
    const out = reportado(r);
    assert.equal(out.listenCalls.length, 0);
    assert.match(out.error, /FK_team_members_team_same_org/);
  });

  it('una nulabilidad incompatible impide arrancar el servidor HTTP', () => {
    const r = ejecutar({
      ...MSSQL_ENV,
      STARTUP_TEST_MUTATION: JSON.stringify({ forceNullable: 'team_members.organization_id' }),
    });
    const out = reportado(r);
    assert.equal(out.listenCalls.length, 0);
    assert.match(out.error, /team_members\.organization_id/);
    assert.match(out.error, /NOT NULL/);
  });

  it('los objetos de más no impiden arrancar', () => {
    const r = ejecutar({
      ...MSSQL_ENV,
      STARTUP_TEST_MUTATION: JSON.stringify({ addTable: 'audit_extra' }),
    });
    const out = reportado(r);
    assert.equal(out.error, null);
    assert.equal(out.listenCalls.length, 1);
  });
});

describe('arranque SQLite: control, conserva el comportamiento de siempre', () => {
  it('migra, siembra y abre el archivo SQLite', () => {
    const r = ejecutar({ DB_CLIENT: 'sqlite', MSSQL_RUNTIME: '' });
    const out = reportado(r);
    assert.equal(out.engine, 'sqlite');
    assert.equal(out.error, null);
    assert.equal(out.listenCalls.length, 1);
    assert.equal(out.dbFileExists, true, 'SQLite debería abrir/crear el archivo');
  });
});

describe('server.js: el arranque SQLite no se evalúa al importar en modo MSSQL', () => {
  it('no importa estáticamente db.js, seed.js ni directorySync.js', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.doesNotMatch(source, /^\s*import[\s\S]*?from\s+['"]\.\/db\.js['"]/m);
    assert.doesNotMatch(source, /^\s*import[\s\S]*?from\s+['"]\.\/seed\.js['"]/m);
    assert.doesNotMatch(source, /^\s*import[\s\S]*?from\s+['"]\.\/directorySync\.js['"]/m);
  });
});
