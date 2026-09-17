import bcrypt from 'bcryptjs';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

export function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}