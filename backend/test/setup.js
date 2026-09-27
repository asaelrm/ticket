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
// Las pruebas necesitan las cuentas demo del seed, que solo se crean fuera de
// producción. Se fija de forma explícita para que el resultado no dependa del
// NODE_ENV de quien lanza la suite.
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'ticket-pruebas';

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
