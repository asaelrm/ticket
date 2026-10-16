import express from 'express';
import runtime from '../db/runtime.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg, requireOrg } from '../middleware/org.js';
import { saveDirectorySnapshot } from '../directorySync.js';

const router = express.Router();
router.use(requireAuth);

// ETAPA 2 (aislamiento por organización): los departamentos se listan SIEMPRE
// dentro de la organización del contexto de sesión. Un SUPERADMIN sin contexto
// (organization_id NULL) obtiene una lista vacía: las operaciones multiempresa
// explícitas llegan en etapas posteriores; las rutas normales no deben exponer
// de golpe los datos de todas las organizaciones.
router.get('/', async (req, res) => {
  try {
    const onlyActive = req.query.active === '1' || req.query.active === 'true';
    const org = currentOrgId(req.user);
    const rows = onlyActive
      ? await runtime.queryMany('SELECT * FROM departments WHERE active = 1 AND organization_id = ? ORDER BY name', org)
      : await runtime.queryMany('SELECT * FROM departments WHERE organization_id = ? ORDER BY name', org);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Detalle: alias de organización devuelve 404 (no revela la existencia de un
// recurso de otra organización). Un SUPERADMIN sin contexto (org NULL) también
// obtiene 404: las rutas normales exigen una organización real; la
// administración global explícita llega en etapas posteriores.
router.get('/:id', async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const row = await runtime.queryOne('SELECT * FROM departments WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!row) return res.status(404).json({ error: 'Departamento no encontrado' });
    res.json({ department: row });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Creación: exige contexto de organización (p. ej. un SUPERADMIN global no crea
// departamentos sueltos sin elegir organización) y rechaza que el cliente
// intente fijar `organization_id` en el cuerpo.
router.post('/', requirePermission('department.manage'), requireOrg, async (req, res) => {
  try {
    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = safeStr(req.body.name);
    const description = safeStr(req.body.description);

    validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

    // El nombre sigue siendo único global (SQLite). Que dos organizaciones no
    // puedan tener "Ventas" a la vez es una limitación conocida que se resuelve
    // cuando el esquema pase a MSSQL; la organización del nuevo registro es la
    // del contexto de sesión.
    const existingName = await runtime.queryOne('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)', name);
    if (existingName) {
      return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });
    }
    const organizationId = currentOrgId(req.user);
    const result = await runtime.insertAndGetId('INSERT INTO departments (name, description, organization_id) VALUES (?, ?, ?)', name, description, organizationId);
    await saveDirectorySnapshot();
    const department = await runtime.queryOne('SELECT * FROM departments WHERE id = ?', result.id);
    res.status(201).json({ department });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

// Edición: misma regla de alias — 404 si el departamento pertenece a otra
// organización (o si el actor carece de contexto), y la organización nunca se
// modifica desde el cliente.
router.patch('/:id', requirePermission('department.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const existing = await runtime.queryOne('SELECT * FROM departments WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!existing) return res.status(404).json({ error: 'Departamento no encontrado' });

    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = safeStr(req.body.name ?? existing.name);
    const description = safeStr(req.body.description ?? existing.description ?? '');
    const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

    validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

    const dup = await runtime.queryOne('SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id != ?', name, id);
    if (dup) return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });

    await runtime.execute('UPDATE departments SET name = ?, description = ?, active = ? WHERE id = ?', name, description, active, id);
    await saveDirectorySnapshot();
    const department = await runtime.queryOne('SELECT * FROM departments WHERE id = ?', id);
    res.json({ department });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
