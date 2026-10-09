import express from 'express';
import runtime from '../db/runtime.js';
import { nowIso } from '../utils/time.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg, requireOrg } from '../middleware/org.js';

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
 *
 * ETAPA 3: el catálogo se lista SIEMPRE dentro de la organización del contexto
 * de sesión. Un SUPERADMIN sin contexto obtiene una lista vacía.
 */
router.get('/', requirePermission('kb.view'), async (req, res) => {
  try {
    const canManage = req.user.permissions.includes('kb.manage');
    const asked = String(req.query.active ?? '');
    const wantsInactive = asked === '0' || asked === 'false';
    const includeInactive = canManage && wantsInactive;
    const rows = await runtime.queryMany(
      `${LIST_SQL} WHERE c.organization_id = ? ${includeInactive ? '' : 'AND c.active = 1'} ORDER BY c.name`,
      currentOrgId(req.user)
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Detalle: alias de organización devuelve 404 (no revela la existencia de una
// categoría de otra organización). Un SUPERADMIN sin contexto (org NULL)
// también obtiene 404: las rutas normales exigen una organización real.
router.get('/:id', requirePermission('kb.view'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const row = await runtime.queryOne(`${LIST_SQL} WHERE c.id = ? AND c.organization_id = ?`, id, currentOrgId(req.user));
    if (!row) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });
    if (!row.active && !req.user.permissions.includes('kb.manage')) {
      return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });
    }
    res.json({ category: row });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Creación: exige contexto de organización y rechaza que el cliente intente
// fijar `organization_id` en el cuerpo (mismo patrón que categories.js).
router.post('/', requirePermission('kb.manage'), requireOrg, async (req, res) => {
  try {
    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = safeStr(req.body.name);
    const description = safeStr(req.body.description);
    // allowlist estricta del color: evita inyectar CSS en el estilo del chip.
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#64748b';

    validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

    // El nombre sigue siendo único global (SQLite); limitación conocida que se
    // resuelve en la etapa MSSQL (mismo criterio que categories.js).
    const existingName = await runtime.queryOne('SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(?)', name);
    if (existingName) {
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    }
    const organizationId = currentOrgId(req.user);
    const result = await runtime.insertAndGetId('INSERT INTO kb_categories (name, description, color, organization_id) VALUES (?, ?, ?, ?)', name, description, color, organizationId);
    const category = await runtime.queryOne(`${LIST_SQL} WHERE c.id = ?`, result.id);
    res.status(201).json({ category });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

// Edición: misma regla de alias — 404 si la categoría pertenece a otra
// organización, y la organización nunca se modifica desde el cliente.
router.patch('/:id', requirePermission('kb.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const existing = await runtime.queryOne('SELECT * FROM kb_categories WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!existing) return res.status(404).json({ error: 'Categoría de conocimiento no encontrada' });

    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = safeStr(req.body.name ?? existing.name);
    const description = safeStr(req.body.description ?? existing.description ?? '');
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : existing.color;
    const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

    validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

    const dup = await runtime.queryOne('SELECT id FROM kb_categories WHERE LOWER(name) = LOWER(?) AND id != ?', name, id);
    if (dup) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });

    await runtime.execute('UPDATE kb_categories SET name = ?, description = ?, color = ?, active = ?, updated_at = ? WHERE id = ?', name, description, color, active, nowIso(), id);
    const category = await runtime.queryOne(`${LIST_SQL} WHERE c.id = ?`, id);
    res.json({ category });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

// Sin DELETE: desactivar (active = 0) retira la categoría de los filtros sin
// romper los artículos que ya la referencian. Coherente con categories.js.

export default router
