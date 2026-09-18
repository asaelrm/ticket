import crypto from 'node:crypto';
import express from 'express';
import db from '../db.js';
import config from '../config.js';
import { authRateLimit } from '../utils/rateLimit.js';
import { verifyPassword, hashPassword } from '../utils/password.js';
import { validate, rules, safeStr } from '../utils/validation.js';
import { requireAuth, touchLastLogin, loadUser } from '../middleware/auth.js';
import { nowIso } from '../db.js';
import { notifyPasswordReset } from '../utils/mailer.js';

const router = express.Router();

const FIND_USER = `
  SELECT u.*, r.code AS role_code, r.name AS role_name, d.name AS department_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE LOWER(u.username) = LOWER(?) OR LOWER(u.email) = LOWER(?)
`;

router.post('/login', authRateLimit(), (req, res) => {
  const account = safeStr(req.body.account);
  const password = String(req.body.password || '');
  const remember = req.body.remember === true || req.body.remember === 'true';

  validate({
    account: rules.required(account, 'Usuario o correo'),
    password: rules.required(password, 'Contraseña'),
  });

  const user = db.prepare(FIND_USER).get(account, account);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'Su cuenta está desactivada. Contacte a un administrador.' });
  }

  touchLastLogin(user.id);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Error al iniciar sesión' });
    req.session.userId = user.id;
    req.session.cookie.maxAge = remember ? config.session.rememberMaxAge : config.session.maxAge;
    req.session.save(() => {
      return res.json({ user: loadUser(req) });
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tf_sid');
    res.clearCookie('tf_csrf');
    res.json({ ok: true });
  });
});

router.post('/forgot-password', authRateLimit(), (req, res) => {
  const account = safeStr(req.body.account);

  validate({ account: rules.required(account, 'Usuario o correo') });

  const user = db
    .prepare(`SELECT id, name, username, email, active FROM users
              WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)`)
    .get(account, account);

  // No revelar si la cuenta existe: la respuesta es idéntica en ambos casos.
  if (!user || !user.active) {
    return res.json({ ok: true, message: 'Si la cuenta existe, recibirá un enlace para restablecer su contraseña.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = ? WHERE id = ?'
  ).run(hash, expires, nowIso(), user.id);

  // El enlace se envía por correo cuando el SMTP está configurado; si no, el
  // transporte de desarrollo registra el mensaje (email_logs / consola).
  const resetUrlBase = process.env.PUBLIC_URL || config.publicUrl;
  notifyPasswordReset(user, token, resetUrlBase);

  // En desarrollo el token se devuelve para poder restablecer la contraseña.
  // En producción debe llegar únicamente por correo.
  const payload = { ok: true, message: 'Se generó un enlace de recuperación. Validez: 24 horas.' };
  if (config.env !== 'production') {
    payload.token = token;
    payload.resetUrl = `/reset-password?token=${token}`;
  }
  return res.json(payload);
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');

  validate({
    current_password: rules.required(current, 'Contraseña actual'),
    new_password: rules.password(next),
  });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, row.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
  }

  db.prepare('UPDATE users SET password_hash = ?, last_password_change_at = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(next),
    nowIso(),
    nowIso(),
    req.user.id
  );
  return res.json({ ok: true });
});

router.post('/reset-password', (req, res) => {
  const token = safeStr(req.body.token);
  const next = String(req.body.password || '');

  validate({
    token: rules.required(token, 'Token de recuperación'),
    password: rules.password(next),
  });

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db
    .prepare('SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > ?')
    .get(hash, nowIso());

  if (!row) return res.status(400).json({ error: 'Token inválido o expirado' });

  db.prepare(
    `UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL,
     last_password_change_at = ?, updated_at = ? WHERE id = ?`
  ).run(hashPassword(next), nowIso(), nowIso(), row.id);

  return res.json({ ok: true });
});

export default router;