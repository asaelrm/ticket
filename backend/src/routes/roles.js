import express from 'express';
import runtime from '../db/runtime.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, requireSuperadmin } from '../middleware/org.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', requirePermission('role.manage'), async (req, res) => {
  try {
    const roles = await runtime.queryMany('SELECT * FROM roles ORDER BY id');
    const rolePerms = await runtime.queryMany(`
      SELECT rp.role_id, p.code FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id`);
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
    let counts = new Map();
    if (org) {
      const rows = await runtime.queryMany(
        'SELECT role_id, COUNT(*) AS n FROM users WHERE organization_id = ? GROUP BY role_id',
        org
      );
      counts = new Map(rows.map((r) => [r.role_id, r.n]));
    }
    res.json({
      roles: roles.map((r) => ({
        ...r,
        permissions: map[r.id] || [],
        users: org ? counts.get(r.id) || 0 : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/permissions', requirePermission('role.manage'), async (req, res) => {
  try {
    res.json({ permissions: await runtime.queryMany('SELECT * FROM permissions ORDER BY id') });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// V2 (aislamiento multiempresa): `roles` y `role_permissions` son tablas
// GLOBALES sin `organization_id`, así que un cambio aquí alcanza a las
// organizaciones de todas las empresas. El permiso `role.manage` lo tienen los
// administradores de cada organización, de modo que por sí solo no basta para
// proteger este canal: solo el SUPERADMIN global puede modificar la matriz de
// permisos. El guard interno sobre el rol SUPERADMIN se conserva por
// redundancia (defensa en profundidad).
router.patch('/:id/permissions', requirePermission('role.manage'), requireSuperadmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = await runtime.queryOne('SELECT id, code FROM roles WHERE id = ?', id);
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
    const valid = new Set((await runtime.queryMany('SELECT code FROM permissions')).map((p) => p.code));
    for (const c of codes) {
      if (!valid.has(c)) return res.status(400).json({ error: `Permiso desconocido: ${c}` });
    }

    await runtime.transaction(async (tx) => {
      await tx.execute('DELETE FROM role_permissions WHERE role_id = ?', id);
      for (const code of codes) {
        const p = await tx.queryOne('SELECT id FROM permissions WHERE code = ?', code);
        if (p) await tx.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', id, p.id);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
