import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, requireSuperadmin } from '../middleware/org.js';

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
  // ETAPA 2: los roles son plantillas globales, pero el conteo de cuántos
  // usuarios tiene cada rol es dato de la organización del solicitante. Un
  // admin de ORG_A no debe conocer la masa de usuarios de ORG_B.
  // ETAPA 3: un SUPERADMIN sin contexto de organización (organization_id NULL)
  // NO obtiene conteos globales de usuarios tenant aquí: sin organización el
  // conteo es 0 (compatibilidad de API: el campo `users` sigue presente). Los
  // roles permanecen como plantillas globales; nunca se les añade
  // organization_id.
  const org = currentOrgId(req.user);
  const countUsers = org
    ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND organization_id = ?')
    : null;
  res.json({
    roles: roles.map((r) => ({
      ...r,
      permissions: map[r.id] || [],
      users: countUsers ? countUsers.get(r.id, org).n : 0,
    })),
  });
});

router.get('/permissions', requirePermission('role.manage'), (req, res) => {
  res.json({ permissions: db.prepare('SELECT * FROM permissions ORDER BY id').all() });
});

// V2 (aislamiento multiempresa): `roles` y `role_permissions` son tablas
// GLOBALES sin `organization_id`, así que un cambio aquí alcanza a las
// organizaciones de todas las empresas. El permiso `role.manage` lo tienen los
// administradores de cada organización, de modo que por sí solo no basta para
// proteger este canal: solo el SUPERADMIN global puede modificar la matriz de
// permisos. El guard interno sobre el rol SUPERADMIN se conserva por
// redundancia (defensa en profundidad).
router.patch('/:id/permissions', requirePermission('role.manage'), requireSuperadmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = db.prepare('SELECT id, code FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ error: 'Rol no encontrado' });
  // El rol SUPERADMIN es intocable para un administrador normal: solo otro
  // SUPERADMIN puede alterar sus permisos. Sin esta barrera, un admin con
  // role.manage podría recortar o ampliar el rol global y escalar.
  if (role.code === 'SUPERADMIN' && !req.user.is_superadmin) {
    return res.status(403).json({ error: 'Solo un superadministrador puede modificar el rol SUPERADMIN' });
  }
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