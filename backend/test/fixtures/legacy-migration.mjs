// Proceso hijo para test/migration-orgs-legacy.test.js: construye una base
// PRE-multiempresa (una instalación real anterior a ETAPA 1A/2), aplica las
// migraciones y el seed actuales sobre ella y devuelve por stdout un JSON con
// el resultado de la verificación. No importa app.js ni toca la base de las
// demás pruebas: usa su propio DB_FILE, que llega por entorno.

import { DatabaseSync } from 'node:sqlite';

const dbFile = process.env.DB_FILE;

// 1) Base legacy: users y departments SIN organization_id (no existe la tabla
//    organizations todavía) más los mínimos con los que convive (roles).
const legacy = new DatabaseSync(dbFile);
legacy.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    position TEXT,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    last_password_change_at TEXT,
    password_reset_token TEXT,
    password_reset_expires TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT
  );
  INSERT INTO roles (code, name, description, active) VALUES ('ADMIN', 'Administrador', 'legacy', 1);
  INSERT INTO departments (name, description, active) VALUES
    ('IRH Legacy', 'historico', 1),
    ('TI Legacy', 'historico', 1);
  INSERT INTO users (name, last_name, username, email, password_hash, role_id, active)
  VALUES ('Admin', 'Legacy', 'admin', 'admin@empresa.com', 'hash-de-prueba', 1, 1);
`);
legacy.close();

// 2) Migraciones y seed reales sobre esa base (DB_FILE ya está fijado).
const { runMigrations } = await import('../../src/db.js');
const { seed } = await import('../../src/seed.js');
runMigrations();
seed();
seed(); // idempotencia

const db = (await import('../../src/db.js')).default;

const cols = db.prepare('PRAGMA table_info(departments)').all().map((c) => c.name);
const uce = db.prepare('SELECT id FROM organizations WHERE code = ?').get('UCE');
const depts = db.prepare('SELECT name, organization_id FROM departments ORDER BY name').all();
const adminOrg = db.prepare('SELECT organization_id FROM users WHERE username = ?').get('admin').organization_id;
const usersTotal = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

// La columna es una FK real: un departamento con organización inexistente debe
// fallar con la constraint (PRAGMA foreign_keys = ON que activa db.js).
let fkOk = false;
try {
  db.prepare('INSERT INTO departments (name, organization_id) VALUES (?, ?)').run('FK invalida', 999999);
  db.prepare('DELETE FROM departments WHERE name = ?').run('FK invalida');
} catch {
  fkOk = true;
}

console.log(JSON.stringify({
  cols,
  uceId: uce?.id ?? null,
  depts,
  nombresLegacy: depts.filter((d) => d.name.endsWith('Legacy')).map((d) => d.name),
  adminOrg,
  usersTotal,
  hasColumn: cols.includes('organization_id'),
  legacyBackfill: depts.filter((d) => d.name.endsWith('Legacy')).every((d) => d.organization_id === uce?.id),
  userBackfill: adminOrg === uce?.id,
  fkOk,
}));