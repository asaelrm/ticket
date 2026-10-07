import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import { runMigrations } from '../db.js';
import { seed } from '../seed.js';
import { hashPassword } from '../utils/password.js';
import { validate, rules, safeStr } from '../utils/validation.js';
import { SUPERADMIN_ROLE_CODE } from '../orgPolicy.js';

function boolEnv(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// Inputs de la primera cuenta SUPERADMIN. Nunca se imprime la contraseña y el
// script falla en lugar de degradarse a un valor por defecto.
export function bootstrapSuperadmin({
  username,
  email,
  name,
  lastName,
  password,
  production = false,
}) {
  const isProduction = production;
  if (isProduction && !boolEnv(process.env.BOOTSTRAP_SUPERADMIN_PROD_ALLOWED)) {
    throw new Error(
      'refusing production: defina BOOTSTRAP_SUPERADMIN_PROD_ALLOWED=true para crear el SUPERADMIN ' +
        'en producción, o cree la cuenta por otra vía segura.'
    );
  }

  runMigrations();
  seed();

  const existing = db
    .prepare('SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = ?')
    .get(SUPERADMIN_ROLE_CODE);
  if (existing) {
    throw new Error(
      `ya existe un ${SUPERADMIN_ROLE_CODE}; el bootstrap solo crea la PRIMERA cuenta global. ` +
        'Las siguientes se crean desde la API con un superadministrador autenticado.'
    );
  }

  const body = { username: safeStr(username), email: safeStr(email) };
  const errors = {};
  if (rules.required(body.username, 'Usuario')) {
    errors.username = 'El nombre de usuario es obligatorio (BOOTSTRAP_SUPERADMIN_USERNAME)';
  } else if (rules.username(body.username)) {
    errors.username = rules.username(body.username);
  }
  if (rules.required(body.email, 'Correo')) {
    errors.email = 'El correo es obligatorio (BOOTSTRAP_SUPERADMIN_EMAIL)';
  } else if (rules.email(body.email)) {
    errors.email = rules.email(body.email);
  }
  const pwd = String(password || '');
  const pwdError = rules.password(pwd);
  if (pwdError) errors.password = pwdError;
  if (!pwd) errors.password = 'La contraseña es obligatoria (BOOTSTRAP_SUPERADMIN_PASSWORD o --password-stdin)';
  if (Object.keys(errors).length) {
    throw new Error(`datos inválidos para la primera cuenta ${SUPERADMIN_ROLE_CODE}: ${JSON.stringify(errors)}`);
  }

  const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(SUPERADMIN_ROLE_CODE);
  if (!role) throw new Error(`el rol ${SUPERADMIN_ROLE_CODE} no existe tras el seed`);

  // Un SUPERADMIN es global: nace sin organización.
  const info = db
    .prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`
    )
    .run(safeStr(name) || 'Superadministrador', safeStr(lastName) || 'Global', body.username, body.email, hashPassword(pwd), role.id, new Date().toISOString());

  return { id: info.lastInsertRowid, username: body.username, role: SUPERADMIN_ROLE_CODE };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const password =
    process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ||
    (process.argv.includes('--password-stdin') ? readStdin() : '');
  try {
    const created = bootstrapSuperadmin({
      username: process.env.BOOTSTRAP_SUPERADMIN_USERNAME || '',
      email: process.env.BOOTSTRAP_SUPERADMIN_EMAIL || '',
      name: process.env.BOOTSTRAP_SUPERADMIN_NAME || '',
      lastName: process.env.BOOTSTRAP_SUPERADMIN_LAST_NAME || '',
      password,
      production: process.env.NODE_ENV === 'production',
    });
    console.log(`Superadministrador creado: "${created.username}" (rol ${created.role}).`);
  } catch (err) {
    console.error(`[bootstrap-superadmin] ${err.message}`);
    process.exitCode = 1;
  }
}