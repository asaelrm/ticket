// Rate limiting en memoria (ventana deslizante) por clave (IP o ruta).
export function rateLimit({ windowMs = 60_000, max = 100, message = 'Demasiadas solicitudes' } = {}) {
  // En pruebas el límite real volvería la suite dependiente del tiempo y del
  // número de inicios de sesión del mismo proceso (el seed y varios casos de
  // autorización comparten IP 127.0.0.1). El resto del código ya usa esta
  // guarda para el trabajo programado (ver utils/jobs.js).
  if (process.env.NODE_ENV === 'test') return function rateLimitDisabled(req, res, next) { next(); };

  const hits = new Map();

  return function rateLimitMw(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs, created: now });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

export function authRateLimit() {
  return rateLimit({ windowMs: 60_000, max: 10, message: 'Demasiados intentos de inicio de sesión. Intente nuevamente en un minuto.' });
}