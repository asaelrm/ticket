import express from 'express';
import runtime from '../db/runtime.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireSuperadmin, currentOrgId } from '../middleware/org.js';
import { parseIntSafe, safeStr, validate, rules } from '../utils/validation.js';

const router = express.Router();
router.use(requireAuth);

const catalog = `SELECT s.*, CASE WHEN s.active = 1 THEN 1 ELSE 0 END AS enabled
  FROM sifha_systems s`;

router.get('/available', async (req, res) => {
  const org = currentOrgId(req.user);
  if (!org) return res.json({ systems: [] });
  const systems = await runtime.queryMany(`${catalog}
    JOIN organization_sifha_systems os ON os.sifha_system_id = s.id
    WHERE os.organization_id = ? AND os.active = 1 AND s.active = 1 ORDER BY s.name`, org);
  res.json({ systems });
});

router.get('/', requirePermission('organization.manage'), requireSuperadmin, async (req, res) => {
  res.json({ systems: await runtime.queryMany(`${catalog} ORDER BY s.name`) });
});

router.post('/', requirePermission('organization.manage'), requireSuperadmin, async (req, res) => {
  const code = safeStr(req.body?.code).toUpperCase();
  const name = safeStr(req.body?.name);
  const description = safeStr(req.body?.description);
  validate({ code: rules.required(code, 'Código') + rules.max(code, 80, 'Código'), name: rules.required(name, 'Nombre') + rules.max(name, 200, 'Nombre'), description: rules.max(description, 1000, 'Descripción') });
  const exists = await runtime.queryOne('SELECT id FROM sifha_systems WHERE code = ?', code);
  if (exists) return res.status(409).json({ error: 'Ya existe un producto con ese código' });
  const result = await runtime.insertAndGetId('INSERT INTO sifha_systems (code, name, description, active, created_at) VALUES (?, ?, ?, 1, ?)', code, name, description || null, new Date().toISOString());
  res.status(201).json({ system: await runtime.queryOne(`${catalog} WHERE s.id = ?`, result.id) });
});

router.patch('/:id', requirePermission('organization.manage'), requireSuperadmin, async (req, res) => {
  const id = parseIntSafe(req.params.id);
  const current = await runtime.queryOne('SELECT * FROM sifha_systems WHERE id = ?', id);
  if (!current) return res.status(404).json({ error: 'Producto SIFHA no encontrado' });
  const name = req.body?.name === undefined ? current.name : safeStr(req.body.name);
  const description = req.body?.description === undefined ? current.description : safeStr(req.body.description);
  const active = req.body?.active === undefined ? current.active : (req.body.active ? 1 : 0);
  validate({ name: rules.required(name, 'Nombre') + rules.max(name, 200, 'Nombre'), description: rules.max(description, 1000, 'Descripción') });
  await runtime.execute('UPDATE sifha_systems SET name = ?, description = ?, active = ?, updated_at = ? WHERE id = ?', name, description || null, active, new Date().toISOString(), id);
  res.json({ system: await runtime.queryOne(`${catalog} WHERE s.id = ?`, id) });
});

router.get('/organizations/:organizationId', requirePermission('organization.manage'), requireSuperadmin, async (req, res) => {
  const org = parseIntSafe(req.params.organizationId);
  res.json({ systems: await runtime.queryMany(`${catalog} LEFT JOIN organization_sifha_systems os ON os.sifha_system_id = s.id AND os.organization_id = ? WHERE os.active = 1 ORDER BY s.name`, org) });
});

router.put('/organizations/:organizationId', requirePermission('organization.manage'), requireSuperadmin, async (req, res) => {
  const org = parseIntSafe(req.params.organizationId);
  const ids = [...new Set((req.body?.sifha_system_ids || []).map(parseIntSafe).filter(Boolean))];
  await runtime.transaction(async (tx) => {
    for (const id of ids) {
      if (!await tx.queryOne('SELECT id FROM sifha_systems WHERE id = ?', id)) continue;
      await tx.execute(`MERGE organization_sifha_systems AS target USING (SELECT ? AS organization_id, ? AS sifha_system_id) AS source ON target.organization_id = source.organization_id AND target.sifha_system_id = source.sifha_system_id WHEN MATCHED THEN UPDATE SET active = 1, updated_at = SYSUTCDATETIME(), assigned_by = ? WHEN NOT MATCHED THEN INSERT (organization_id, sifha_system_id, active, assigned_by) VALUES (source.organization_id, source.sifha_system_id, 1, ?);`, org, id, req.user.id, req.user.id);
    }
    if (ids.length) await tx.execute(`UPDATE organization_sifha_systems SET active = 0, updated_at = SYSUTCDATETIME() WHERE organization_id = ? AND sifha_system_id NOT IN (${ids.map(() => '?').join(',')})`, org, ...ids);
    else await tx.execute('UPDATE organization_sifha_systems SET active = 0, updated_at = SYSUTCDATETIME() WHERE organization_id = ?', org);
  });
  res.json({ systems: await runtime.queryMany(`${catalog} JOIN organization_sifha_systems os ON os.sifha_system_id = s.id WHERE os.organization_id = ? AND os.active = 1 ORDER BY s.name`, org) });
});

export default router;
