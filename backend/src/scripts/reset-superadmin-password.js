import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/runtime.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { validate, rules } from '../utils/validation.js';
import { nowIso } from '../utils/time.js';
import config, { dbClient } from '../config.js';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

export async function resetSuperadminPassword(newPassword) {
  const isMssql = config.dbClient === 'mssql';
  if (!isMssql) {
    throw new Error('Este comando solo funciona con SQL Server (DB_CLIENT=mssql), el único motor soportado');
  }

  validate({
    new_password: rules.password(newPassword),
  });

  const user = await db.queryOne(
    `SELECT u.id, u.username, u.password_hash, u.last_password_change_at, u.active
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'SUPERADMIN' AND u.username = 'superadmin'`
  );

  if (!user) {
    throw new Error('Usuario superadmin con rol SUPERADMIN no encontrado');
  }

  if (!user.active) {
    throw new Error('El usuario superadmin está desactivado');
  }

  const newHash = hashPassword(newPassword);

  const isValid = verifyPassword(newPassword, newHash);
  if (!isValid) {
    throw new Error('Error interno: el hash generado no valida la contraseña introducida');
  }

  await db.execute(
    `UPDATE users
     SET password_hash = ?, last_password_change_at = ?, updated_at = ?
     WHERE id = ?`,
    newHash,
    nowIso(),
    nowIso(),
    user.id
  );

  return { username: user.id, updatedAt: nowIso() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const password = process.argv.includes('--password-stdin') ? readStdin() : '';

  try {
    const result = await resetSuperadminPassword(password);
    console.log(`Contraseña de superadmin restablecida correctamente.`);
  } catch (err) {
    console.error(`[reset-superadmin-password] ${err.message}`);
    process.exitCode = 1;
  }
}