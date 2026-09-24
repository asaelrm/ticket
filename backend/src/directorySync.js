import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { transaction } from './db.js';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotFile = path.resolve(__dirname, '..', 'directory.json');

function isEnabled() {
  return config.env !== 'test';
}

export function saveDirectorySnapshot() {
  if (!isEnabled()) return;

  const departments = db.prepare(
    'SELECT name, description, active FROM departments ORDER BY name COLLATE NOCASE'
  ).all();
  const users = db.prepare(`
    SELECT u.name, u.last_name, u.username, u.email, u.password_hash, u.position, u.active,
           u.last_password_change_at, d.name AS department_name, r.code AS role_code
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY u.username COLLATE NOCASE
  `).all();

  fs.writeFileSync(snapshotFile, `${JSON.stringify({ version: 1, departments, users }, null, 2)}\n`);
}

export function restoreDirectorySnapshot() {
  if (!isEnabled() || !fs.existsSync(snapshotFile)) return;

  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const departments = Array.isArray(snapshot.departments) ? snapshot.departments : [];
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];

  transaction(() => {
    const upsertDepartment = db.prepare(`
      INSERT INTO departments (name, description, active) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, active = excluded.active
    `);
    const getDepartment = db.prepare('SELECT id FROM departments WHERE name = ?');
    const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
    const upsertUser = db.prepare(`
      INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        name = excluded.name,
        last_name = excluded.last_name,
        email = excluded.email,
        password_hash = excluded.password_hash,
        department_id = excluded.department_id,
        position = excluded.position,
        role_id = excluded.role_id,
        active = excluded.active,
        last_password_change_at = excluded.last_password_change_at
    `);

    for (const department of departments) {
      upsertDepartment.run(department.name, department.description ?? null, department.active ? 1 : 0);
    }

    for (const user of users) {
      const role = getRole.get(user.role_code);
      if (!role) throw new Error(`Rol no encontrado en directory.json: ${user.role_code}`);
      const department = user.department_name ? getDepartment.get(user.department_name) : null;
      upsertUser.run(
        user.name,
        user.last_name,
        user.username,
        user.email,
        user.password_hash,
        department?.id ?? null,
        user.position ?? '',
        role.id,
        user.active ? 1 : 0,
        user.last_password_change_at ?? null
      );
    }
  });
}
