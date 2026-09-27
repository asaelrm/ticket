import fs from 'node:fs';
import crypto from 'node:crypto';
import db, { transaction } from './db.js';
import config from './config.js';
import { hashPassword } from './utils/password.js';

// Snapshot del directorio de usuarios y departamentos.
//
// Regla que gobierna este archivo: AQUÍ NO VIAJAN CONTRASEÑAS. Se guarda el
// perfil de cada cuenta y nada más. Un fichero que se versiona, se copia o se
// comparte no debe contener hashes de contraseña, y un snapshotjamás puede
// cambiar una contraseña que ya está en la base de datos: si lo hiciera,
// cambiar una contraseña y reiniciar el sistema la devolvería a la anterior.
//
// La contraseña de una cuenta vive en un solo sitio, la tabla `users`. Para
// cambiarla están la ruta /api/auth/change-password y el restablecimiento con
// token; ninguna de las dos pasa por este archivo.

const SNAPSHOT_VERSION = 2;

// Se puede desactivar entero (DIRECTORY_SYNC=false) y apuntar a otro fichero
// (DIRECTORY_SNAPSHOT_FILE). Durante `node --test` queda apagado solo, porque el
// entorno es `test`; las pruebas lo encienden con `enabled` explícito y escriben
// en un fichero temporal, nunca en el archivo real.
function isEnabled({ enabled = config.directory.sync && config.env !== 'test' } = {}) {
  return Boolean(enabled);
}

// Contraseña aleatoria e inutilizable, para dar de alta en la base de datos una
// cuenta que solo existe en el directorio. Nadie puede entrar con una contraseña
// conocida: un administrador tiene que restablecerla.
function unusablePassword() {
  return crypto.randomBytes(32).toString('base64url');
}

export function saveDirectorySnapshot({ enabled, file } = {}) {
  if (!isEnabled({ enabled })) return false;

  const target = file || config.directory.snapshotFile;
  const departments = db.prepare(
    'SELECT name, description, active FROM departments ORDER BY name COLLATE NOCASE'
  ).all();
  // Sin `password_hash`: es el motivo de existir de SNAPSHOT_VERSION 2.
  const users = db.prepare(`
    SELECT u.name, u.last_name, u.username, u.email, u.position, u.active,
           u.last_password_change_at, d.name AS department_name, r.code AS role_code
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY u.username COLLATE NOCASE
  `).all();

  fs.writeFileSync(target, `${JSON.stringify({ version: SNAPSHOT_VERSION, departments, users }, null, 2)}\n`);
  return true;
}

export function restoreDirectorySnapshot({ enabled, file } = {}) {
  if (!isEnabled({ enabled })) return { applied: false, reason: 'desactivado' };

  const source = file || config.directory.snapshotFile;
  if (!fs.existsSync(source)) return { applied: false, reason: 'sin archivo' };

  const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
  const departments = Array.isArray(snapshot.departments) ? snapshot.departments : [];
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];

  // Un snapshot de una versión anterior traía los hashes. Se leen, se ignoran y
  // se avisa: este archivo no vuelve a escribir contraseñas.
  if (users.some((user) => user.password_hash)) {
    console.warn(
      '[directorio] El archivo contiene "password_hash" de una versión antigua: se ignoran. ' +
        'Regenere el archivo con el backend actualizado (cualquier cambio de usuario o ' +
        'departamento lo reescribe sin hashes).'
    );
  }

  const nuevas = [];

  transaction(() => {
    const upsertDepartment = db.prepare(`
      INSERT INTO departments (name, description, active) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, active = excluded.active
    `);
    const getDepartment = db.prepare('SELECT id FROM departments WHERE name = ?');
    const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
    const getUser = db.prepare('SELECT id FROM users WHERE username = ?');

    // El conflicto nunca toca `password_hash` ni `last_password_change_at`: la
    // contraseña y su fecha de cambio son propiedad exclusiva de la tabla users.
    const upsertUser = db.prepare(`
      INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        name = excluded.name,
        last_name = excluded.last_name,
        email = excluded.email,
        department_id = excluded.department_id,
        position = excluded.position,
        role_id = excluded.role_id,
        active = excluded.active
    `);

    for (const department of departments) {
      upsertDepartment.run(department.name, department.description ?? null, department.active ? 1 : 0);
    }

    for (const user of users) {
      const role = getRole.get(user.role_code);
      if (!role) throw new Error(`Rol no encontrado en directory.json: ${user.role_code}`);
      const department = user.department_name ? getDepartment.get(user.department_name) : null;

      const existe = getUser.get(user.username);
      if (existe) {
        // La contraseña no se envía: la que hay en la base de datos se queda.
        upsertUser.run(
          user.name,
          user.last_name,
          user.username,
          user.email,
          '',
          department?.id ?? null,
          user.position ?? '',
          role.id,
          user.active ? 1 : 0,
          user.last_password_change_at ?? null
        );
      } else {
        upsertUser.run(
          user.name,
          user.last_name,
          user.username,
          user.email,
          hashPassword(unusablePassword()),
          department?.id ?? null,
          user.position ?? '',
          role.id,
          user.active ? 1 : 0,
          user.last_password_change_at ?? null
        );
        nuevas.push(user.username);
      }
    }
  });

  if (nuevas.length) {
    console.warn(
      `[directorio] Cuentas nuevas sin contraseña conocida: ${nuevas.join(', ')}. ` +
        'Se han creado con una contraseña aleatoria: un administrador debe ' +
        'restablecerlas (usuario > restablecer contraseña) antes de que puedan entrar.'
    );
  }

  return { applied: true, departments: departments.length, users: users.length, nuevas };
}
