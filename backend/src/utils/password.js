import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

// Contraseña aleatoria e inutilizable: da de alta una cuenta que existe en el
// directorio o en el seed sin que nadie pueda entrar con una contraseña
// conocida. Un administrador tiene que restablecerla.
export function unusablePassword() {
  return crypto.randomBytes(32).toString('base64url');
}

export function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}