import express from 'express';
import { contract } from '../db.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { saveDirectorySnapshot } from '../directorySync.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Migrado al contrato en A5: consultas con parámetros nombrados y binding
// nativo. `departments` no tiene columna `updated_at`, así que el UPDATE no
// escribe marca de tiempo. Por eso el `nowIso` que se importaba aquí no se
// usaba, y por eso no se ha añadido nada para compensarlo.
//
// `saveDirectorySnapshot()` sigue siendo síncrono y se sigue llamando en el
// mismo punto: después del INSERT/UPDATE y antes de leer la fila para la
// respuesta. Va sin `await` a propósito, igual que antes.
const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const onlyActive = req.query.active === '1' || req.query.active === 'true';
  const rows = onlyActive
    ? await contract.queryMany('SELECT * FROM departments WHERE active = 1 ORDER BY name')
    : await contract.queryMany('SELECT * FROM departments ORDER BY name');
  res.json({ data: rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = await contract.queryOne('SELECT * FROM departments WHERE id = :id', { id });
  if (!row) return res.status(404).json({ error: 'Departamento no encontrado' });
  res.json({ department: row });
}));

router.post('/', requirePermission('department.manage'), asyncHandler(async (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const existente = await contract.queryOne('SELECT id FROM departments WHERE LOWER(name) = LOWER(:name)', { name });
  if (existente) {
    return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });
  }
  const { id } = await contract.insertAndGetId(
    'INSERT INTO departments (name, description) VALUES (:name, :description)',
    { name, description },
  );
  saveDirectorySnapshot();
  res.status(201).json({ department: await contract.queryOne('SELECT * FROM departments WHERE id = :id', { id }) });
}));

router.patch('/:id', requirePermission('department.manage'), asyncHandler(async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = await contract.queryOne('SELECT * FROM departments WHERE id = :id', { id });
  if (!existing) return res.status(404).json({ error: 'Departamento no encontrado' });

  const name = safeStr(req.body.name ?? existing.name);
  const description = safeStr(req.body.description ?? existing.description ?? '');
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;

  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre') });

  const dup = await contract.queryOne(
    'SELECT id FROM departments WHERE LOWER(name) = LOWER(:name) AND id != :id',
    { name, id },
  );
  if (dup) return res.status(409).json({ error: 'Ya existe un departamento con ese nombre' });

  await contract.execute(
    'UPDATE departments SET name = :name, description = :description, active = :active WHERE id = :id',
    { name, description, active, id },
  );
  saveDirectorySnapshot();
  res.json({ department: await contract.queryOne('SELECT * FROM departments WHERE id = :id', { id }) });
}));

export default router;