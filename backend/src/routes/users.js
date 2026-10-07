import crypto from 'node:crypto';
import express from 'express';
import db, { nowIso } from '../db.js';
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

// El contexto de organización lo decide exclusivamente el servidor a partir de
// la sesión (rejectClientOrg viene de middleware/org.js). Un organization_id
// enviado por el cliente es un intento de escalada o un error del frontend,
// nunca una instrucción válida.

function userWhere() {
  const conditions = [];
  const params = [];
  return { conditions, params };
}

function buildListQuery(req) {
  const { conditions, params } = userWhere();
  // ETAPA 2 (aislamiento por organización): el listado se restringe SIEMPRE a
  // la organización del contexto de sesión. Un SUPERADMIN sin contexto obtiene
  // una lista vacía: las rutas normales no exponen de golpe los datos de todas
  // las organizaciones; eso llega con operaciones multiempresa explícitas en
  // etapas posteriores.
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

  const role = db.prepare('SELECT id, code FROM roles WHERE id = ? AND active = 1').get(roleId);
  if (!role) return res.status(400).json({ error: 'Rol inválido' });

  // Un usuario creado nace SIEMPRE en la organización del usuario autenticado
  // (sesión), nunca en una indicada por el cliente. Solo un SUPERADMIN puede
  // crear otro SUPERADMIN, y esos nacen globales (organization_id null).
  let organizationId = req.user.organization_id;
  if (isSuperadminRoleCode(role.code)) {
    if (!req.user.is_superadmin) {
      return res.status(403).json({ error: 'Solo un superadministrador puede asignar el rol SUPERADMIN' });
    }
    organizationId = null;
  }

  // Regla de consistencia: usuario normal exige organización válida y activa;
  // SUPERADMIN exige organization_id NULL. El contexto sale de la sesión.
  const stateError = orgStateError({ roleCode: role.code, organizationId });
  if (stateError) return res.status(400).json({ error: stateError });

  // ETAPA 2: el departamento debe pertenecer a la organización del usuario.
  // Como organizationId sale de la sesión (null solo para SUPERADMIN), exigir
  // coincidencia también impide que un SUPERADMIN se asocie a un departamento:
  // un departamento siempre pertenece a una organización.
  if (departmentId) {
    const dept = db.prepare('SELECT id, organization_id FROM departments WHERE id = ?').get(departmentId);
    if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
    if (dept.organization_id !== organizationId) {
      return res.status(400).json({ error: 'El departamento debe pertenecer a la organización del usuario' });
    }
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username)) {
    return res.status(409).json({ error: 'El nombre de usuario ya existe' });
  }
  if (db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email)) {
    return res.status(409).json({ error: 'El correo ya está registrado' });
  }

  const info = db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, organization_id, last_password_change_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, lastName, username, email, hashPassword(password), departmentId, position, roleId, organizationId, nowIso());

  saveDirectorySnapshot();
  const row = db.prepare(`${LIST_SQL} AND u.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(row) });
});

// Directorio de técnicos que se puede asignar. Lo consumen tres pantallas con
// permisos distintos del RBAC existente: la asignación de tickets
// (ticket.assign), el filtro por técnico de la búsqueda avanzada
// (ticket.view.all) y la gestión de miembros de equipo (team.manage). El
// empleado solo tiene create/view.own/comment y no necesita esta información.
router.get(
  '/assignable',
  requireAnyPermission(['ticket.assign', 'ticket.view.all', 'team.manage']),
  (req, res) => {
    // ETAPA 2: solo los usuarios ACTIVOS de la organización del solicitante son
    // asignables. Un SUPERADMIN sin contexto no obtiene el directorio completo.
    const rows = db
      .prepare(`SELECT u.id, u.name, u.last_name, u.position, d.name AS department_name FROM users u
              LEFT JOIN departments d ON d.id = u.department_id
              WHERE u.active = 1 AND u.organization_id = ? ORDER BY u.name, u.last_name`)
      .all(currentOrgId(req.user));
    res.json({ data: rows });
  }
);

router.get('/:id/tickets', (req, res) => {
  const id = parseIntSafe(req.params.id);
  // ETAPA 3: el objetivo debe pertenecer a la organización del solicitante
  // (404 para otra organización). Un SUPERADMIN sin contexto también es 404:
  // las rutas normales exigen una organización real.
  const target = db
    .prepare('SELECT id, name, last_name FROM users WHERE id = ? AND organization_id = ?')
    .get(id, currentOrgId(req.user));
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

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${col} = ?`).get(id).n;

  const byStatusRows = db
    .prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t WHERE ${col} = ? GROUP BY t.status`)
    .all(id);
  const byStatus = {};
  for (const r of byStatusRows) byStatus[r.status] = r.n;

  const data = db
    .prepare(
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
       LIMIT ? OFFSET ?`
    )
    .all(id, perPage, (page - 1) * perPage);

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
});

