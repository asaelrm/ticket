import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import config from './config.js';
import SqliteSessionStore from './utils/sessionStore.js';
import { ensureCsrfCookie, csrfProtect } from './middleware/csrf.js';
import { rateLimit } from './utils/rateLimit.js';
import { resolveTrustProxy, shouldSendHsts } from './transportSecurity.js';
import { errorHandler } from './middleware/errors.js';
import { wrapAsyncRouter } from './middleware/asyncHandler.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import rolesRoutes from './routes/roles.js';
import ticketsRoutes from './routes/tickets.js';
import categoriesRoutes from './routes/categories.js';
import departmentsRoutes from './routes/departments.js';
import teamsRoutes from './routes/teams.js';
import cannedResponsesRoutes from './routes/cannedResponses.js';
import kbArticlesRoutes from './routes/kbArticles.js';
import kbCategoriesRoutes from './routes/kbCategories.js';
import filesRoutes from './routes/files.js';
import dashboardRoutes from './routes/dashboard.js';
import reportsRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import notificationsRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';
import organizationsRoutes from './routes/organizations.js';

export function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Confianza en proxies. Vacío o 'false' = no se cree ninguna cabecera de
  // proxy, que es el estado actual y el más seguro por defecto. Hay que
  // configurarlo de forma explícita para que `req.protocol` refleje el HTTPS
  // real de Cloudflare; si se activa a ciegas, cualquier cliente podría
  // inyectar X-Forwarded-Proto (ver src/transportSecurity.js).
  const trust = options.trustProxy !== undefined ? resolveTrustProxy(options.trustProxy) : resolveTrustProxy(config.trustProxy);
  if (trust.value) app.set('trust proxy', trust.value);
  if (trust.warning) console.warn(`[transporte] ${trust.warning}`);

  const publicHosts = options.publicHosts !== undefined ? options.publicHosts : config.publicHosts;
  // Aviso de arranque: no cambia nada, solo deja constancia de una combinación
  // que deja la sesión de producción expuesta al sniffing en la LAN.
  if (config.env === 'production' && !config.session.secure) {
    console.warn(
      '[transporte] NODE_ENV=production y COOKIE_SECURE=false: la cookie de sesión viaja sin el flag Secure. ' +
        'Sirva la aplicación por HTTPS y ponga COOKIE_SECURE=true, o la sesión queda expuesta en redes sin TLS.'
    );
  }
  if (config.env === 'production' && !publicHosts) {
    console.warn('[transporte] PUBLIC_HOSTS vacío: no se enviará Strict-Transport-Security en ningún host.');
  }
  // HSTS por host y solo sobre HTTPS verificado. La app sirve hoy HTTPS por
  // Cloudflare y HTTP desde la LAN en la MISMA instancia, así que no se emite
  // HSTS incondicionalmente: el nombre interno de la LAN no debe quedar
  // anclado a HTTPS, ni un despliegue HTTP de pruebas debe quedar inutilizado
  // en el navegador.
  app.use((req, res, next) => {
    if (shouldSendHsts({ host: req.hostname, isHttps: req.secure, publicHosts })) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'same-origin' },
      // La app puede servirse por HTTP en red local; no forzar HTTPS ni HSTS.
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
          connectSrc: ["'self'"],
          // Sin upgrade-insecure-requests: permite cargar assets por HTTP en LAN.
          upgradeInsecureRequests: null,
        },
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Lista de orígenes permitidos para CORS (comma-separated o variable única).
  const allowedOrigins = (process.env.CORS_ORIGINS || config.corsOrigin || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Headers', 'Content-Type, x-csrf-token');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(
    session({
      name: 'tf_sid',
      store: new SqliteSessionStore(),
      secret: config.session.secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.session.secure,
        maxAge: config.session.maxAge,
      },
    })
  );

  app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));

  app.use('/api', ensureCsrfCookie, csrfProtect, rateLimit({ windowMs: 60_000, max: 600 }));
  // wrapAsyncRouter: Express 4 ignora las promesas rechazadas de los
  // manejadores async; al envolver cada router en su punto de montaje, un
  // error async dentro de cualquier ruta llega a errorHandler en lugar de
  // dejar la petición colgada. Es idempotente y no cambia el comportamiento
  // de los manejadores síncronos.
  app.use('/api/auth', wrapAsyncRouter(authRoutes));
  app.use('/api/users', wrapAsyncRouter(usersRoutes));
  app.use('/api/roles', wrapAsyncRouter(rolesRoutes));
  app.use('/api/tickets', wrapAsyncRouter(ticketsRoutes));
  app.use('/api/categories', wrapAsyncRouter(categoriesRoutes));
  app.use('/api/departments', wrapAsyncRouter(departmentsRoutes));
  app.use('/api/teams', wrapAsyncRouter(teamsRoutes));
  app.use('/api/canned-responses', wrapAsyncRouter(cannedResponsesRoutes));
  app.use('/api/kb-articles', wrapAsyncRouter(kbArticlesRoutes));
  app.use('/api/kb-categories', wrapAsyncRouter(kbCategoriesRoutes));
  app.use('/api/files', wrapAsyncRouter(filesRoutes));
  app.use('/api/dashboard', wrapAsyncRouter(dashboardRoutes));
  app.use('/api/reports', wrapAsyncRouter(reportsRoutes));
  app.use('/api/settings', wrapAsyncRouter(settingsRoutes));
  app.use('/api/notifications', wrapAsyncRouter(notificationsRoutes));
  app.use('/api/audit', wrapAsyncRouter(auditRoutes));
  // V4: administración de organizaciones. Canal exclusivo del SUPERADMIN
  // (requirePermission('organization.manage') + requireSuperadmin dentro del
  // router); un administrador de empresa o un empleado reciben 403.
  app.use('/api/organizations', wrapAsyncRouter(organizationsRoutes));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // Frontend compilado (producción)
  if (fs.existsSync(config.publicDir)) {
    app.use(
      express.static(config.publicDir, {
        index: false,
        maxAge: '1h',
        // El HTML no se cachea para que los usuarios reciban siempre el bundle actual.
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      })
    );
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}