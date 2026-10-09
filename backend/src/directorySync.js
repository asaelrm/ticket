import fs from 'node:fs';
import crypto from 'node:crypto';
import runtime from './db/runtime.js';
import config from './config.js';
import { hashPassword } from './utils/password.js';
import { INITIAL_ORGANIZATION } from './orgConstants.js';

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

export async function saveDirectorySnapshot({ enabled, file } = {}) {
  if (!isEnabled({ enabled })) return false;

  const target = file || config.directory.snapshotFile;
  const departments = await runtime.queryMany(`
    SELECT d.name, d.description, d.active, o.code AS organization_code
    FROM departments d
    LEFT JOIN organizations o ON o.id = d.organization_id
    ORDER BY d.name COLLATE NOCASE
  `);
  // Sin `password_hash`: es el motivo de existir de SNAPSHOT_VERSION 2. La
  // versión 3 incluye `organization_code` para preservar el aislamiento.
  const users = await runtime.queryMany(`
    SELECT u.name, u.last_name, u.username, u.email, u.position, u.active,
           u.last_password_change_at, d.name AS department_name, r.code AS role_code,
           o.code AS organization_code
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN organizations o ON o.id = u.organization_id
    ORDER BY u.username COLLATE NOCASE
  `);

  fs.writeFileSync(target, `${JSON.stringify({ version: SNAPSHOT_VERSION, departments, users }, null, 2)}\n`);
  return true;
}

export async function restoreDirectorySnapshot({ enabled, file } = {}) {
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

  // Todo el restore vive en una única transacción del runtime: si algo falla
  // (organización desconocida, departamento sin organización válida, conflicto
  // de username/email) se revierte por completo. No puede quedar ninguna cuenta
  // huérfana ni ningún departamento a medio insertar.
  await runtime.transaction(async (tx) => {
    const findOrgId = async (code) => {
      const row = await tx.queryOne('SELECT id FROM organizations WHERE code = ?', code);
      return row ? row.id : null;
    };
    const initialOrgId = await findOrgId(INITIAL_ORGANIZATION.code);

    // Se valida ANTES de insertar: toda organización referenciada por el
    // snapshot (en departamentos o usuarios) tiene que existir. Un código
    // desconocido aborta sin tocar la base.
    const orgCache = new Map();
    const referenced = new Set();
    for (const department of departments) {
      if (department.organization_code) referenced.add(department.organization_code);
    }
    for (const user of users) {
      if (user.organization_code) referenced.add(user.organization_code);
    }
    for (const code of referenced) {
      const id = await findOrgId(code);
      if (id == null) throw new Error(`Organización desconocida en el archivo: ${code}`);
      orgCache.set(code, id);
    }

    // Resuelve la organización que transporta el snapshot. Un código que no
    // existe ABORTA el restore: es preferible fallar a fabricar una cuenta
    // huérfana o colocarla en una organización equivocada. Un snapshot antiguo
    // (sin organización) se asocia a la organización inicial.
    const resolverOrg = (code, contexto) => {
      if (!code) return initialOrgId;
      const id = orgCache.get(code);
      if (id == null) throw new Error(`Organización desconocida en el archivo: ${code} (${contexto})`);
      return id;
    };

    // Departamentos: se resuelven SIEMPRE por (organization_id, name), nunca
    // solo por nombre. Así un departamento homónimo de otra organización no se
    // reutiliza ni se le cambia la organización al restaurar.
    for (const department of departments) {
      const orgId = resolverOrg(department.organization_code, `departamento "${department.name}"`);
      if (orgId == null) {
        throw new Error(`El departamento "${department.name}" no tiene una organización válida`);
      }
      const existing = await tx.queryOne(
        'SELECT id FROM departments WHERE organization_id = ? AND name = ?',
        orgId,
        department.name
      );
      if (existing) {
        await tx.execute(
          'UPDATE departments SET description = ?, active = ? WHERE id = ?',
          department.description ?? null,
          department.active ? 1 : 0,
          existing.id
        );
      } else {
        await tx.execute(
          'INSERT INTO departments (name, description, active, organization_id) VALUES (?, ?, ?, ?)',
          department.name,
          department.description ?? null,
          department.active ? 1 : 0,
          orgId
        );
      }
    }

    // El restore nunca toca `password_hash` ni `last_password_change_at`: la
    // contraseña y su fecha de cambio son propiedad exclusiva de la tabla users.
    // La versión 3 restaura `organization_id` (autoritativa del snapshot).
    for (const user of users) {
      const role = await tx.queryOne('SELECT id, code FROM roles WHERE code = ?', user.role_code);
      if (!role) throw new Error(`Rol no encontrado en directory.json: ${user.role_code}`);

      // Un rol global se restaura sin organización.
      const orgId = role.code === 'SUPERADMIN'
        ? null
        : resolverOrg(user.organization_code, `usuario "${user.username}"`);

      // El departamento solo se asigna si existe en la MISMA organización del
      // usuario: nunca se coloca a nadie en un departamento de otra organización.
      let departmentId = null;
      if (user.department_name) {
        const propio = orgId == null
          ? null
          : await tx.queryOne(
              'SELECT id FROM departments WHERE organization_id = ? AND name = ?',
              orgId,
              user.department_name
            );
        if (propio) {
          departmentId = propio.id;
        } else {
          const ajeno = await tx.queryOne('SELECT id FROM departments WHERE name = ?', user.department_name);
          if (ajeno) {
            avisos.push(`el departamento "${user.department_name}" no pertenece a la organización de "${user.username}": se restaura sin departamento`);
          }
        }
      }

      // La identidad es el `username`. Un `email` ya usado por OTRA cuenta
      // aborta el restore en vez de fusionar cuentas equivocadas.
      const porUsername = await tx.queryOne('SELECT id FROM users WHERE username = ?', user.username);
      const porEmail = await tx.queryOne('SELECT username FROM users WHERE email = ?', user.email);
      if (porEmail && porEmail.username !== user.username) {
        throw new Error(
          `El correo "${user.email}" de "${user.username}" ya pertenece a la cuenta "${porEmail.username}"`
        );
      }

      if (porUsername) {
        // La contraseña y su fecha de cambio se quedan como están.
        await tx.execute(
          `UPDATE users SET name = ?, last_name = ?, email = ?, department_id = ?, position = ?,
           role_id = ?, active = ?, organization_id = ? WHERE id = ?`,
          user.name,
          user.last_name,
          user.email,
          departmentId,
          user.position ?? '',
          role.id,
          user.active ? 1 : 0,
          orgId,
          porUsername.id
        );
      } else {
        await tx.execute(
          `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
