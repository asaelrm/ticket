import express from 'express';
import db, { nowIso } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg, requireOrg } from '../middleware/org.js';

const router = express.Router();
router.use(requireAuth);

// ETAPA 3 (aislamiento por organización): el catálogo se lista SIEMPRE dentro de
// la organización del contexto de sesión. Un SUPERADMIN sin contexto obtiene
// una lista vacía (no debe exponer de golpe los datos de todas las orgs).
router.get('/', (req, res) => {
  const org = currentOrgId(req.user);
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const rows = onlyActive
    ? db.prepare('SELECT * FROM categories WHERE active = 1 AND organization_id = ? ORDER BY name').all(org)
    : db.prepare('SELECT * FROM categories WHERE organization_id = ? ORDER BY name').all(org);

  const withCounts = req.query.withCounts === '1' || req.query.withCounts === 'true';
  if (withCounts && org) {
    // Los contadores se acotan a la organización: sin este filtro el número de
    // tickets de otra organización inflaría el contador de la categoría.
    const counts = db.prepare('SELECT category_id, COUNT(*) AS n FROM tickets WHERE organization_id = ? GROUP BY category_id').all(org);
    const byCategory = new Map(counts.map((c) => [c.category_id, c.n]));
    for (const c of rows) c.tickets_count = byCategory.get(c.id) || 0;
  }
  res.json({ data: rows });
});

// Detalle: alias de organización devuelve 404 (no revela la existencia de un
// recurso de otra organización). Un SUPERADMIN sin contexto (org NULL) también
// obtiene 404: las rutas normales exigen una organización real.
router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare('SELECT * FROM categories WHERE id = ? AND organization_id = ?')
    .get(id, currentOrgId(req.user));
  if (!row) return res.status(404).json({ error: 'Categoría no encontrada' });
  res.json({ category: row });
});

// Creación: exige contexto de organización y rechaza que el cliente intente
// fijar `organization_id` en el cuerpo (mismo patrón que departments).
router.post('/', requirePermission('category.manage'), requireOrg, (req, res) => {
  const rejected = rejectClientOrg(req.body || {});
  if (rejected) return res.status(400).json({ error: rejected });

  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  // El nombre sigue siendo único global (SQLite). Que dos organizaciones no
  // puedan tener "Software" a la vez es una limitación conocida que se resuelve
  // cuando el esquema pase a MSSQL; la organización del nuevo registro es la
  // del contexto de sesión.
  if (db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  }
  const organizationId = currentOrgId(req.user);
  const info = db.prepare('INSERT INTO categories (name, description, color, organization_id) VALUES (?, ?, ?, ?)')
    .run(name, description, color, organizationId);
  res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid) });
});

// Edición: misma regla de alias — 404 si la categoría pertenece a otra
// organización (o si el actor carece de contexto), y la organización nunca se
// modifica desde el cliente.
router.patch('/:id', requirePermission('category.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND organization_id = ?')
    .get(id, currentOrgId(req.user));
  if (!existing) return res.status(404).json({ error: 'Categoría no encontrada' });

  const rejected = rejectClientOrg(req.body || {});
  if (rejected) return res.status(400).json({ error: rejected });

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