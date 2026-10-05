import express from 'express';
import { nowIso, contract } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Migrado al contrato de A3: las consultas de esta ruta pasan por `contract`
// con parámetros nombrados. `LIST_SQL` y el fragmento `where` siguen siendo
// literales internos del módulo; lo único que llega del usuario viaja siempre
// como valor enlazado, nunca concatenado en el SQL.
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
 *
 * Las categorías desactivadas solo las ve quien puede gestionarlas: para el
 * resto del mundo el catálogo se limita a `active = 1`.
 */
router.get('/', requirePermission('kb.view'), asyncHandler(async (req, res) => {
  const canManage = req.user.permissions.includes('kb.manage');
  const asked = String(req.query.active ?? '');
  const wantsInactive = asked === '0' || asked === 'false';
  const where = canManage && wantsInactive ? '' : 'WHERE c.active = 1';
  const rows = await contract.queryMany(`${LIST_SQL} ${where} ORDER BY c.name`);
  res.json({ data: rows });
}));

router.get('/:id', requirePermission('kb.view'), asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = await contract.queryOne(`${LIST_SQL} WHERE c.id = :id`, { id });
  if (!row) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });
  if (!row.active && !req.user.permissions.includes('kb.manage')) {
    return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });
  }
  res.json({ category: row });
}));

router.post('/', requirePermission('kb.manage'), asyncHandler(async (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  // allowlist estricta del color: evita inyectar CSS en el estilo del chip.
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = await contract.queryOne('SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(:name)', { name });
  if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

  const { id } = await contract.insertAndGetId(
    'INSERT INTO kb_categories (name, description, color) VALUES (:name, :description, :color)',
    { name, description, color },
  );
  res.status(201).json({ category: await contract.queryOne(`${LIST_SQL} WHERE c.id = :id`, { id }) });
}));

router.patch('/:id', requirePermission('kb.manage'), asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = await contract.queryOne('SELECT * FROM kb_categories WHERE id = :id', { id });
  if (!existing) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : existing.color;
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = await contract.queryOne(
    'SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(:name) AND id != :id',
    { name, id },
  );
  if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

  await contract.execute(
    'UPDATE kb_categories SET name = :name, description = :description, color = :color, active = :active, updated_at = :updated_at WHERE id = :id',
    { name, description, color, active, updated_at: nowIso(), id },
  );
  res.json({ category: await contract.queryOne(`${LIST_SQL} WHERE c.id = :id`, { id }) });
}));

// Sin DELETE: desactivar (active = 0) retira la categoría de los filtros sin
// romper los artículos que ya la referencian. Coherente con categories.js.

export default router;