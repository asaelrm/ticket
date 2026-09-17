import express from 'express';
import db, { nowIso } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const rows = onlyActive
    ? db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all()
    : db.prepare('SELECT * FROM categories ORDER BY name').all();

  const withCounts = req.query.withCounts === '1' || req.query.withCounts === 'true';
  if (withCounts) {
    for (const c of rows) {
      c.tickets_count = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE category_id = ?').get(c.id).n;
    }
  }
  res.json({ data: rows });
});

router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Categoría no encontrada' });
  res.json({ category: row });
});

router.post('/', requirePermission('category.manage'), (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  if (db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  }
  const info = db.prepare('INSERT INTO categories (name, description, color) VALUES (?, ?, ?)').run(name, description, color);
  res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid) });
});

router.patch('/:id', requirePermission('category.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Categoría no encontrada' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : existing.color;
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

  db.prepare('UPDATE categories SET name = ?, description = ?, color = ?, active = ?, updated_at = ? WHERE id = ?').run(
    name, description, color, active, nowIso(), id
  );
  res.json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

export default router;