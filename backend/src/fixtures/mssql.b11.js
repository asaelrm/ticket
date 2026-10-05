// B11-B1: descriptor de los fixtures sintéticos de B11 para SQL Server DEV.
//
// Este módulo es PURO: no lee config.js, no abre conexión, no escribe en disco
// salvo el manifiesto y nunca imprime una contraseña ni un hash. Lo comparten el
// script administrativo (src/scripts/mssql-b11-fixtures.sql, ejecutado a mano
// desde SSMS con Windows Authentication), el generador del hash
// (src/scripts/mssql-b11-password.mjs) y la prueba HTTP
// (test/mssql-auth-http.integration.mjs) para que todos deriven exactamente las
// mismas cuentas a partir del mismo marcador.
//
// Nada de esto son secretos reales: son cuentas sintéticas de una base DEV que se
// borran al terminar. Aun así, la contraseña se genera al azar en memoria y solo
// viaja en un manifiesto temporal fuera del repositorio.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Barrera 1: además del nombre, el script exige que la base se identifique como
// no productiva. Un PROD con sufijo accidental no pasa el segundo filtro.
export const B11_EXPECTED_DATABASE = 'SIFHA_Tickets_DEV';
export const B11_EMAIL_DOMAIN = 'example.invalid';

// Los tres roles de B11. ADMIN, EMPLOYEE y TECHNICIAN quedan fuera a propósito:
// son los roles reales de la aplicación y esta fase no los toca.
export const B11_ROLE_MANAGER = 'B11_ROLE_MANAGER';
export const B11_ROLE_NO_MANAGE = 'B11_ROLE_NO_MANAGE';
export const B11_TARGET_ROLE = 'B11_TARGET_ROLE';
export const B11_ROLE_CODES = [B11_ROLE_MANAGER, B11_ROLE_NO_MANAGE, B11_TARGET_ROLE];

// La cadena que el usuario exige para obtener role.manage:
//   users.role_id -> roles.id -> role_permissions.role_id -> permissions.id -> code
// `dashboard.view` existe solo para que el usuario sin permiso TENGA un permiso
// real y siga recibiendo 403: si no tuviera ninguno, el 403 no probaría que
// requirePermission filtra por código, sino que el rol estaba vacío.
export const B11_PERMISSION_ROLE_MANAGE = 'role.manage';
export const B11_PERMISSION_NO_MANAGE = 'dashboard.view';
export const B11_PERMISSION_CODES = [B11_PERMISSION_ROLE_MANAGE, B11_PERMISSION_NO_MANAGE];

// B11_TARGET_ROLE no recibe ningún permiso: es el rol neutro, se usa para el
// usuario inactivo y queda reservado como destino de un PATCH en una fase
// posterior. Sin permisos, un 403 sobre él tampoco prueba nada.
export const B11_ROLE_PERMISSIONS = {
  [B11_ROLE_MANAGER]: [B11_PERMISSION_ROLE_MANAGE],
  [B11_ROLE_NO_MANAGE]: [B11_PERMISSION_NO_MANAGE],
  [B11_TARGET_ROLE]: [],
};

/**
 * Marcador corto, inequívoco y único por ejecución. Solo [a-z0-9-], así que es
 * seguro como fragmento de NVARCHAR y como parte de un nombre de fichero.
 */
