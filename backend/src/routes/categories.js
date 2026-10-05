import express from 'express';
import { nowIso, contract } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

// Migrado al contrato de A3: las cuatro consultas de esta ruta pasan por
// `contract`. Los parámetros van con nombre (`:name`) porque es la sintaxis que
// `mssql` comparte; los valores viajan por el binding del driver, nunca
// concatenados. Respuestas, permisos y validaciones no cambian.
const router = express.Router();
router.use(requireAuth);

// Express 4 no reenvía rechazos de promesas al error handler, así que un
// `validate()` que lanza dentro de un handler async dejaría la petición colgada
// en lugar de devolver 400. Mismo wrapper que usa routes/tickets.js.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const rows = onlyActive
    ? await contract.queryMany('SELECT * FROM categories WHERE active = 1 ORDER BY name')
    : await contract.queryMany('SELECT * FROM categories ORDER BY name');

  const withCounts = req.query.withCounts === '1' || req.query.withCounts === 'true';
  if (withCounts) {
    const counts = await contract.queryMany('SELECT category_id, COUNT(*) AS n FROM tickets GROUP BY category_id');
    const byCategory = new Map(counts.map((c) => [c.category_id, c.n]));
    for (const c of rows) c.tickets_count = byCategory.get(c.id) || 0;
  }
  res.json({ data: rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = await contract.queryOne('SELECT * FROM categories WHERE id = :id', { id });
  if (!row) return res.status(404).json({ error: 'Categoría no encontrada' });
  res.json({ category: row });
}));

router.post('/', requirePermission('category.manage'), asyncHandler(async (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const existente = await contract.queryOne('SELECT id FROM categories WHERE LOWER(name) = LOWER(:name)', { name });
  if (existente) {
    return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  }
  const { id } = await contract.insertAndGetId(
    'INSERT INTO categories (name, description, color) VALUES (:name, :description, :color)',
    { name, description, color },
  );
  res.status(201).json({ category: await contract.queryOne('SELECT * FROM categories WHERE id = :id', { id }) });
}));

router.patch('/:id', requirePermission('category.manage'), asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = await contract.queryOne('SELECT * FROM categories WHERE id = :id', { id });
  if (!existing) return res.status(404).json({ error: 'Categoría no encontrada' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : existing.color;
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = await contract.queryOne(
    'SELECT id FROM categories WHERE LOWER(name) = LOWER(:name) AND id != :id',
    { name, id },
  );
  if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

  await contract.execute(
    'UPDATE categories SET name = :name, description = :description, color = :color, active = :active, updated_at = :updated_at WHERE id = :id',
    { name, description, color, active, updated_at: nowIso(), id },
  );
  res.json({ category: await contract.queryOne('SELECT * FROM categories WHERE id = :id', { id }) });
}));

export default router;