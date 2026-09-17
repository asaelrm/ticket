import express from 'express';
import db, { nowIso } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const rows = onlyActive
    ? db.prepare('SELECT * FROM departments WHERE active = 1 ORDER BY name').all()
    : db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.json({ data: rows });
});

router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Departamento no encontrado' });
  res.json({ department: row });
});

router.post('/', requirePermission('department.manage'), (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  if (db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });
  }
  const info = db.prepare('INSERT INTO departments (name, description) VALUES (?, ?)').run(name, description);
  res.status(201).json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/:id', requirePermission('department.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Departamento no encontrado' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });

  db.prepare('UPDATE departments SET name = ?, description = ?, active = ? WHERE id = ?').run(name, description, active, id);
  res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(id) });
});

export default router;