router.get('/:id', requirePermission('user.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  // ETAPA 3: un usuario de otra organización responde 404 (no se revela su
  // existencia). Un SUPERADMIN sin contexto también: las rutas normales exigen
  // una organización real (la gestión global explícita se diseña más adelante).
  const row = db.prepare(`${LIST_SQL} AND u.id = ? AND u.organization_id = ?`)
    .get(id, currentOrgId(req.user));
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: publicUser(row) });
});

router.patch('/:id', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const rejected = rejectClientOrg(req.body || {});
  if (rejected) return res.status(400).json({ error: rejected });
  // La búsqueda NO va scoped por organización porque antes hace falta detectar
  // si el objetivo es un SUPERADMIN global (que merece 403, no 404; ver
  // test/organizations.test.js). La restricción de organización se aplica
  // justo después y devuelve 404 para recursos ajenos.
  const existing = db
    .prepare('SELECT id, name, last_name, department_id, position, username, email, role_id, organization_id FROM users WHERE id = ?')
    .get(id);
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

  const existingRole = db.prepare('SELECT code FROM roles WHERE id = ?').get(existing.role_id);
  if (isSuperadminRoleCode(existingRole?.code) && !req.user.is_superadmin) {
    return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
  }

  // ETAPA 3: la ruta es TENANT. El objetivo debe pertenecer a la organización
  // de la sesión (404 para recursos ajenos, sin revelar su existencia). Un
  // SUPERADMIN sin contexto de organización (organization_id NULL) no puede
  // modificar usuarios de ninguna organización por aquí: NULL nunca significa
  // "todas las organizaciones".
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

  const other = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(username, id);
  if (other) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
  const otherMail = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(email, id);
  if (otherMail) return res.status(409).json({ error: 'El correo ya está registrado' });

  const role = db.prepare('SELECT id, code FROM roles WHERE id = ? AND active = 1').get(roleId);
  if (!role) return res.status(400).json({ error: 'Rol inválido' });

  // Cambio de rol con consistencia de organización:
  //   - Ascenso a SUPERADMIN: solo otro SUPERADMIN, y el promovido queda global
  //     (organization_id NULL). No se confía en un role_id "amigable" del
  //     cliente: el rol real se vuelve a leer de la base.
  //   - Descenso de SUPERADMIN a rol normal: requiere una organización segura
  //     que aún no se puede proveer desde el servidor, así que hoy se rechaza.
  //   - Rol normal → rol normal: se conserva la organización que ya tiene.
  let nextOrg = existing.organization_id;
  if (isSuperadminRoleCode(role.code)) {
    if (isSuperadminRoleCode(existingRole?.code)) {
      // Sin cambio de rol: se mantiene global.
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
    const stateError = orgStateError({ roleCode: role.code, organizationId: existing.organization_id });
    if (stateError) return res.status(400).json({ error: stateError });
  }

  // ETAPA 2: consistencia usuario → departamento → organización. El rol global
  // no pertenece a ningún departamento: si el cliente lo intenta fijar
  // explícitamente se rechaza (400); si no se menciona (p. ej. en un ascenso
  // desde un rol que sí tenía departamento) se limpia al quedar global.
  let departmentIdFinal = departmentId;
  if (isSuperadminRoleCode(role.code)) {
    if (has('department_id') && departmentId) {
      return res.status(400).json({ error: 'El rol SUPERADMIN no pertenece a ningún departamento' });
    }
    departmentIdFinal = null;
  } else if (departmentIdFinal) {
    const dept = db.prepare('SELECT id, organization_id FROM departments WHERE id = ?').get(departmentIdFinal);
    if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
    if (dept.organization_id !== nextOrg) {
      return res.status(400).json({ error: 'El departamento debe pertenecer a la organización del usuario' });
    }
  }

  db.prepare(
    `UPDATE users SET name = ?, last_name = ?, username = ?, email = ?, department_id = ?, position = ?, role_id = ?,
     organization_id = ?, updated_at = ? WHERE id = ?`
  ).run(name, lastName, username, email, departmentIdFinal, position, roleId, nextOrg, nowIso(), id);

  saveDirectorySnapshot();
  const row = db.prepare(`${LIST_SQL} AND u.id = ?`).get(id);
  res.json({ user: publicUser(row) });
});

