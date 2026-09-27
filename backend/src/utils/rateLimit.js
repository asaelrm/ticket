// Rate limiting en memoria por clave (la IP). La ventana es FIJA: `reset` se
// fija en la primera petición de la ventana y no se recalcula, así que en el
// borde un cliente agotado puede llegar a `2 * max` por minuto. Es el trade-off
// habitual de este enfoque y no se cambia aquí.
export function rateLimit({ windowMs = 60_000, max = 100, message = 'Demasiadas solicitudes' } = {}) {
  // En pruebas el límite real volvería la suite dependiente del tiempo y del
  // número de inicios de sesión del mismo proceso (el seed y varios casos de
  // autorización comparten IP 127.0.0.1). El resto del código ya usa esta
  // guarda para el trabajo programado (ver utils/jobs.js).
  if (process.env.NODE_ENV === 'test') return function rateLimitDisabled(req, res, next) { next(); };

  const hits = new Map();
  let requests = 0;

  return function rateLimitMw(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    // Poda: las entradas nunca se borraban, así que cada IP nueva (botnet, NAT,
    // crawler, nodos de salida) dejaba una entrada viva durante toda la vida
    // del proceso. Se recorre el mapa una vez cada 1000 peticiones: O(n) pero
    // amortizado, y en el caso habitual de pocas IPs es trivial.
    if (++requests > 1000) {
      requests = 0;
      for (const [k, v] of hits) {
        if (v.reset <= now) hits.delete(k);
      }
    }

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