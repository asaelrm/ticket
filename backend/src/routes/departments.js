import express from 'express';
import db, { nowIso } from '../db.js';
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
router.get('/', (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const org = currentOrgId(req.user);
  const rows = onlyActive
    ? db.prepare('SELECT * FROM departments WHERE active = 1 AND organization_id = ? ORDER BY name').all(org)
    : db.prepare('SELECT * FROM departments WHERE organization_id = ? ORDER BY name').all(org);
  res.json({ data: rows });
});

// Detalle: alias de organización devuelve 404 (no revela la existencia de un
// recurso de otra organización). Un SUPERADMIN puede pedir un departamento por
// id explícito (COALESCE con NULL resuelve a cualquier organización).
router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare('SELECT * FROM departments WHERE id = ? AND organization_id = COALESCE(?, organization_id)')
    .get(id, currentOrgId(req.user));
  if (!row) return res.status(404).json({ error: 'Departamento no encontrado' });
  res.json({ department: row });
});

// Creación: exige contexto de organización (p. ej. un SUPERADMIN global no crea
// departamentos sueltos sin elegir organización) y rechaza que el cliente
// intente fijar `organization_id` en el cuerpo.
router.post('/', requirePermission('department.manage'), requireOrg, (req, res) => {
  const rejected = rejectClientOrg(req.body || {});
  if (rejected) return res.status(400).json({ error: rejected });

  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  // El nombre sigue siendo único global (SQLite). Que dos organizaciones no
  // puedan tener "Ventas" a la vez es una limitación conocida que se resuelve
  // cuando el esquema pase a MSSQL; la organización del nuevo registro es la
  // del contexto de sesión.
  if (db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });
  }
  const organizationId = currentOrgId(req.user);
  const info = db.prepare('INSERT INTO departments (name, description, organization_id) VALUES (?, ?, ?)')
    .run(name, description, organizationId);
  saveDirectorySnapshot();
  res.status(201).json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid) });
});

// Edición: misma regla de alias — 404 si el departamento pertenece a otra
// organización, y la organización nunca se modifica desde el cliente.
router.patch('/:id', requirePermission('department.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM departments WHERE id = ? AND organization_id = COALESCE(?, organization_id)')
    .get(id, currentOrgId(req.user));
  if (!existing) return res.status(404).json({ error: 'Departamento no encontrado' });

  const rejected = rejectClientOrg(req.body || {});
  if (rejected) return res.status(400).json({ error: rejected });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = db.prepare('SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });

  db.prepare('UPDATE departments SET name = ?, description = ?, active = ? WHERE id = ?').run(name, description, active, id);
  saveDirectorySnapshot();
  res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(id) });
});

export default router;
