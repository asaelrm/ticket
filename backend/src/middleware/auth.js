import { contract as defaultContract } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// La capa de autenticación ya no usa la API legacy de sentencias preparadas:
// consulta por el contrato async, que es idéntico en SQLite y en SQL Server. El
// SQL va sin prefijo de esquema porque SQLite no tiene esquemas; el usuario de
// SQL Server resuelve esos nombres contra `dbo`, que es su esquema por defecto.
const USER_SQL = `
  SELECT u.id, u.name, u.last_name, u.username, u.email, u.department_id,
         u.position, u.role_id, u.active, u.created_at, u.last_login_at,
         r.code AS role_code, r.name AS role_name,
         d.name AS department_name
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN departments d ON d.id = u.department_id
  WHERE u.id = @userId
`;

const PERMS_SQL = `
  SELECT p.code
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE rp.role_id = @roleId
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

// `contract` es inyectable para poder comprobar en pruebas qué SQL y qué
// parámetros viajan, sin base de datos. Por defecto es el contrato compartido.
export async function loadUser(request, contract = defaultContract) {
  const { userId } = request.session || {};
  if (!userId) return null;
  const row = await contract.queryOne(USER_SQL, { userId });
  if (!row) return null;
  if (!row.active) return { ...publicUser(row), inactive: true, permissions: [] };
  const perms = await contract.queryMany(PERMS_SQL, { roleId: row.role_id });
  return { ...publicUser(row), inactive: false, permissions: perms.map((p) => p.code) };
}

// `loadUser` es async, así que el middleware también. `asyncHandler` es el
// wrapper compartido: sin él, un rechazo de promesa dejaría la petición colgada
// para siempre en lugar de llegar a `errorHandler`.
export const requireAuth = asyncHandler(async (req, res, next) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (user.inactive) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'Su cuenta está desactivada. Contacte a un administrador.' });
  }
  req.user = user;
  next();
});

// `requirePermission` y `requireAnyPermission` siguen siendo síncronos: solo leen
// `req.user`, que `requireAuth` ya dejó establecido.

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

// La fecha viaja como `Date`: el contrato lo normaliza a ISO en el borde del
// driver, que es la política canónica para DATETIME2 y para el TEXT de SQLite.
export async function touchLastLogin(userId, contract = defaultContract) {
  await contract.execute('UPDATE users SET last_login_at = @now WHERE id = @userId', {
    now: new Date(),
    userId,
  });
}