import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import config from './config.js';
import SqliteSessionStore from './utils/sessionStore.js';
import { ensureCsrfCookie, csrfProtect } from './middleware/csrf.js';
import { rateLimit } from './utils/rateLimit.js';
import { errorHandler } from './middleware/errors.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import rolesRoutes from './routes/roles.js';
import ticketsRoutes from './routes/tickets.js';
import categoriesRoutes from './routes/categories.js';
import departmentsRoutes from './routes/departments.js';
import teamsRoutes from './routes/teams.js';
import filesRoutes from './routes/files.js';
import dashboardRoutes from './routes/dashboard.js';
import reportsRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import notificationsRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.set('trust proxy', 1);

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

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin.startsWith(config.corsOrigin)) {
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
  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/tickets', ticketsRoutes);
  app.use('/api/categories', categoriesRoutes);
  app.use('/api/departments', departmentsRoutes);
  app.use('/api/teams', teamsRoutes);
  app.use('/api/files', filesRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/audit', auditRoutes);

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