export function createMarker() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z').toLowerCase();
  return `b11b1-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Contraseña sintética aleatoria de 32 caracteres. Se genera UNA vez por
 * ejecución y la comparten las tres cuentas: son cuentas de prueba que existen
 * solo mientras duren los fixtures.
 */
export function createFixturePassword() {
  return `B11!${crypto.randomBytes(21).toString('base64url')}`;
}

export function userNames(marker) {
  return {
    manager: `b11-manager-${marker}`,
    noManage: `b11-no-manage-${marker}`,
    inactive: `b11-inactive-${marker}`,
  };
}

export function emails(marker) {
  const names = userNames(marker);
  return {
    manager: `${names.manager}@${B11_EMAIL_DOMAIN}`,
    noManage: `${names.noManage}@${B11_EMAIL_DOMAIN}`,
    inactive: `${names.inactive}@${B11_EMAIL_DOMAIN}`,
  };
}

/**
 * Descriptor completo de los fixtures. `password` se genera aquí y en ningún
 * momento se escribe en el código ni se imprime: viaja solo dentro del
 * manifiesto temporal.
 */
export function describeFixtures(marker, { password = createFixturePassword() } = {}) {
  const names = userNames(marker);
  const mail = emails(marker);
  return {
    marker,
    password,
    database: B11_EXPECTED_DATABASE,
    roleCodes: B11_ROLE_CODES,
    permissionCodes: B11_PERMISSION_CODES,
    users: [
      {
        key: 'manager',
        username: names.manager,
        email: mail.manager,
        roleCode: B11_ROLE_MANAGER,
        active: true,
        expectedPermissions: B11_ROLE_PERMISSIONS[B11_ROLE_MANAGER],
      },
      {
        key: 'noManage',
        username: names.noManage,
        email: mail.noManage,
        roleCode: B11_ROLE_NO_MANAGE,
        active: true,
        expectedPermissions: B11_ROLE_PERMISSIONS[B11_ROLE_NO_MANAGE],
      },
      {
        key: 'inactive',
        username: names.inactive,
        email: mail.inactive,
        roleCode: B11_TARGET_ROLE,
        active: false,
        expectedPermissions: [],
      },
    ],
  };
}

export function manifestDir(marker) {
  return path.join(os.tmpdir(), 'tf-b11b1', marker);
}

export function manifestPath(marker) {
  return path.join(manifestDir(marker), 'manifest.json');
}

/**
 * El manifiesto es el único sitio donde vive la contraseña de fixture, y está
 * fuera del repositorio. Si alguien lo sube a Git queda expuesto; por eso el
 * script lo escribe en el directorio temporal del sistema y el cleanup lo borra.
 */
export function writeManifest(manifest) {
  const target = manifestPath(manifest.marker);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return target;
}

export function readManifest(marker) {
  const target = manifestPath(marker);
  if (!fs.existsSync(target)) {
    throw new Error(
      `No existe el manifiesto de fixtures B11 en ${target}. `
      + 'Ejecute primero: node src/scripts/mssql-b11-fixtures.js setup',
    );
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

export function removeManifest(marker) {
  const dir = manifestDir(marker);
  fs.rmSync(dir, { recursive: true, force: true });
  return !fs.existsSync(dir);
}

/**
 * Localiza el manifiesto cuando la prueba no recibe B11_MARKER: el más reciente
 * por fecha de modificación. Si hay más de uno se listan todos y se usa el más
 * reciente, así que el helper devuelve también la lista completa para que el
 * script pueda avisar de marcadores sin limpiar.
 */
export function findLatestManifest() {
  const root = path.join(os.tmpdir(), 'tf-b11b1');
  if (!fs.existsSync(root)) return { manifest: null, markers: [] };
  const markers = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((marker) => fs.existsSync(manifestPath(marker)));
  if (markers.length === 0) return { manifest: null, markers: [] };
  const ordered = [...markers].sort(
    (a, b) => fs.statSync(manifestPath(b)).mtimeMs - fs.statSync(manifestPath(a)).mtimeMs,
  );
  return { manifest: readManifest(ordered[0]), markers: ordered };
}

/** Hash bcrypt con el MISMO factor de coste que producción (src/utils/password.js). */
export async function hashFixturePassword(plain) {
  const { hashPassword } = await import('../utils/password.js');
  return hashPassword(plain);
}

/**
 * Bloque `:setvar` listo para pegar en mssql-b11-fixtures.sql desde SSMS en modo
 * SQLCMD. Es el puente entre el hash que solo Node sabe calcular y el script SQL
 * que ejecuta la identidad Windows: el usuario pega estas tres líneas y nada
 * más. El .sql aborta con THROW si detecta el marcador o el hash de ejemplo.
 */
export function sqlcmdBlock({ marker, passwordHash, action = 'setup' }) {
  return [
    `:setvar B11_ACTION "${action}"`,
    `:setvar B11_MARKER "${marker}"`,
    `:setvar B11_PWD_HASH "${passwordHash}"`,
  ];
}