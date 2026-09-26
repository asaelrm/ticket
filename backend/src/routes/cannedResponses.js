import express from 'express';
import db, { nowIso } from '../db.js';
import { safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { MAX_TEMPLATE_TITLE, validateTemplateBody } from '../utils/templateVars.js';

const router = express.Router();
router.use(requireAuth);

const SCOPES = ['GLOBAL', 'PERSONAL', 'TEAM'];
const SORTS = { usage: 'c.use_count DESC, c.title ASC', title: 'c.title ASC', recent: 'c.updated_at DESC' };

const LIST_SELECT = `
  SELECT c.id, c.title, c.body, c.scope, c.owner_id, c.team_id, c.is_active,
         c.use_count, c.created_at, c.updated_at,
         u.name || ' ' || u.last_name AS owner_name,
         t.name AS team_name
  FROM canned_responses c
  LEFT JOIN users u ON u.id = c.owner_id
  LEFT JOIN teams t ON t.id = c.team_id
`;

/**
 * Visibilidad de una plantilla para un usuario concreto.
 *
 * GLOBAL      → cualquier usuario autenticado que pueda comentar o tomar notas.
 * PERSONAL    → solo su propietario.
 * TEAM        → solo los miembros ACTUALES del equipo (team_members no guarda
 *               historial, por lo que la membresía es exclusivamente de estado
 *               actual: al salir del equipo se pierde el acceso de inmediato).
 *
 * El filtro se aplica siempre antes de contar y paginar, de modo que un
 *:template de otro equipo nunca aparece en la respuesta ni en el total.
 */
const VISIBLE_SQL = `
  c.is_active = 1 AND (
    c.scope = 'GLOBAL'
    OR (c.scope = 'PERSONAL' AND c.owner_id = ?)
    OR (c.scope = 'TEAM' AND c.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
  )
`;

function hasPerm(user, code) {
  return user.permissions.includes(code);
}

/** Sin permisos nuevos: reutiliza ticket.comment / ticket.note. */
function canUseTemplates(user) {
  return hasPerm(user, 'ticket.comment') || hasPerm(user, 'ticket.note');
}

/** Permiso de administración por ámbito. */
function canManageScope(user, scope) {
  if (scope === 'GLOBAL') return hasPerm(user, 'settings.manage');
  if (scope === 'TEAM') return hasPerm(user, 'team.manage');
  return true; // PERSONAL: el dueño (verificarCanEdit)
}

/** ¿Puede este usuario modificar esta plantilla concreta? */
function canEdit(user, row) {
  if (!row) return false;
  if (row.scope === 'PERSONAL') return row.owner_id === user.id;
  return canManageScope(user, row.scope);
}

function likePattern(term) {
  return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Devuelve la plantilla si el usuario tiene permiso para verla y usarla.
 * Se exporta para que routes/tickets.js valide el contador de uso al comentar
 * sin duplicar la regla de visibilidad.
 */
export function visibleTemplateFor(user, id) {
  const templateId = parseIntSafe(id);
  if (!templateId || !canUseTemplates(user)) return null;
  return db.prepare(`${LIST_SELECT} WHERE c.id = ? AND ${VISIBLE_SQL}`).get(templateId, user.id, user.id);
}

/** Plantilla propia (incluye inactivas) para la gestión del perfil. */
router.get('/mine', (req, res) => {
  if (!canUseTemplates(req.user)) {
    return res.status(403).json({ error: 'No tiene permiso para usar respuestas rápidas' });
  }
  const rows = db
    .prepare(`${LIST_SELECT} WHERE c.scope = 'PERSONAL' AND c.owner_id = ? ORDER BY c.title ASC`)
    .all(req.user.id);
  res.json({ data: rows });
});

/** Listado administrativo: globales y de equipo, con su estado real. */
router.get('/manage', requireAnyPermission(['settings.manage', 'team.manage']), (req, res) => {
  const clauses = [];
  const params = [];

  const scope = req.query.scope ? String(req.query.scope).toUpperCase() : '';
  if (scope) {
    if (!SCOPES.includes(scope) || scope === 'PERSONAL') {
      return res.status(400).json({ error: 'Ámbito no válido' });
    }
    clauses.push('c.scope = ?');
    params.push(scope);
  }

  const teamId = parseIntSafe(req.query.team_id);
  if (teamId) {
    clauses.push('c.team_id = ?');
    params.push(teamId);
  }

  const q = safeStr(req.query.q);
  if (q) {
    clauses.push("(LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(c.body) LIKE ? ESCAPE '\\')");
    const pattern = likePattern(q);
    params.push(pattern, pattern);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = SORTS[req.query.sort] || SORTS.usage;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM canned_responses c ${where}`).get(...params).n;
  const rows = db
    .prepare(`${LIST_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, 200, 0);

  res.json({ data: rows, total, page: 1, limit: 200 });
});

/** Listado para el selector del ticket: solo visibles y activas. */
router.get('/', (req, res) => {
  if (!canUseTemplates(req.user)) {
    return res.status(403).json({ error: 'No tiene permiso para usar respuestas rápidas' });
  }

  const clauses = [VISIBLE_SQL];
  const params = [req.user.id, req.user.id];

  const scope = req.query.scope ? String(req.query.scope).toUpperCase() : '';
  if (scope) {
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Ámbito no válido' });
    clauses.push('c.scope = ?');
    params.push(scope);
  }

  const teamId = parseIntSafe(req.query.team_id);
  if (teamId) {
    clauses.push('c.team_id = ?');
    params.push(teamId);
  }

  const q = safeStr(req.query.q);
  if (q) {
    clauses.push("(LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(c.body) LIKE ? ESCAPE '\\')");
    const pattern = likePattern(q);
    params.push(pattern, pattern);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;
  const order = SORTS[req.query.sort] || SORTS.usage;
  const limit = Math.min(Math.max(parseIntSafe(req.query.limit) || 25, 1), 100);
  const page = Math.max(parseIntSafe(req.query.page) || 1, 1);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM canned_responses c ${where}`).get(...params).n;
  const rows = db
    .prepare(`${LIST_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);

  res.json({ data: rows, total, page, limit });
});

router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const row = db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(id);
  // 404 (no 403) para no confirmar la existencia de plantillas ajenas.
  if (!row || (!row.is_active && !canEdit(req.user, row)) || (row.is_active && !canUseTemplates(req.user))) {
    return res.status(404).json({ error: 'Plantilla no encontrada' });
  }
  if (row.is_active && !visibleTemplateFor(req.user, id)) {
    return res.status(404).json({ error: 'Plantilla no encontrada' });
  }
  res.json({ template: row });
});

router.post('/', requireAnyPermission(['ticket.comment', 'ticket.note']), (req, res) => {
  const body = req.body || {};
  const title = safeStr(body.title);
  const scope = String(body.scope || 'PERSONAL').toUpperCase();
  const templateBody = typeof body.body === 'string' ? body.body.trim() : '';
  const teamId = parseIntSafe(body.team_id);
  const isActive = body.is_active === undefined ? 1 : body.is_active ? 1 : 0;

  if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Ámbito no válido' });
  if (!title) return res.status(400).json({ error: 'El título es obligatorio' });
  if (title.length > MAX_TEMPLATE_TITLE) {
    return res.status(400).json({ error: `El título no debe exceder ${MAX_TEMPLATE_TITLE} caracteres` });
  }
  if (!canManageScope(req.user, scope)) {
    return res.status(403).json({ error: 'No tiene permiso para crear plantillas de este ámbito' });
  }

  const check = validateTemplateBody(templateBody);
  if (!check.ok) return res.status(400).json({ error: check.fields.body });

  // owner_id siempre proviene de la sesión: nunca del cuerpo de la petición.
  let ownerId = null;
  let resolvedTeamId = null;
  if (scope === 'PERSONAL') {
    ownerId = req.user.id;
  } else if (scope === 'TEAM') {
    if (!teamId) return res.status(400).json({ error: 'Debe indicar el equipo de la plantilla' });
    const team = db.prepare('SELECT id FROM teams WHERE id = ? AND active = 1').get(teamId);
    if (!team) return res.status(400).json({ error: 'El equipo no existe o está desactivado' });
    resolvedTeamId = teamId;
  } else if (body.team_id) {
    return res.status(400).json({ error: 'Las plantillas globales no pertenecen a un equipo' });
  }

  if (isActive && duplicateExists({ title, scope, ownerId, teamId: resolvedTeamId })) {
    return res.status(409).json({ error: 'Ya existe una plantilla activa con ese título en este ámbito' });
  }

  const info = db
    .prepare('INSERT INTO canned_responses (title, body, scope, owner_id, team_id, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, templateBody, scope, ownerId, resolvedTeamId, isActive);
  res.status(201).json({ template: db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(info.lastInsertRowid) });
});

router.patch('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM canned_responses WHERE id = ?').get(id);
  if (!existing || !canEdit(req.user, existing)) {
    return res.status(404).json({ error: 'Plantilla no encontrada' });
  }

  const body = req.body || {};
  const title = body.title === undefined ? existing.title : safeStr(body.title);
  const templateBody = body.body === undefined ? existing.body : String(body.body).trim();
  const isActive = body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0;
  const scope = body.scope === undefined ? existing.scope : String(body.scope).toUpperCase();
  const requestedTeamId = body.team_id === undefined ? existing.team_id : parseIntSafe(body.team_id);

  if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Ámbito no válido' });
  if (!title) return res.status(400).json({ error: 'El título es obligatorio' });
  if (title.length > MAX_TEMPLATE_TITLE) {
    return res.status(400).json({ error: `El título no debe exceder ${MAX_TEMPLATE_TITLE} caracteres` });
  }

  // Cambiar de ámbito exige.permission sobre el ámbito actual y el nuevo: nadie
  // puede promover su plantilla personal a global sin settings.manage.
  if ((scope !== existing.scope || requestedTeamId !== existing.team_id) && !canManageScope(req.user, scope)) {
    return res.status(403).json({ error: 'No tiene permiso para mover la plantilla a ese ámbito' });
  }

  const check = validateTemplateBody(templateBody);
  if (!check.ok) return res.status(400).json({ error: check.fields.body });

  let ownerId = existing.owner_id;
  let teamId = existing.team_id;
  if (scope === 'PERSONAL') {
    ownerId = req.user.id;
    teamId = null;
  } else if (scope === 'TEAM') {
    if (!requestedTeamId) return res.status(400).json({ error: 'Debe indicar el equipo de la plantilla' });
    const team = db.prepare('SELECT id FROM teams WHERE id = ? AND active = 1').get(requestedTeamId);
    if (!team) return res.status(400).json({ error: 'El equipo no existe o está desactivado' });
    ownerId = null;
    teamId = requestedTeamId;
  } else {
    ownerId = null;
    teamId = null;
  }

  if (
    isActive &&
    duplicateExists({ title, scope, ownerId, teamId, excludeId: id })
  ) {
    return res.status(409).json({ error: 'Ya existe una plantilla activa con ese título en este ámbito' });
  }

  db.prepare(
    'UPDATE canned_responses SET title = ?, body = ?, scope = ?, owner_id = ?, team_id = ?, is_active = ?, updated_at = ? WHERE id = ?'
  ).run(title, templateBody, scope, ownerId, teamId, isActive, nowIso(), id);

  res.json({ template: db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(id) });
});

// Sin endpoint de borrado: la baja es lógica (is_active = 0) para no destruir
// el histórico de use_count. Tampoco existe ninguna operación que incremente el
// contador de forma arbitraria: solo lo hace processComment() al guardar el
// comentario.

export default router;

/** Unicidad de título por ámbito, solo entre plantillas activas. */
function duplicateExists({ title, scope, ownerId, teamId, excludeId = null }) {
  const clause =
    scope === 'PERSONAL'
      ? "c.scope = 'PERSONAL' AND c.owner_id = ?"
      : scope === 'TEAM'
        ? "c.scope = 'TEAM' AND c.team_id = ?"
        : "c.scope = 'GLOBAL'";
  const key = scope === 'PERSONAL' ? ownerId : scope === 'TEAM' ? teamId : null;
  const row = db
    .prepare(
      `SELECT c.id FROM canned_responses c
       WHERE ${clause} AND c.is_active = 1 AND LOWER(c.title) = LOWER(?) AND c.id != ?`
    )
    .get(...(key === null ? [title, excludeId ?? 0] : [key, title, excludeId ?? 0]));
  return Boolean(row);
}
