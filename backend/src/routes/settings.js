import express from 'express';
import db, { nowIso } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  getResolutionCategories,
  getRootCauses,
  getPendingReasons,
  requireResolutionToClose,
} from '../utils/options.js';

const router = express.Router();
router.use(requireAuth, requirePermission('settings.manage'));

const KEYS = {
  app_name: 'Nombre del sistema',
  company_name: 'Nombre de la empresa',
  ticket_prefix: 'Prefijo de tickets',
  footer_text: 'Texto del pie de página',
  sla_critical_hours: 'SLA crítica (horas)',
  sla_high_hours: 'SLA alta (horas)',
  sla_medium_hours: 'SLA media (horas)',
  sla_low_hours: 'SLA baja (horas)',
  resolution_categories: 'Categorías de solución',
  root_causes: 'Causas raíz',
  pending_reasons: 'Motivos de ticket pendiente',
  require_resolution_to_close: 'Exigir resolución antes de cerrar',
};

// Claves que se guardan como lista (JSON) en la tabla settings.
const LIST_KEYS = ['resolution_categories', 'root_causes', 'pending_reasons'];
const DEFAULT_PREFIX = 'TCK';

function readSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const settings = {};
  for (const key of Object.keys(KEYS)) {
    if (!LIST_KEYS.includes(key) && key !== 'require_resolution_to_close') settings[key] = raw[key] || '';
  }
  settings.resolution_categories = getResolutionCategories().join(', ');
  settings.root_causes = getRootCauses().join(', ');
  settings.pending_reasons = getPendingReasons().join(', ');
  settings.require_resolution_to_close = requireResolutionToClose() ? '1' : '0';
  if (!settings.ticket_prefix) settings.ticket_prefix = DEFAULT_PREFIX;
  return settings;
}

router.get('/', (req, res) => {
  res.json({ data: readSettings(), meta: KEYS });
});

router.patch('/', (req, res) => {
  const body = req.body || {};
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  );

  for (const key of Object.keys(KEYS)) {
    if (!(key in body)) continue;
    let value;
    if (LIST_KEYS.includes(key)) {
      const arr = Array.isArray(body[key]) ? body[key] : String(body[key] ?? '').split(',');
      const clean = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
      value = JSON.stringify(clean);
    } else if (key === 'require_resolution_to_close') {
      const on = ['1', 'true', 'on', 'si', 'sí', 'yes'].includes(String(body[key]).toLowerCase());
      value = on ? '1' : '0';
    } else {
      value = typeof body[key] === 'string' ? body[key].trim().slice(0, 300) : '';
      if (!value) continue;
    }
    stmt.run(key, value, req.user.id, nowIso());
  }

  res.json({ data: readSettings() });
});

export default router;
