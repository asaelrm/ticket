import db from '../db.js';
import { nowIso } from '../db.js';

const USER_SQL = `
  SELECT u.id, u.name, u.last_name, u.username, u.email, u.department_id,
         u.position, u.role_id, u.active, u.created_at, u.last_login_at,
         r.code AS role_code, r.name AS role_name,
         d.name AS department_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE u.id = ?
`;

const PERMS_SQL = `
  SELECT p.code
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = ?
`;

export function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    last_name: row.last_name,
    username: row.username,
    email: row.email,
    department_id: row.department_id,
    department_name: row.department_name || '',
    position: row.position,
    role_id: row.role_id,
    role: row.role_code,
    role_name: row.role_name,
    active: !!row.active,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function loadUser(request) {
  const { userId } = request.session || {};
  if (!userId) return null;
  const row = db.prepare(USER_SQL).get(userId);
  if (!row) return null;
  if (!row.active) return { ...publicUser(row), inactive: true, permissions: [] };
  const perms = db.prepare(PERMS_SQL).all(row.role_id).map((p) => p.code);
  return { ...publicUser(row), inactive: false, permissions: perms };
}

export function requireAuth(req, res, next) {
  const user = loadUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (user.inactive) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'Su cuenta está desactivada. Contacte a un administrador.' });
  }
  req.user = user;
  next();
}

export function requirePermission(permission) {
  return function requirePermissionMw(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({ error: 'No tiene permiso para realizar esta acción' });
    }
    next();
  };
}

// Requiere al menos uno de los permisos indicados. Se usa cuando un mismo
// recurso legitimately lo consumen varias pantallas con permisos distintos
// (p. ej. selector de técnicos: asignar tickets, filtrar la vista general o
// administrar equipos). Reutiliza los códigos ya sembrados y devuelve la
// misma respuesta 403 que requirePermission para no abrir otro canal de error.
export function requireAnyPermission(permissions) {
  const codes = Array.isArray(permissions) ? permissions : [permissions];
  return function requireAnyPermissionMw(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!codes.some((code) => req.user.permissions.includes(code))) {
      return res.status(403).json({ error: 'No tiene permiso para realizar esta acción' });
    }
    next();
  };
}

export function touchLastLogin(userId) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), userId);
}