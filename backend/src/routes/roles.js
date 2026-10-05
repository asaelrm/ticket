import express from 'express';
import db, { contract } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePermission('role.manage'), (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const rolePerms = db.prepare(`
    SELECT rp.role_id, p.code FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id`).all();
  const map = {};
  for (const rp of rolePerms) {
    (map[rp.role_id] = map[rp.role_id] || []).push(rp.code);
  }
  res.json({
    roles: roles.map((r) => ({
      ...r,
      permissions: map[r.id] || [],
      users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(r.id).n,
    })),
  });
});

router.get('/permissions', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const permissions = await contract.queryMany('SELECT * FROM permissions ORDER BY id');
  res.json({ permissions });
}));

router.patch('/:id/permissions', requirePermission('role.manage'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT id, code FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Rol no encontrado' });
  if (role.code === 'ADMIN') {
    return res.status(400).json({ error: 'El rol Administrador siempre conserva todos los permisos' });
  }

  const codes = Array.isArray(req.body.permissions) ? req.body.permissions : [];
  const valid = new Set(db.prepare('SELECT code FROM permissions').all().map((p) => p.code));
  for (const c of codes) {
    if (!valid.has(c)) return res.status(400).json({ error: `Permiso desconocido: ${c}` });
  }

  await contract.transactionAsync(async (tx) => {
    await tx.execute('DELETE FROM role_permissions WHERE role_id = @roleId', { roleId: id });
    for (const code of codes) {
      const permission = await tx.queryOne('SELECT id FROM permissions WHERE code = @code', { code });
      if (permission) {
        await tx.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (@roleId, @permissionId)',
          { roleId: id, permissionId: permission.id },
        );
      }
    }
  });

  res.json({ ok: true });
}));

export default router;
