import crypto from 'node:crypto';
import express from 'express';
import runtime from '../db/runtime.js';
import { nowIso } from '../utils/time.js';
import { hashPassword } from '../utils/password.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission, requireAnyPermission, publicUser } from '../middleware/auth.js';
import { saveDirectorySnapshot } from '../directorySync.js';
import { destroyUserSessions } from '../utils/sessionStore.js';
import { currentOrgId, rejectClientOrg } from '../middleware/org.js';
import { SUPERADMIN_ROLE_CODE, isSuperadminRoleCode, orgStateError } from '../orgPolicy.js';

const router = express.Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT u.id, u.name, u.last_name, u.username, u.email, u.department_id, u.position,
         u.role_id, u.organization_id, u.active, u.created_at, u.last_login_at, u.last_password_change_at,
         r.code AS role_code, r.name AS role_name, d.name AS department_name,
         o.name AS organization_name,
         (SELECT COUNT(*) FROM tickets t WHERE t.reporter_id = u.id) AS tickets_count
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN organizations o ON o.id = u.organization_id
  WHERE 1=1
`;

function userWhere() {
  const conditions = [];
  const params = [];
  return { conditions, params };
}

async function buildListQuery(req) {
  const { conditions, params } = userWhere();
  const org = currentOrgId(req.user);
  if (org) {
    conditions.push('u.organization_id = ?');
    params.push(org);
  } else {
    conditions.push('1 = 0');
  }
  if (req.query.search) {
    conditions.push('(u.name LIKE ? OR u.last_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
    const like = `%${req.query.search}%`;
    params.push(like, like, like, like);
  }
  const dept = parseIntSafe(req.query.department);
  if (dept) {
    conditions.push('u.department_id = ?');
    params.push(dept);
  }
  const role = parseIntSafe(req.query.role);
  if (role) {
    conditions.push('u.role_id = ?');
    params.push(role);
  }
  if (req.query.status === 'active') conditions.push('u.active = 1');
  if (req.query.status === 'inactive') conditions.push('u.active = 0');

  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseIntSafe(req.query.perPage) || 15));
  const where = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';

  const total = (await runtime.queryOne(`SELECT COUNT(*) AS n FROM users u ${where.replace(/^ AND /, 'WHERE ')}`, ...params)).n;
  const orderBy = 'u.created_at DESC, u.id DESC';
  const data = await runtime.queryMany(`${LIST_SQL}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, perPage, (page - 1) * perPage);

  return { data: data.map(publicUser), total, page, perPage, pages: Math.ceil(total / perPage) };
}

