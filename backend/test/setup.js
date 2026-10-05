// Se carga con `node --import` antes que cualquier prueba, una vez por cada
// archivo de test (node --test usa un proceso por archivo).
//
// Hasta ahora las pruebas NO tenían base de datos propia: importan app.js, que
// no aplica migraciones ni seed, así que se apoyaban en
// backend/data/tickets.db con lo que hubiera en ese momento. Dos consecuencias:
// si alguien cambiaba la contraseña de una cuenta demo, la suite fallaba; y al
// ejecutarla se escribían tickets y sesiones de verdad en la base real.
//
// Aquí la base se crea vacía, se migra y se siembra en un directorio temporal
// que se borra al terminar, de modo que ejecutar la suite nunca toca la real.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pruebas-'));

// Estas variables se fijan antes de que se importe config.js, que es quien las
// lee. config resuelve DATA_DIR contra la raíz del backend, así que basta una
// ruta relativa.
process.env.DATA_DIR = dir;
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
// La instantánea del directorio se resuelve contra la raíz del backend, no
// contra DATA_DIR: si no se indica, la suite escribiría backend/directory.json.
process.env.DIRECTORY_SNAPSHOT_FILE = path.join(dir, 'directory.json');
// Esta suite es la suite de SQLite y lo dice de forma explícita, en vez de
// depender del .env de quien la lanza. Sin esto, un .env con DB_CLIENT=mssql
// hacía que el `runMigrations()` de abajo lanzara y se caía entero el archivo
// de pruebas. Que `mssql` sea un valor admitido se comprueba en config.js y en
// db-contract.test.js, no aquí.
process.env.DB_CLIENT = 'sqlite';
// La integración contra SQL Server DEV hace DML (crea y borra fixtures), así que
// no puede colgarse de la suite de SQLite. Para ejecutarla hay que pedirla
// explícitamente y sin este arranque:
//   node --test --env-file-if-exists=.env test/mssql-integration.test.js
process.env.RUN_MSSQL_INTEGRATION = '0';
// Las pruebas necesitan las cuentas que usa el resto de la suite, y el seed ya
// no inventa ninguna: se las pide explícitamente con contraseñas de fixture que
// solo existen aquí. Además, el resultado no puede depender del NODE_ENV de
// quien lanza la suite.
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'ticket-pruebas';
process.env.SEED_ADMIN_PASSWORD = '123456';
process.env.SEED_DEMO_ACCOUNTS = 'true';
process.env.SEED_DEMO_PASSWORD = 'Empleado1234!';
process.env.SEED_TECH_PASSWORD = 'Tecnico1234!';

const { runMigrations } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');

runMigrations();
seed();

process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Si no se puede borrar, que no tumbe el resultado de las pruebas.
  }
});
