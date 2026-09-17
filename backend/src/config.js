import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const rootDir = path.resolve(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  uploadDir: path.resolve(rootDir, process.env.UPLOAD_DIR || 'uploads'),
  dbFile: process.env.DB_FILE || null,

  publicDir: process.env.PUBLIC_DIR
    ? path.resolve(rootDir, '..', process.env.PUBLIC_DIR)
    : path.resolve(rootDir, '..', 'frontend', 'dist'),

  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  session: {
    secret: process.env.SESSION_SECRET || 'ticket-flow-dev-secret-change-me',
    secure: bool(process.env.COOKIE_SECURE, false),
    maxAge: 60 * 60 * 1000,
    rememberMaxAge: 30 * 24 * 60 * 60 * 1000,
  },

  uploads: {
    maxSizeMb: int(process.env.MAX_UPLOAD_SIZE_MB, 5),
    maxFilesPerTicket: int(process.env.MAX_FILES_PER_TICKET, 5),
  },
};

config.dbFile =
  config.dbFile && config.dbFile !== 'false'
    ? path.resolve(rootDir, config.dbFile)
    : path.join(config.dataDir, 'tickets.db');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export default config;