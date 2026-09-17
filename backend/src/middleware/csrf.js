import crypto from 'node:crypto';

// Patrón double-submit: el navegador recibe la cookie `tf_csrf` (no HttpOnly,
// para que el JS la lea) y debe reflejarla en la cabecera `x-csrf-token`.

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isValid(value) {
  return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
}

export function ensureCsrfCookie(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const current = cookies.tf_csrf;
  const token = isValid(current) ? current : crypto.randomBytes(24).toString('hex');
  res.cookie('tf_csrf', token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: req.secure || req.protocol === 'https',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  });
  next();
}

export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Endpoints públicos sin sesión previa (recuperación/cambio de contraseña),
  // cubiertos por rate limiting y validación de token de recuperación.
  if (req.path === '/auth/login' || req.path === '/auth/reset-password') return next();

  const cookies = parseCookies(req.headers.cookie);
  const cookieVal = cookies.tf_csrf;
  const headerVal = req.headers['x-csrf-token'];
  if (!cookieVal || !headerVal || cookieVal !== headerVal) {
    return res.status(403).json({ error: 'Token CSRF inválido. Recargue la página e intente de nuevo.' });
  }
  return next();
}