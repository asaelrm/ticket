import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

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

router.get('/permissions', requirePermission('role.manage'), (req, res) => {
  res.json({ permissions: db.prepare('SELECT * FROM permissions ORDER BY id').all() });
});

router.patch('/:id/permissions', requirePermission('role.manage'), (req, res) => {
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

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    const stmt = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (const code of codes) {
      const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code);
      if (p) stmt.run(id, p.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});

export default router;