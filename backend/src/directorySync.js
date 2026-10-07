import fs from 'node:fs';
import crypto from 'node:crypto';
import db, { transaction } from './db.js';
import config from './config.js';
import { hashPassword } from './utils/password.js';
import { INITIAL_ORGANIZATION } from './seed.js';

// Snapshot del directorio de usuarios y departamentos.
//
// Regla que gobierna este archivo: AQUÍ NO VIAJAN CONTRASEÑAS. Se guarda el
// perfil de cada cuenta y nada más. Un fichero que se versiona, se copia o se
// comparte no debe contener hashes de contraseña, y un snapshot jamás puede
// cambiar una contraseña que ya está en la base de datos: si lo hiciera,
// cambiar una contraseña y reiniciar el sistema la devolvería a la anterior.
//
// La contraseña de una cuenta vive en un solo sitio, la tabla `users`. Para
// cambiarla están la ruta /api/auth/change-password y el restablecimiento con
// token; ninguna de las dos pasa por este archivo.
//
// La versión 2 eliminó los hashes. La versión 3 (ETAPA 2, aislamiento por
// organización) transporta también `organization_code` en departamentos y
// usuarios, de modo que al restaurar un directorio multiempresa ninguna cuenta
// quede huérfana ni se coloque en una organización equivocada. Un snapshot
// antiguo (sin organization_code) se restaura sobre la organización inicial.

const SNAPSHOT_VERSION = 3;

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
  const departments = db.prepare(`
    SELECT d.name, d.description, d.active, o.code AS organization_code
    FROM departments d
    LEFT JOIN organizations o ON o.id = d.organization_id
    ORDER BY d.name COLLATE NOCASE
  `).all();
  // Sin `password_hash`: es el motivo de existir de SNAPSHOT_VERSION 2. La
  // versión 3 incluye `organization_code` para preservar el aislamiento.
  const users = db.prepare(`
    SELECT u.name, u.last_name, u.username, u.email, u.position, u.active,
           u.last_password_change_at, d.name AS department_name, r.code AS role_code,
           o.code AS organization_code
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN organizations o ON o.id = u.organization_id
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
  const avisos = [];

  transaction(() => {
    const upsertDepartment = db.prepare(`
      INSERT INTO departments (name, description, active, organization_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, active = excluded.active, organization_id = excluded.organization_id
    `);
    const getDepartment = db.prepare('SELECT id, organization_id FROM departments WHERE name = ?');
    const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
    const getUser = db.prepare('SELECT id FROM users WHERE username = ?');
    const getOrg = db.prepare('SELECT id FROM organizations WHERE code = ?');
    const initialOrgId = getOrg.get(INITIAL_ORGANIZATION.code)?.id ?? null;

    // Resuelve la organización que transporta el snapshot. Un código que no
    // existe ABORTA el restore: es preferible fallar a fabricar una cuenta
    // huérfana o colocarla en una organización equivocada. Un snapshot antiguo
    // (sin organización) se asocia a la organización inicial.
    const resolverOrg = (code, contexto) => {
      if (code) {
        const row = getOrg.get(code);
        if (!row) throw new Error(`Organización desconocida en el archivo: ${code} (${contexto})`);
        return row.id;
      }
      return initialOrgId;
    };

    for (const department of departments) {
      upsertDepartment.run(
        department.name,
        department.description ?? null,
        department.active ? 1 : 0,
        resolverOrg(department.organization_code, `departamento "${department.name}"`)
      );
    }

    // El conflicto nunca toca `password_hash` ni `last_password_change_at`: la
    // contraseña y su fecha de cambio son propiedad exclusiva de la tabla users.
    // La versión 3 también restaura `organization_id` (autoritativa del
    // snapshot) para que el directorio devuelva cada cuenta a su organización.
    const upsertUser = db.prepare(`
      INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        name = excluded.name,
        last_name = excluded.last_name,
        email = excluded.email,
        department_id = excluded.department_id,
        position = excluded.position,
        role_id = excluded.role_id,
        active = excluded.active,
        organization_id = excluded.organization_id
    `);

    for (const user of users) {
      const role = getRole.get(user.role_code);
      if (!role) throw new Error(`Rol no encontrado en directory.json: ${user.role_code}`);

      // Un rol global se restaura sin organización.
      const orgId = role.code === 'SUPERADMIN' ? null : resolverOrg(user.organization_code, `usuario "${user.username}"`);

      // El departamento solo se asigna si coincide la organización del usuario:
      // nunca se coloca a nadie en un departamento de otra organización.
      let departmentId = null;
      if (user.department_name) {
        const department = getDepartment.get(user.department_name);
        if (department && department.organization_id === orgId) {
          departmentId = department.id;
        } else if (department) {
          avisos.push(`el departamento "${user.department_name}" no pertenece a la organización de "${user.username}": se restaura sin departamento`);
        }
      }

      const existe = getUser.get(user.username);
      if (existe) {
        // La contraseña no se envía: la que hay en la base de datos se queda.
        upsertUser.run(
          user.name,
          user.last_name,
          user.username,
          user.email,
          '',
          departmentId,
          user.position ?? '',
          role.id,
          user.active ? 1 : 0,
          user.last_password_change_at ?? null,
          orgId
        );
      } else {
        upsertUser.run(
          user.name,
          user.last_name,
          user.username,
          user.email,
          hashPassword(unusablePassword()),
          departmentId,
          user.position ?? '',
          role.id,
          user.active ? 1 : 0,
          user.last_password_change_at ?? null,
          orgId
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

  return { applied: true, departments: departments.length, users: users.length, nuevas, avisos };
}
