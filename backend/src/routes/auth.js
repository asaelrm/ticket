import crypto from 'node:crypto';
import express from 'express';
import runtime from '../db/runtime.js';
import config from '../config.js';
import { authRateLimit } from '../utils/rateLimit.js';
import { verifyPassword, hashPassword } from '../utils/password.js';
import { saveDirectorySnapshot } from '../directorySync.js';
import { validate, rules, safeStr } from '../utils/validation.js';
import { requireAuth, touchLastLogin, loadUser } from '../middleware/auth.js';
import { nowIso } from '../utils/time.js';
import { notifyPasswordReset } from '../utils/mailer.js';
import { destroyUserSessions } from '../utils/sessionStore.js';

const router = express.Router();

const FIND_USER = `
  SELECT u.*, r.code AS role_code, r.name AS role_name, d.name AS department_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE LOWER(u.username) = LOWER(?) OR LOWER(u.email) = LOWER(?)
`;

// Hash señuelo de un bcrypt real (coste 12) contra una contraseña que nadie
// conoce. Solo sirve para gastar el mismo tiempo que un usuario existente.
const DUMMY_HASH = hashPassword('contraseña-inexistente-para-igualar-coste');

router.post('/login', authRateLimit(), async (req, res) => {
  try {
    const account = safeStr(req.body.account);
    const password = String(req.body.password || '');
    const remember = req.body.remember === true || req.body.remember === 'true';

    validate({
      account: rules.required(account, 'Usuario o correo'),
      password: rules.required(password, 'Contraseña'),
    });

    const user = await runtime.queryOne(FIND_USER, account, account);
    // Si el usuario no existe hay que calcular un bcrypt igualmente. Con
    // `!user || !verify(...)` el cortocircuito evitaba el bcrypt y la respuesta
    // llegaba ~80 veces más rápida: bastaba medir el tiempo para enumerar qué
    // cuentas existen y luego atacarlas por diccionario.
    const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !passwordOk) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    if (!user.active) {
      return res.status(403).json({ error: 'Su cuenta está desactivada. Contacte a un administrador.' });
    }
    // V4: una organización desactivada no admite nuevos inicios de sesión. En
    // loadUser ya se bloquea cualquier sesión existente; aquí se corta también el
    // alta de nuevas sesiones para no devolver un usuario "logueado" inútil.
    if (user.organization_id != null) {
      const org = await runtime.queryOne('SELECT active FROM organizations WHERE id = ?', user.organization_id);
      if (org && !org.active) {
        return res.status(403).json({ error: 'La organización está desactivada. Contacte al administrador del sistema.' });
      }
    }

    await touchLastLogin(user.id);

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Error al iniciar sesión' });
      req.session.userId = user.id;
      req.session.cookie.maxAge = remember ? config.session.rememberMaxAge : config.session.maxAge;
      req.session.save(() => {
        // loadUser is now async, need to await it
        loadUser(req).then((loadedUser) => {
          return res.json({ user: loadedUser });
        }).catch((err) => {
          return res.status(500).json({ error: 'Error al cargar usuario' });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tf_sid');
    res.clearCookie('tf_csrf');
    res.json({ ok: true });
  });
});

router.post('/forgot-password', authRateLimit(), async (req, res) => {
  try {
    const account = safeStr(req.body.account);

    validate({ account: rules.required(account, 'Usuario o correo') });

    const user = await runtime.queryOne(
      `SELECT id, name, username, email, active FROM users
       WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)`,
      account,
      account
    );

    // No revelar si la cuenta existe: la respuesta es idéntica en ambos casos.
    if (!user || !user.active) {
      return res.json({ ok: true, message: 'Si la cuenta existe, recibirá un enlace para restablecer su contraseña.' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await runtime.execute(
      'UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = ? WHERE id = ?',
      hash,
      expires,
      nowIso(),
      user.id
    );

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
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');

    validate({
      current_password: rules.required(current, 'Contraseña actual'),
      new_password: rules.password(next),
    });

    const row = await runtime.queryOne('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(current, row.password_hash)) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    }

    await runtime.execute(
      'UPDATE users SET password_hash = ?, last_password_change_at = ?, updated_at = ? WHERE id = ?',
      hashPassword(next),
      nowIso(),
      nowIso(),
      req.user.id
    );
    await saveDirectorySnapshot();
    await destroyUserSessions(req.user.id);
    return res.json({ ok: true });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/reset-password', authRateLimit(), async (req, res) => {
  try {
    const token = safeStr(req.body.token);
    const next = String(req.body.password || '');

    validate({
      token: rules.required(token, 'Token de recuperación'),
      password: rules.password(next),
    });

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await runtime.queryOne(
      'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > ?',
      hash,
      nowIso()
    );

    if (!row) return res.status(400).json({ error: 'Token inválido o expirado' });

    await runtime.execute(
      `UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL,
       last_password_change_at = ?, updated_at = ? WHERE id = ?`,
      hashPassword(next),
      nowIso(),
      nowIso(),
      row.id
    );
    await saveDirectorySnapshot();
    await destroyUserSessions(row.id);

    return res.json({ ok: true });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
