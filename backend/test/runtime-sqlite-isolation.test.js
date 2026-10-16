// Aislamiento del motor: importar `src/db/runtime.js` no debe abrir (ni crear)
// el archivo SQLite. SQL Server es el único motor, así que la fachada nunca debe
// tocar el sistema de archivos de una base local.
//
// Se comprueba con procesos hijos de verdad, no con simulaciones: cada uno fija
// DB_CLIENT=mssql y un DB_FILE propio en un directorio temporal, importa la
// fachada y reporta el motor y la ruta del archivo.
//
// No se ejecuta ninguna consulta en el hijo, así que jamás intenta conectar con
// SQL Server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'runtime-isolation.mjs');
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

// Ejecuta el fixture en un proceso nuevo con un entorno controlado. Nada de un
// `.env` se cuela: el hijo no usa --env-file y recibe el entorno explícito.
function ejecutar(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-motor-'));
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

describe('aislamiento del motor: importar el runtime no abre SQLite', () => {
  it('reporta el motor mssql y no crea el archivo SQLite', () => {
    const r = ejecutar({
      DB_CLIENT: 'mssql',
      DB_SERVER: 'servidor-de-prueba',
      DB_DATABASE: 'base-de-prueba',
      DB_USER: 'usuario',
      DB_PASSWORD: 'secreto',
    });
    const { engine, dbFile } = reportado(r);
    assert.equal(engine, 'mssql');
    assert.equal(dbFile, r.dbFile, 'el archivo configurado no es el del directorio temporal');
    assert.equal(
      fs.existsSync(r.dbFile),
      false,
      'importar el runtime abrió o creó el archivo SQLite',
    );
  });
});
