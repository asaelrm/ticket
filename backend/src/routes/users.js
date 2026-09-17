import crypto from 'node:crypto';
import express from 'express';
import db, { nowIso } from '../db.js';
import { hashPassword } from '../utils/password.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission, publicUser } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT u.id, u.name, u.last_name, u.username, u.email, u.department_id, u.position,
         u.role_id, u.active, u.created_at, u.last_login_at, u.last_password_change_at,
         r.code AS role_code, r.name AS role_name, d.name AS department_name,
         (SELECT COUNT(*) FROM tickets t WHERE t.reporter_id = u.id) AS tickets_count
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE 1=1
`;

function userWhere() {
  const conditions = [];
  const params = [];
  return { conditions, params };
}

function buildListQuery(req) {
  const { conditions, params } = userWhere();
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

  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${where.replace(/^ AND /, 'WHERE ')}`).get(...params).n;
  const orderBy = 'u.created_at DESC, u.id DESC';
  const data = db
    .prepare(`${LIST_SQL}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);

  return { data: data.map(publicUser), total, page, perPage, pages: Math.ceil(total / perPage) };
}

router.get('/', requirePermission('user.view'), (req, res) => {
  res.json(buildListQuery(req));
});

router.get('/roles', requirePermission('user.view'), (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const perms = db.prepare('SELECT code FROM permissions ORDER BY id').all().map((p) => p.code);
  const rolePerms = db.prepare(`
    SELECT rp.role_id, p.code FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id`).all();
  const map = {};
  for (const rp of rolePerms) {
    (map[rp.role_id] = map[rp.role_id] || []).push(rp.code);
  }
  res.json({
    roles: roles.map((r) => ({ ...r, permissions: map[r.id] || [] })),
    permissions: perms,
  });
});

router.post('/', requirePermission('user.manage'), (req, res) => {
  const body = req.body || {};
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

  const role = db.prepare('SELECT id FROM roles WHERE id = ? AND active = 1').get(roleId);
  if (!role) return res.status(400).json({ error: 'Rol inválido' });
  if (departmentId) {
    const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
    if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
    return res.status(409).json({ error: 'El nombre de usuario ya existe' });
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email)) {
    return res.status(409).json({ error: 'El correo ya está registrado' });
  }

  const info = db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, last_password_change_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, lastName, username, email, hashPassword(password), departmentId, position, roleId, nowIso());

  const row = db.prepare(LIST_SQL.replace(' WHERE 1=1\n  AND', '')).get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(row) });
});

router.get('/assignable', (req, res) => {
  const rows = db
    .prepare(`SELECT id, name, last_name, position, department_name FROM users u
              LEFT JOIN departments d ON d.id = u.department_id
              WHERE u.active = 1 ORDER BY u.name, u.last_name`)
    .all();
  res.json({ data: rows });
});

router.get('/:id', requirePermission('user.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare(LIST_SQL.replace(' WHERE 1=1\n  AND', ' AND')).get(id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: publicUser(row) });
});

router.patch('/:id', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id, username, email, role_id FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

  const body = req.body || {};
  const name = body.name ?? existing.name;
  const lastName = body.last_name ?? '';
  const username = safeStr(body.username ?? existing.username);
  const email = safeStr(body.email ?? existing.email);
  const departmentId = body.department_id === '' || body.department_id == null ? null : parseIntSafe(body.department_id);
  const position = safeStr(body.position ?? '');
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

  const other = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(username, id);
  if (other) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
  const otherMail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, id);
  if (otherMail) return res.status(409).json({ error: 'El correo ya está registrado' });

  const role = db.prepare('SELECT id FROM roles WHERE id = ? AND active = 1').get(roleId);
  if (!role) return res.status(400).json({ error: 'Rol inválido' });

  db.prepare(
    `UPDATE users SET name = ?, last_name = ?, username = ?, email = ?, department_id = ?, position = ?, role_id = ?, updated_at = ? WHERE id = ?`
  ).run(name, lastName, username, email, departmentId, position, roleId, nowIso(), id);

  const row = db.prepare(LIST_SQL.replace(' WHERE 1=1\n  AND', ' AND')).get(id);
  res.json({ user: publicUser(row) });
});

router.patch('/:id/status', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const active = req.body.active === true || req.body.active === 1 || req.body.active === '1';

  if (id === req.user.id && !active) {
    return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
  }

  const existing = db.prepare('SELECT id, active FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (!active && (
    db.prepare('SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = ? AND u.active = 1').get('ADMIN').n <= 1 &&
    db.prepare('SELECT role_id FROM users WHERE id = ?').get(id).role_id === db.prepare('SELECT id FROM roles WHERE code = ?').get('ADMIN').id
  )) {
    return res.status(400).json({ error: 'Debe existir al menos un administrador activo' });
  }

  db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowIso(), id);
  const row = db.prepare(LIST_SQL.replace(' WHERE 1=1\n  AND', ' AND')).get(id);
  res.json({ user: publicUser(row) });
});

router.post('/:id/reset-password', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id, name, username FROM users WHERE id = ? AND active = 1').get(id);
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });

  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare('UPDATE users SET password_reset_token = ?, password_reset_expires = ?, updated_at = ? WHERE id = ?').run(
    hash,
    expires,
    nowIso(),
    id
  );

  res.json({
    ok: true,
    token,
    expires,
    message: 'Token generado. Compártalo de forma segura con el usuario. Caduca en 24 horas.',
  });
});

export default router;