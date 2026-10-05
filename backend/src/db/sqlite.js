import { DatabaseSync } from 'node:sqlite';

// Mantiene la configuración SQLite actual aislada de la fachada pública de
// db.js. En A1 SQLite es el único proveedor real y esta función devuelve la
// misma API DatabaseSync que ya consumen las rutas.
export function createSqliteDatabase(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