router.patch('/:id/status', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const active = req.body.active === true || req.body.active === 1 || req.body.active === '1';

  if (id === req.user.id && !active) {
    return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
  }

  const existing = db.prepare('SELECT id, active, organization_id FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

  // El SUPERADMIN merece 403 (no 404) para un admin de organización: es un
  // canal protegido heredado de ETAPA 1B (ver test/organizations.test.js).
  const targetRole = db
    .prepare('SELECT r.code FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?')
    .get(id);
  if (isSuperadminRoleCode(targetRole?.code) && !req.user.is_superadmin) {
    return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
  }

  // ETAPA 3: ruta TENANT: el objetivo debe pertenecer a la organización de la
  // sesión (404 en caso contrario). Un SUPERADMIN sin contexto no activa ni
  // desactiva usuarios de ninguna organización por esta ruta.
  const org = currentOrgId(req.user);
  if (existing.organization_id !== org) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  // ETAPA 2: la guardia "al menos un administrador activo" es POR organización
  // (no global): cada organización debe conservar su propia administración.
  if (!active && existing.active) {
    const esAdmin = db.prepare(
      'SELECT id FROM users WHERE id = ? AND role_id = (SELECT id FROM roles WHERE code = ?)'
    ).get(id, 'ADMIN');
    const adminsEnOrg = db.prepare(`
      SELECT COUNT(*) AS n FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.code = 'ADMIN' AND u.active = 1 AND u.organization_id = ?
    `).get(existing.organization_id).n;
    if (esAdmin && adminsEnOrg <= 1) {
      return res.status(400).json({ error: 'Debe existir al menos un administrador activo en la organización' });
    }
  }

  db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, nowIso(), id);
  saveDirectorySnapshot();
  const row = db.prepare(`${LIST_SQL} AND u.id = ?`).get(id);
  res.json({ user: publicUser(row) });
});

router.post('/:id/reset-password', requirePermission('user.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const targetRole = db
    .prepare('SELECT r.code, u.organization_id FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?')
    .get(id);
  if (targetRole && isSuperadminRoleCode(targetRole.code) && !req.user.is_superadmin) {
    return res.status(403).json({ error: 'Solo un superadministrador puede administrar cuentas SUPERADMIN' });
  }

  // ETAPA 3: ruta TENANT. Un SUPERADMIN sin contexto de organización (NULL) no
  // puede resetear contraseñas de usuarios de ninguna organización: debe ser
  // la organización de la sesión, o 404.
  const org = currentOrgId(req.user);
  if (!targetRole || targetRole.organization_id !== org) {
    return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
  }

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

  // Un restablecimiento de contraseña deja sin efecto las sesiones vivas del
  // usuario. Sin esto, quien hubiera robado la cookie conserva el acceso
  // durante toda la vigencia de la sesión, incluso después de que el
  // propietario haya cambiado su contraseña.
  destroyUserSessions(id);

  res.json({
    ok: true,
    token,
    expires,
    message: 'Token generado. Compártalo de forma segura con el usuario. Caduca en 24 horas.',
  });
});

export default router;
