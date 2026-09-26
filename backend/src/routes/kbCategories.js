import express from 'express';
import db, { nowIso } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

// Taxonomía propia de la base de conocimiento. Deliberadamente separada de
// `categories`: esas clasifican incidencias y mezclar ambos dominios obligaría
// a elegir entre "Red" como tipo de incidencia y "Red" como tema de
// documentación.
const LIST_SQL = `
  SELECT c.*, (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id = c.id AND a.status = 'PUBLISHED') AS articles_count
  FROM kb_categories c
`;

/**
 * Listado de categorías. Sin permiso de kb.view el catálogo tampoco tiene
 * sentido: quien no puede leer artículos publicados no puede filtrar por ellos.
 */
router.get('/', requirePermission('kb.view'), (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const where = onlyActive ? 'WHERE c.active = 1' : '';
  const rows = db.prepare(`${LIST_SQL} ${where} ORDER BY c.name`).all();
  res.json({ data: rows });
});

router.get('/:id', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });
  res.json({ category: row });
});

router.post('/', requirePermission('kb.manage'), (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  // allowlist estricta del color: evita inyectar CSS en el estilo del chip.
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  if (db.prepare('SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  }
  const info = db
    .prepare('INSERT INTO kb_categories (name, description, color) VALUES (?, ?, ?)')
    .run(name, description, color);
  res.status(201).json({ category: db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(info.lastInsertRowid) });
});

router.patch('/:id', requirePermission('kb.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM kb_categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : existing.color;
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = db.prepare('SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

  db.prepare('UPDATE kb_categories SET name = ?, description = ?, color = ?, active = ?, updated_at = ? WHERE id = ?').run(
    name, description, color, active, nowIso(), id
  );
  res.json({ category: db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(id) });
});

// Sin DELETE: desactivar (active = 0) retira la categoría de los filtros sin
// romper los artículos que ya la referencian. Coherente con categories.js.

export default router;
