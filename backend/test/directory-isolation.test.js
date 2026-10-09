// Aislamiento del directorio: importar `src/directorySync.js` no debe abrir (ni
// crear) el archivo SQLite cuando el motor real es MSSQL.
//
// Antes, directorySync importaba INITIAL_ORGANIZATION de src/seed.js, que abre
// SQLite al evaluarse: importar el directorio en modo MSSQL creaba el archivo.
// Ahora esa constante vive en src/orgConstants.js, sin motor.
//
// Se comprueba con procesos hijos reales. El caso SQLite sirve de control: ahí
// el archivo SÍ tiene que existir, de modo que la prueba no pueda pasar por el
// simple hecho de no crear nunca el archivo. El hijo no ejecuta consultas, así
// que el caso MSSQL jamás intenta conectar con SQL Server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'directory-isolation.mjs');
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

function ejecutar(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-directorio-motor-'));
  dirsAbiertos.push(dir);
  const dbFile = path.join(dir, 'tickets.db');
  const r = spawnSync(process.execPath, [fixture], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dir,
      UPLOAD_DIR: path.join(dir, 'uploads'),
      DB_FILE: dbFile,
      DIRECTORY_SYNC: 'false',
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

describe('aislamiento del directorio: importar directorySync no abre SQLite en modo MSSQL', () => {
  it('en modo MSSQL no crea el archivo SQLite', () => {
    const r = ejecutar({
      DB_CLIENT: 'mssql',
      MSSQL_RUNTIME: 'true',
      DB_SERVER: 'servidor-de-prueba',
      DB_DATABASE: 'base-de-prueba',
      DB_USER: 'usuario',
      DB_PASSWORD: 'secreto',
    });
    const { dbFile } = reportado(r);
    assert.equal(dbFile, r.dbFile, 'el archivo configurado no es el del directorio temporal');
    assert.equal(
      fs.existsSync(r.dbFile),
      false,
      'importar directorySync en modo MSSQL abrió o creó el archivo SQLite',
    );
  });

  it('en modo SQLite sí abre el archivo (control)', () => {
    const r = ejecutar({ DB_CLIENT: 'sqlite', MSSQL_RUNTIME: '' });
    const { dbFile } = reportado(r);
    assert.equal(dbFile, r.dbFile);
    assert.equal(
      fs.existsSync(r.dbFile),
      true,
      'importar directorySync en modo SQLite debería abrir/crear el archivo',
    );
  });
});