router.get('/', requirePermission('user.view'), async (req, res) => {
  try {
    res.json(await buildListQuery(req));
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/roles', requirePermission('user.view'), async (req, res) => {
  try {
    const roles = await runtime.queryMany('SELECT * FROM roles ORDER BY id');
    const perms = await runtime.queryMany('SELECT code FROM permissions ORDER BY id').then(rows => rows.map(p => p.code));
    const rolePerms = await runtime.queryMany(`
      SELECT rp.role_id, p.code FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id`);
    const map = {};
    for (const rp of rolePerms) {
      (map[rp.role_id] = map[rp.role_id] || []).push(rp.code);
    }
    res.json({
      roles: roles.map(r => ({ ...r, permissions: map[r.id] || [] })),
      permissions: perms,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/', requirePermission('user.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const rejected = rejectClientOrg(body);
    if (rejected) return res.status(400).json({ error: rejected });
    const name = body.name;
    const lastName = body.last_name;
    const username = safeStr(body.username);
    const email = safeStr(body.email);
    const password = String(body.password || '');
    const departmentId = body.department_id == null || body.department_id === '' ? null : parseIntSafe(body.department_id);
    const position = safeStr(body.position);
    const roleId = parseIntSafe(body.role_id);

    validate({
      name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre'),
      last_name: rules.required(lastName, 'Apellidos') + rules.max(lastName, 100, 'Apellidos'),
      username: rules.required(username, 'Usuario') + rules.username(username),
      email: rules.required(email, 'Correo') + rules.email(email),
      password: rules.password(password),
      role: rules.required(roleId, 'Rol'),
    });

    const role = await runtime.queryOne('SELECT id, code FROM roles WHERE id = ? AND active = 1', roleId);
    if (!role) return res.status(400).json({ error: 'Rol inválido' });

    let organizationId = req.user.organization_id;
    if (isSuperadminRoleCode(role.code)) {
      if (!req.user.is_superadmin) {
        return res.status(403).json({ error: 'Solo un superadministrador puede asignar el rol SUPERADMIN' });
      }
      organizationId = null;
    }

    const stateError = await orgStateError({ roleCode: role.code, organizationId });
    if (stateError) return res.status(400).json({ error: stateError });

    if (departmentId) {
      const dept = await runtime.queryOne('SELECT id, organization_id FROM departments WHERE id = ?', departmentId);
      if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
      if (dept.organization_id !== organizationId) {
        return res.status(400).json({ error: 'El departamento debe pertenecer a la organización del usuario' });
      }
    }
    if (await runtime.queryOne('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', username)) {
      return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    }
    if (await runtime.queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', email)) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    const info = await runtime.insertAndGetId(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, organization_id, last_password_change_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, lastName, username, email, hashPassword(password), departmentId, position, roleId, organizationId, nowIso()
    );

    await saveDirectorySnapshot();
    const row = await runtime.queryOne(`${LIST_SQL} AND u.id = ?`, info.id);
    res.status(201).json({ user: publicUser(row) });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get(
  '/assignable',
  requireAnyPermission(['ticket.assign', 'ticket.view.all', 'team.manage']),
  async (req, res) => {
    try {
      const rows = await runtime.queryMany(
        `SELECT u.id, u.name, u.last_name, u.position, d.name AS department_name FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.active = 1 AND u.organization_id = ? ORDER BY u.name, u.last_name`,
        currentOrgId(req.user)
      );
      res.json({ data: rows });
    } catch (err) {
      res.status(500).json({ error: 'Error interno' });
    }
  }
);

router.get('/:id/tickets', async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const target = await runtime.queryOne(
      'SELECT id, name, last_name FROM users WHERE id = ? AND organization_id = ?',
      id, currentOrgId(req.user)
    );
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isSelf = req.user.id === id;
    const canViewAny =
      req.user.permissions.includes('ticket.view.all') || req.user.permissions.includes('user.view');
    if (!isSelf && !canViewAny) {
      return res.status(403).json({ error: 'No tiene permiso para ver el historial de este usuario' });
    }

    const scope = req.query.scope === 'assigned' ? 'assigned' : 'reported';
    const col = scope === 'assigned' ? 't.assigned_to_id' : 't.reporter_id';

    const page = Math.max(1, parseIntSafe(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, parseIntSafe(req.query.perPage) || 10));

    const total = (await runtime.queryOne(`SELECT COUNT(*) AS n FROM tickets t WHERE ${col} = ?`, id)).n;

    const byStatusRows = await runtime.queryMany(
      `SELECT t.status, COUNT(*) AS n FROM tickets t WHERE ${col} = ? GROUP BY t.status`,
      id
    );
    const byStatus = {};
    for (const r of byStatusRows) byStatus[r.status] = r.n;

    const data = await runtime.queryMany(
      `SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.created_at, t.updated_at,
              t.resolved_at, t.closed_at, t.sla_due_at,
              c.name AS category_name, c.color AS category_color,
              d.name AS department_name,
              COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name,
              COALESCE(te.name, '') AS team_name,
              CASE WHEN t.sla_due_at IS NOT NULL
                        AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')
                        AND t.sla_due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                   THEN 1 ELSE 0 END AS is_overdue
         FROM tickets t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN departments d ON d.id = t.department_id
         LEFT JOIN users au ON au.id = t.assigned_to_id
         LEFT JOIN teams te ON te.id = t.assigned_team_id
         WHERE ${col} = ?
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ? OFFSET ?`,
      id, perPage, (page - 1) * perPage
    );

    res.json({
      user: { id: target.id, name: `${target.name} ${target.last_name}` },
      scope,
      data,
      by_status: byStatus,
      total,
      page,
      perPage,
      pages: Math.ceil(total / perPage),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id', requirePermission('user.view'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const row = await runtime.queryOne(`${LIST_SQL} AND u.id = ? AND u.organization_id = ?`, id, currentOrgId(req.user));
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user: publicUser(row) });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id', requirePermission('user.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const existing = await runtime.queryOne(
      'SELECT id, name, last_name, department_id, position, username, email, role_id, organization_id FROM users WHERE id = ?',
      id
    );
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const existingRole = await runtime.queryOne('SELECT code FROM roles WHERE id = ?', existing.role_id);
    if (isSuperadminRoleCode(existingRole?.code) && !req.user.is_superadmin) {
      return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
    }

    const org = currentOrgId(req.user);
    if (existing.organization_id !== org) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const name = safeStr(has('name') ? body.name : existing.name);
    const lastName = safeStr(has('last_name') ? body.last_name : existing.last_name);
    const username = safeStr(has('username') ? body.username : existing.username);
    const email = safeStr(has('email') ? body.email : existing.email);
    const departmentId = has('department_id')
      ? body.department_id === '' || body.department_id == null
        ? null
        : parseIntSafe(body.department_id)
      : existing.department_id;
    const position = safeStr(has('position') ? body.position : existing.position ?? '');
    const roleId = body.role_id == null || body.role_id === '' ? existing.role_id : parseIntSafe(body.role_id);

    if (id === req.user.id && roleId && roleId !== existing.role_id) {
      return res.status(400).json({ error: 'No puede modificar su propio rol; solicítelo a otro administrador.' });
    }

    validate({
      name: rules.required(name, 'Nombre') + rules.max(name, 100, 'Nombre'),
      last_name: rules.required(lastName, 'Apellidos') + rules.max(lastName, 100, 'Apellidos'),
      username: rules.required(username, 'Usuario') + rules.username(username),
      email: rules.required(email, 'Correo') + rules.email(email),
    });

    const other = await runtime.queryOne('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?', username, id);
    if (other) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    const otherMail = await runtime.queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?', email, id);
    if (otherMail) return res.status(409).json({ error: 'El correo ya está registrado' });

    const role = await runtime.queryOne('SELECT id, code FROM roles WHERE id = ? AND active = 1', roleId);
    if (!role) return res.status(400).json({ error: 'Rol inválido' });

    let nextOrg = existing.organization_id;
    if (isSuperadminRoleCode(role.code)) {
      if (isSuperadminRoleCode(existingRole?.code)) {
      } else if (!req.user.is_superadmin) {
        return res.status(403).json({ error: 'Solo un superadministrador puede asignar el rol SUPERADMIN' });
      } else {
        nextOrg = null;
      }
    } else if (isSuperadminRoleCode(existingRole?.code)) {
      return res.status(400).json({
        error: 'Convertir un SUPERADMIN a un rol de organización requiere aprovisionar una organización; no disponible todavía',
      });
    } else {
      const stateError = await orgStateError({ roleCode: role.code, organizationId: existing.organization_id });
      if (stateError) return res.status(400).json({ error: stateError });
    }

    let departmentIdFinal = departmentId;
    if (isSuperadminRoleCode(role.code)) {
      if (has('department_id') && departmentId) {
        return res.status(400).json({ error: 'El rol SUPERADMIN no pertenece a ningún departamento' });
      }
      departmentIdFinal = null;
    } else if (departmentIdFinal) {
      const dept = await runtime.queryOne('SELECT id, organization_id FROM departments WHERE id = ?', departmentIdFinal);
      if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
      if (dept.organization_id !== nextOrg) {
        return res.status(400).json({ error: 'El departamento debe pertenecer a la organización del usuario' });
      }
    }

    await runtime.execute(
      `UPDATE users SET name = ?, last_name = ?, username = ?, email = ?, department_id = ?, position = ?, role_id = ?,
       organization_id = ?, updated_at = ? WHERE id = ?`,
      name, lastName, username, email, departmentIdFinal, position, roleId, nextOrg, nowIso(), id
    );

    await saveDirectorySnapshot();
    const row = await runtime.queryOne(`${LIST_SQL} AND u.id = ?`, id);
    res.json({ user: publicUser(row) });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Datos inválidos', fields: err.fields });
    }
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id/status', requirePermission('user.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const active = req.body.active === true || req.body.active === 1 || req.body.active === '1';

    if (id === req.user.id && !active) {
      return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
    }

    const existing = await runtime.queryOne('SELECT id, active, organization_id FROM users WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const targetRole = await runtime.queryOne(
      'SELECT r.code FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?',
      id
    );
    if (isSuperadminRoleCode(targetRole?.code) && !req.user.is_superadmin) {
      return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
    }

    const org = currentOrgId(req.user);
    if (existing.organization_id !== org) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!active && existing.active) {
      const esAdmin = await runtime.queryOne(
        'SELECT id FROM users WHERE id = ? AND role_id = (SELECT id FROM roles WHERE code = ?)',
        id, 'ADMIN'
      );
      const adminsEnOrg = (await runtime.queryOne(`
        SELECT COUNT(*) AS n FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE r.code = 'ADMIN' AND u.active = 1 AND u.organization_id = ?
      `, existing.organization_id)).n;
      if (esAdmin && adminsEnOrg <= 1) {
        return res.status(400).json({ error: 'Debe existir al menos un administrador activo en la organización' });
      }
    }

    await runtime.execute('UPDATE users SET active = ?, updated_at = ? WHERE id = ?', active ? 1 : 0, nowIso(), id);
    await saveDirectorySnapshot();
    const row = await runtime.queryOne(`${LIST_SQL} AND u.id = ?`, id);
    res.json({ user: publicUser(row) });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/reset-password', requirePermission('user.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const targetRole = await runtime.queryOne(
      'SELECT r.code, u.organization_id FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?',
      id
    );
    if (targetRole && isSuperadminRoleCode(targetRole.code) && !req.user.is_superadmin) {
      return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
    }

    const org = currentOrgId(req.user);
    if (!targetRole || targetRole.organization_id !== org) {
      return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
    }

    const existing = await runtime.queryOne('SELECT id, name, username FROM users WHERE id = ? AND active = 1', id);
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await runtime.execute(
      'UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = ? WHERE id = ?',
      hash, expires, nowIso(), id
    );

    await destroyUserSessions(id);

    res.json({
      ok: true,
      token,
      expires,
      message: 'Token generado. Compártalo de forma segura con el usuario. Caduca en 24 horas.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;