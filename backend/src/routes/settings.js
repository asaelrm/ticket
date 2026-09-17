import express from 'express';
import db, { nowIso } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requirePermission('settings.manage'));

const KEYS = {
  app_name: 'Nombre del sistema',
  company_name: 'Nombre de la empresa',
  ticket_prefix: 'Prefijo de tickets',
  footer_text: 'Texto del pie de página',
};

const DEFAULT_PREFIX = 'TCK';

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM settings').all();
  const settings = { ...Object.fromEntries(Object.keys(KEYS).map((k) => [k, ''])) };
  for (const row of rows) {
    if (row.key in KEYS) settings[row.key] = row.value;
  }
  if (!settings.ticket_prefix) settings.ticket_prefix = DEFAULT_PREFIX;
  res.json({ data: settings, meta: KEYS });
});

router.patch('/', (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const key of Object.keys(body)) {
    if (!(key in KEYS)) continue;
    const value = typeof body[key] === 'string' ? body[key].trim().slice(0, 120) : '';
    if (value) updates[key] = value;
  }

  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  );
  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, value, req.user.id, nowIso());
  }

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...Object.fromEntries(Object.keys(KEYS).map((k) => [k, ''])) };
  for (const row of rows) {
    if (row.key in KEYS) settings[row.key] = row.value;
  }
  if (!settings.ticket_prefix) settings.ticket_prefix = DEFAULT_PREFIX;
  res.json({ data: settings });
});

export default router;