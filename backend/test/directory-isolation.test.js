// Aislamiento del directorio: importar `src/directorySync.js` no debe abrir (ni
// crear) ningún archivo SQLite. SQL Server es el único motor y la sincronización
// del directorio no debe depender de una base local.
//
// Antes, directorySync importaba INITIAL_ORGANIZATION de src/seed.js, que abría
// SQLite al evaluarse: importar el directorio creaba el archivo. Ahora esa
// constante vive en src/orgConstants.js, sin motor.
//
// Se comprueba con procesos hijos reales. El hijo no ejecuta consultas, así que
// jamás intenta conectar con SQL Server.
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

describe('aislamiento del directorio: importar directorySync no abre SQLite', () => {
  it('no crea el archivo SQLite', () => {
    const r = ejecutar({
      DB_CLIENT: 'mssql',
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
      'importar directorySync abrió o creó el archivo SQLite',
    );
  });
});
