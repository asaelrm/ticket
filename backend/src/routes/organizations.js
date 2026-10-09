import express from 'express';
import runtime from '../db/runtime.js';
import { nowIso } from '../utils/time.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireSuperadmin } from '../middleware/org.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';

// V4: administración de organizaciones.
//
// El sistema es multiempresa, pero hasta ahora no existía una API para dar de
// alta o consultar empresas. Este canal es EXCLUSIVO del SUPERADMIN global:
//
//   - `organization.manage` es un permiso que el seed sólo otorga al rol
//     SUPERADMIN (el rol ADMIN lo tiene explícitamente excluido), y además se
//     aplica `requireSuperadmin`: un administrador de organización o un
//     empleado quedan fuera por dos vías independientes.
//   - La organización nunca se decide con un dato del cliente: el recurso es la
//     de la RUTA y sólo el SUPERADMIN puede llegar a esta ruta.
//   - No hay DELETE: una organización con datos relacionados no se elimina
//     (tampoco se elimina sin datos). El "apagado" es `active`, reversible y no
//     destructivo.
//   - No hay suplantación de usuarios ni cambio de contexto: este módulo sólo
//     lee y escribe la tabla `organizations`.
//
// Límite conocido (documentado en la entrega): desactivar una organización
// bloquea el acceso de sus cuentas en `loadUser`; no oculta ni borra sus datos.

const router = express.Router();
router.use(requireAuth, requirePermission('organization.manage'), requireSuperadmin);

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;

// Comparación de nombres insensible a mayúsculas Y a acentos. `LOWER()` de
// SQLite sólo convierte ASCII, así que "Médico" y "MEDICO" no colisionarían en
// SQL y dos empresas podrían compartir nombre con distinta tildes. El listado
// de organizaciones es corto (una decena como mucho), por lo que el barrido en
// memoria es más barato y correcto que cualquier truco de collation.
function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function nameTaken(name, exceptId = null) {
  const target = normalizeName(name);
  if (!target) return false;
  const rows = await runtime.queryMany('SELECT id, name FROM organizations');
  return rows.some((o) => o.id !== exceptId && normalizeName(o.name) === target);
}

// Detalle con los conteos operativos que necesita el SUPERADMIN para decidir
// si una empresa puede apagarse. Los conteos son globales aquí porque sólo el
// SUPERADMIN puede invocar este canal.
const DETAIL_SQL = `
  SELECT o.*,
         (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS users_count,
         (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id AND u.active = 1) AS active_users_count,
         (SELECT COUNT(*) FROM tickets t WHERE t.organization_id = o.id) AS tickets_count
  FROM organizations o
`;

async function orgOr404(req, res) {
  const id = parseIntSafe(req.params.id);
  if (!id) {
    res.status(404).json({ error: 'Organización no encontrada' });
    return null;
  }
  const row = await runtime.queryOne(`${DETAIL_SQL} WHERE o.id = ?`, id);
  if (!row) {
    res.status(404).json({ error: 'Organización no encontrada' });
    return null;
  }
  return row;
}

router.get('/', async (req, res) => {
  try {
    const rows = await runtime.queryMany(`${DETAIL_SQL} ORDER BY o.name`);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const org = await orgOr404(req, res);
    if (!org) return;
    res.json({ organization: org });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.organization_id !== undefined && body.organization_id !== null && body.organization_id !== '') {
      return res.status(400).json({ error: 'La organización no puede ser establecida desde el cliente' });
    }
    const code = safeStr(body.code).toUpperCase();
    const name = safeStr(body.name);
    const description = safeStr(body.description);

    validate({
      code: rules.required(code, 'Código') + rules.max(code, 20, 'Código'),
      name: rules.required(name, 'Nombre') + rules.max(name, 120, 'Nombre'),
      description: rules.max(description, 500, 'Descripción'),
    });
    if (!CODE_RE.test(code)) {
      return res.status(400).json({
        error: 'El código debe tener entre 2 y 20 caracteres (letras, números, guion bajo o guion) y empezar por alfanumérico',
      });
    }

    if (await runtime.queryOne('SELECT id FROM organizations WHERE LOWER(code) = LOWER(?)', code)) {
      return res.status(409).json({ error: 'Ya existe una organización con ese código' });
    }
    if (await nameTaken(name)) {
      return res.status(409).json({ error: 'Ya existe una organización con ese nombre' });
    }

    const result = await runtime.insertAndGetId(
      'INSERT INTO organizations (code, name, description, active, created_at) VALUES (?, ?, ?, 1, ?)',
      code, name, description || null, nowIso()
    );
    const created = await runtime.queryOne(`${DETAIL_SQL} WHERE o.id = ?`, result.id);
    res.status(201).json({ organization: created });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

// Edición de datos básicos. `code` es inmutable (identifica la empresa en
// exports, auditorías y migraciones futuras) y `organization_id` no se acepta
// nunca del cuerpo: este canal no lo necesita y rechazarlo explícitamente
// evita cualquier intento de reasignación masiva de campos.
router.patch('/:id', async (req, res) => {
  try {
    const org = await orgOr404(req, res);
    if (!org) return;

    const body = req.body || {};
    if (body.organization_id !== undefined && body.organization_id !== null && body.organization_id !== '') {
      return res.status(400).json({ error: 'La organización no puede ser establecida desde el cliente' });
    }
    if (body.code !== undefined && safeStr(body.code).toUpperCase() !== org.code) {
      return res.status(400).json({ error: 'El código de una organización no se puede modificar' });
    }

    const name = body.name === undefined ? org.name : safeStr(body.name);
    const description = body.description === undefined ? (org.description || '') : safeStr(body.description);
    const active = body.active === undefined ? org.active : body.active ? 1 : 0;

    validate({
      name: rules.required(name, 'Nombre') + rules.max(name, 120, 'Nombre'),
      description: rules.max(description, 500, 'Descripción'),
    });

    if (await nameTaken(name, org.id)) {
      return res.status(409).json({ error: 'Ya existe una organización con ese nombre' });
    }

    await runtime.execute(
      'UPDATE organizations SET name = ?, description = ?, active = ?, updated_at = ? WHERE id = ?',
      name, description || null, active, nowIso(), org.id
    );

    const updated = await runtime.queryOne(`${DETAIL_SQL} WHERE o.id = ?`, org.id);
    res.json({ organization: updated });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
