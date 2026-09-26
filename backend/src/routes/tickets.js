import express from 'express';
import db, { nowIso } from '../db.js';
import config from '../config.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { visibleTemplateFor } from './cannedResponses.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { uploadMiddleware, uploadSizeError } from '../middleware/upload.js';
import { validateFile, persistUpload } from '../utils/fileType.js';
import { nextTicketNumber } from '../utils/ticketNumber.js';
import { computeSlaDue, OPEN_STATUSES } from '../utils/sla.js';
import { getWorkflowOptions, requireResolutionToClose, isCsatEnabled } from '../utils/options.js';
import { emitTicketEvent, onTicketEvent } from '../utils/ticketBus.js';
import { notifyAssigned, notifyComment, notifyResolved, notifyCancelled } from '../utils/mailer.js';
import {
  createNotification,
  createNotifications,
  notifyTicketParticipants,
  notifyAdmins,
  notifyStaff,
} from '../utils/notifications.js';

const router = express.Router();
router.use(requireAuth);

// Express 4 no reenvía rechazos de promesas al error handler (Node 24 los
// convertiría en unhandledRejection). Este wrapper los propaga a `next`.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const STATUS_LABEL = {
  OPEN: 'Abierto', ASSIGNED: 'Asignado', IN_PROGRESS: 'En proceso', PENDING: 'Pendiente',
  RESOLVED: 'Resuelto', CLOSED: 'Cerrado', CANCELLED: 'Cancelado',
};
export const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

// ---------------------------------------------------------------------------
// Helpers de acceso e historial
// ---------------------------------------------------------------------------

const TICKET_SQL = `
  SELECT t.*,
    r.name || ' ' || r.last_name AS reporter_name,
    r.email AS reporter_email,
    COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name,
    COALESCE(ru.name || ' ' || ru.last_name, '') AS resolved_by_name,
    COALESCE(cu.name || ' ' || cu.last_name, '') AS closed_by_name,
    COALESCE(ou.name || ' ' || ou.last_name, '') AS reopened_by_name,
    COALESCE(te.name, '') AS team_name,
    c.name AS category_name, c.color AS category_color,
    d.name AS department_name,
    CASE WHEN t.sla_due_at IS NOT NULL
              AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')
              AND t.sla_due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         THEN 1 ELSE 0 END AS is_overdue,
    (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS attachment_count
  FROM tickets t
  JOIN users r ON r.id = t.reporter_id
  LEFT JOIN users au ON au.id = t.assigned_to_id
  LEFT JOIN users ru ON ru.id = t.resolved_by
  LEFT JOIN users cu ON cu.id = t.closed_by
  LEFT JOIN users ou ON ou.id = t.reopened_by
  LEFT JOIN teams te ON te.id = t.assigned_team_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN departments d ON d.id = t.department_id
  WHERE t.id = ?
`;

export function getTicket(id) {
  return db.prepare(TICKET_SQL).get(id);
}

export function canViewTicket(user, ticket) {
  if (!ticket) return false;
  if (user.permissions.includes('ticket.view.all')) return true;
  return ticket.reporter_id === user.id;
}

export function hasPerm(user, code) {
  return user.permissions.includes(code);
}

function recordHistory(ticketId, userId, action, description, oldValue = null, newValue = null) {
  db.prepare(
    'INSERT INTO ticket_history (ticket_id, user_id, action, description, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ticketId, userId, action, description, oldValue, newValue);
}

function touchTicket(id) {
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

function historyDesc(kind, ticket, newValue) {
  switch (kind) {
    case 'status': {
      const oldL = STATUS_LABEL[ticket.status] || ticket.status;
      const newL = STATUS_LABEL[newValue] || newValue;
      if (['RESOLVED', 'CLOSED'].includes(ticket.status) && newValue === 'OPEN') {
        return `Ticket reabierto (${oldL} → ${newL})`;
      }
      return newValue === 'RESOLVED' ? `Estado cambiado a ${newL}` : `Estado cambiado: ${oldL} → ${newL}`;
    }
    case 'priority': {
      return `Prioridad cambiada: ${PRIORITY_LABEL[ticket.priority] || ticket.priority} → ${PRIORITY_LABEL[newValue] || newValue}`;
    }
    case 'category': {
      const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(newValue);
      return `Categoría cambiada: ${ticket.category_name || ''} → ${row ? row.name : ''}`;
    }
    case 'assigned': {
      if (newValue === null || newValue === '') return 'Asignación removida';
      const row = db.prepare("SELECT name || ' ' || last_name AS full FROM users WHERE id = ?").get(newValue);
      return `Asignado a ${row ? row.full : ''}`;
    }
    case 'assigned_team': {
      if (newValue === null || newValue === '') return 'Equipo de asignación removido';
      const row = db.prepare('SELECT name FROM teams WHERE id = ?').get(newValue);
      return `Asignado al equipo ${row ? row.name : ''}`;
    }
    case 'title':
      return `Título actualizado: "${ticket.title}" → "${newValue}"`;
    case 'description':
      return 'Descripción actualizada';
    default:
      return 'Ticket actualizado';
  }
}

function myTeamIds(userId) {
  return db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').all(userId).map((r) => r.team_id);
}

function nameForTeam(teamId) {
  const row = db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId);
  return row ? row.name : '';
}

// ---------------------------------------------------------------------------
// Almacenamiento de archivos (validación previa de todos antes de escribir)
// ---------------------------------------------------------------------------

function validateFiles(files) {
  const errors = [];
  const validated = [];
  for (const f of files || []) {
    const info = validateFile(f.buffer, f.originalname);
    if (!info.ok) {
      errors.push(`${f.originalname}: ${info.reason}`);
    } else {
      validated.push({ buffer: f.buffer, info: { ...info, originalName: f.originalname } });
    }
  }
  if (errors.length) return { ok: false, reason: errors.join('. ') };
  return { ok: true, validated };
}

// Un adjunto colgado de una nota interna no puede registrarse como
// ATTACHMENT_ADDED: su descripción incluye el nombre del archivo y el historial
// es visible para el reportante. Se registra con una acción propia para que el
// filtro de la nota interna pueda ocultarla sin mostrar ni siquiera su existencia.
function persistAndInsertAttachments(validated, ticketId, commentId, userId, isInternalNote = false) {
  const inserted = [];
  for (const { buffer, info } of validated) {
    const saved = persistUpload(buffer, info);
    const infoRow = db.prepare(
      'INSERT INTO ticket_attachments (ticket_id, comment_id, original_name, stored_name, mime_type, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(ticketId, commentId, saved.originalName, saved.storedName, saved.mime, saved.size, userId);
    inserted.push({
      id: infoRow.lastInsertRowid,
      original_name: saved.originalName,
      stored_name: saved.storedName,
      mime_type: saved.mime,
      size_bytes: saved.size,
      comment_id: commentId,
      created_at: nowIso(),
    });
    recordHistory(
      ticketId,
      userId,
      isInternalNote ? 'NOTE_ATTACHMENT_ADDED' : 'ATTACHMENT_ADDED',
      `Se adjuntó ${saved.originalName}`
    );
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Filtros combinados
// ---------------------------------------------------------------------------

function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (m) => `\\${m}`);
}

function startOfPeriod(period) {
  const d = new Date();
  if (period === 'today') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (period === 'week') {
    const diff = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  }
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (period === 'year') return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return null;
}

// Rango [inicio, fin) para fecha de cierre/resolución real.
function closedRange(period) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  let start;
  let end;
  switch (period) {
    case 'yesterday': {
      start = new Date(Date.UTC(y, m, day - 1));
      end = new Date(Date.UTC(y, m, day));
      break;
    }
    case 'week': {
      const diff = (d.getUTCDay() + 6) % 7;
      start = new Date(Date.UTC(y, m, day - diff));
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    }
    case 'month': {
      start = new Date(Date.UTC(y, m, 1));
      end = new Date(Date.UTC(y, m + 1, 1));
      break;
    }
    case 'quarter': {
      const q = Math.floor(m / 3);
      start = new Date(Date.UTC(y, q * 3, 1));
      end = new Date(Date.UTC(y, q * 3 + 3, 1));
      break;
    }
    case 'year': {
      start = new Date(Date.UTC(y, 0, 1));
      end = new Date(Date.UTC(y + 1, 0, 1));
      break;
    }
    default: {
      start = new Date(Date.UTC(y, m, day));
      end = new Date(Date.UTC(y, m, day + 1));
    }
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_LIST_RE = /^\d+(,\d+)*$/;
const ENUM_LIST = { status: STATUSES, priority: PRIORITIES };
const SEARCH_LIKE = `ESCAPE '\\'`;
const LIKE_FIELDS = 13;

function buildConditions(req, viewOnlyOwn) {
  const conds = [];
  const params = [];
  const q = req.query;
  const user = req.user;

  if (viewOnlyOwn) {
    conds.push('t.reporter_id = ?');
    params.push(req.user.id);
  }

  // Vistas rápidas (declarativas, combinan con el resto de filtros).
  const view = String(q.view || '');
  if (view === 'open') {
    conds.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
    params.push(...OPEN_STATUSES);
  } else if (view === 'pending') {
    conds.push(`t.status IN ('OPEN', 'PENDING')`);
  } else if (view === 'attended') {
    conds.push(`t.status IN ('ASSIGNED', 'IN_PROGRESS')`);
  } else if (view === 'overdue') {
    conds.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND t.sla_due_at IS NOT NULL AND t.sla_due_at < ?`);
    params.push(...OPEN_STATUSES, nowIso());
  } else if (view === 'mine') {
    conds.push('t.assigned_to_id = ?');
    params.push(req.user.id);
  } else if (view === 'my-teams') {
    const teams = myTeamIds(req.user.id);
    if (teams.length) {
      conds.push(`t.assigned_team_id IN (${teams.map(() => '?').join(',')})`);
      params.push(...teams);
    } else {
      conds.push('1 = 0');
    }
  } else if (view === 'closed') {
    const closedCol = 'COALESCE(t.resolved_at, t.closed_at)';
    conds.push(`${closedCol} IS NOT NULL`);
    const period = String(q.closed_period || '');
    if (['today', 'yesterday', 'week', 'month', 'quarter', 'year'].includes(period)) {
      const range = closedRange(period);
      conds.push(`${closedCol} >= ? AND ${closedCol} < ?`);
      params.push(range.start, range.end);
    }
  }

  // Bandeja de soporte: solo pendientes de atención (excluye resueltos,
  // cerrados y cancelados). Se combina con cualquier vista/filtro.
  if (isTruthyFlag(q.active)) {
    conds.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
    params.push(...OPEN_STATUSES);
  }

  if (q.search) {
    const like = `%${escapeLike(q.search)}%`;
    const parts = [
      `t.title LIKE ?`,
      `t.description LIKE ?`,
      `t.ticket_number LIKE ?`,
      `r.name LIKE ?`,
      `r.last_name LIKE ?`,
      `(r.name || ' ' || r.last_name) LIKE ?`,
      `r.email LIKE ?`,
      `r.username LIKE ?`,
      `au.name LIKE ?`,
      `au.last_name LIKE ?`,
      `(au.name || ' ' || au.last_name) LIKE ?`,
      `d.name LIKE ?`,
      `te.name LIKE ?`,
    ];
    conds.push(`(${parts.join(` OR `)} ${SEARCH_LIKE})`);
    params.push(...Array(LIKE_FIELDS).fill(like));
  }

  for (const [key, allowed] of Object.entries(ENUM_LIST)) {
    const raw = q[key];
    if (raw === undefined || raw === '') continue;
    const values = String(raw).split(',').filter((v) => allowed.includes(v));
    if (values.length) {
      conds.push(`t.${key} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
  }

  for (const [key, col] of [['category', 't.category_id'], ['department', 't.department_id'], ['user', 't.reporter_id']]) {
    const raw = q[key];
    if (raw === undefined || raw === '') continue;
    const values = String(raw).split(',');
    if (values.every((v) => ID_LIST_RE.test(v))) {
      conds.push(`${col} IN (${values.map(() => '?').join(',')})`);
      params.push(...values.map((v) => parseInt(v, 10)));
    }
  }

  if (q.team && ID_LIST_RE.test(String(q.team))) {
    const teamIds = String(q.team).split(',').map((v) => parseInt(v, 10));
    conds.push(`t.assigned_team_id IN (${teamIds.map(() => '?').join(',')})`);
    params.push(...teamIds);
  }

  if (q.assigned === 'none') {
    conds.push('t.assigned_to_id IS NULL');
  } else if (q.assigned && ID_LIST_RE.test(String(q.assigned))) {
    const ids = String(q.assigned).split(',').map((v) => parseInt(v, 10));
    conds.push(`t.assigned_to_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (q.date && DATE_RE.test(String(q.date))) {
    conds.push('date(t.created_at) = ?');
    params.push(String(q.date));
  }
  if (q.from && DATE_RE.test(String(q.from))) {
    conds.push('t.created_at >= ?');
    params.push(`${String(q.from)}T00:00:00.000Z`);
  }
  if (q.to && DATE_RE.test(String(q.to))) {
    conds.push('t.created_at <= ?');
    params.push(`${String(q.to)}T23:59:59.999Z`);
  }
  if (q.period && ['today', 'week', 'month', 'year'].includes(q.period)) {
    const start = startOfPeriod(q.period);
    if (start) {
      conds.push('t.created_at >= ?');
      params.push(start.toISOString());
    }
  }

  // Fechas sobre cierre/resolución real (búsqueda avanzada).
  if (q.closed_from && DATE_RE.test(String(q.closed_from))) {
    conds.push('COALESCE(t.resolved_at, t.closed_at) >= ?');
    params.push(`${String(q.closed_from)}T00:00:00.000Z`);
  }
  if (q.closed_to && DATE_RE.test(String(q.closed_to))) {
    conds.push('COALESCE(t.resolved_at, t.closed_at) <= ?');
    params.push(`${String(q.closed_to)}T23:59:59.999Z`);
  }

  return { conds, params };
}

const SORT_COLUMNS = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  ticket_number: 't.ticket_number',
  closed_at: 'COALESCE(t.resolved_at, t.closed_at)',
  priority: `CASE t.priority WHEN 'CRITICAL' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 1 ELSE 0 END`,
  status: `CASE t.status WHEN 'OPEN' THEN 0 WHEN 'ASSIGNED' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'PENDING' THEN 3 WHEN 'RESOLVED' THEN 4 WHEN 'CLOSED' THEN 5 ELSE 6 END`,
  title: 't.title',
};

function sortClause(req) {
  const col = SORT_COLUMNS[req.query.sort] || SORT_COLUMNS.created_at;
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${dir}, t.id DESC`;
}

const FROM_JOINS = `
  FROM tickets t
  JOIN users r ON r.id = t.reporter_id
  LEFT JOIN users au ON au.id = t.assigned_to_id
  LEFT JOIN teams te ON te.id = t.assigned_team_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN departments d ON d.id = t.department_id
`;

const LIST_SQL = `
  SELECT t.*,
    r.name || ' ' || r.last_name AS reporter_name,
    r.email AS reporter_email,
    COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name,
    COALESCE(te.name, '') AS team_name,
    c.name AS category_name, c.color AS category_color,
    d.name AS department_name,
    CASE WHEN t.sla_due_at IS NOT NULL
              AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')
              AND t.sla_due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         THEN 1 ELSE 0 END AS is_overdue,
    (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS attachment_count
  ${FROM_JOINS}
`;

function listQuery(req, viewOnlyOwn) {
  const { conds, params } = buildConditions(req, viewOnlyOwn);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseIntSafe(req.query.perPage) || 15));

  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM_JOINS} ${where}`).get(...params).n;
  const data = db.prepare(`${LIST_SQL} ${where} ${sortClause(req)} LIMIT ? OFFSET ?`).all(
    ...params, perPage, (page - 1) * perPage
  );
  return { data, total, page, perPage, pages: Math.ceil(total / perPage) };
}

// ---------------------------------------------------------------------------
// Contadores dinámicos (filtros rápidos) — calculados en BD, con scope por rol
// ---------------------------------------------------------------------------

router.get('/counters', (req, res) => {
  const user = req.user;
  const staff = hasPerm(user, 'ticket.view.all');
  const scopeParams = staff ? [] : [user.id];
  const prefix = staff ? 'WHERE ' : 'WHERE t.reporter_id = ? AND ';

  const cnt = (cond, params = []) =>
    db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${prefix}${cond}`).get(...scopeParams, ...params).n;

  const openSql = `t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
  const openParams = OPEN_STATUSES;
  const closedSql = 'COALESCE(t.resolved_at, t.closed_at) IS NOT NULL';
  const closedCol = 'COALESCE(t.resolved_at, t.closed_at)';

  const byStatusRows = staff
    ? db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()
    : db.prepare('SELECT status, COUNT(*) AS n FROM tickets WHERE reporter_id = ? GROUP BY status').all(user.id);
  const byStatus = {};
  for (const row of byStatusRows) byStatus[row.status] = row.n;

  const teams = myTeamIds(user.id);
  const myTeams = teams.length
    ? cnt(`t.assigned_team_id IN (${teams.map(() => '?').join(',')})`, teams)
    : 0;

  const closed = {};
  for (const period of ['today', 'yesterday', 'week', 'month', 'quarter', 'year']) {
    const range = closedRange(period);
    closed[period] = cnt(
      `${closedSql} AND ${closedCol} >= ? AND ${closedCol} < ?`,
      [range.start, range.end]
    );
  }

  res.json({
    all: cnt('1 = 1'),
    open: cnt(openSql, openParams),
    pending: cnt(`t.status IN ('OPEN', 'PENDING')`),
    attended: cnt(`t.status IN ('ASSIGNED', 'IN_PROGRESS')`),
    in_progress: cnt(`t.status = 'IN_PROGRESS'`),
    unassigned: cnt(`${openSql} AND t.assigned_to_id IS NULL AND t.assigned_team_id IS NULL`, openParams),
    overdue: cnt(`${openSql} AND t.sla_due_at IS NOT NULL AND t.sla_due_at < ?`, [...openParams, nowIso()]),
    assigned_to_me: cnt(`t.assigned_to_id = ?`, [user.id]),
    assigned_to_my_teams: myTeams,
    closed: { ...closed },
    by_status: byStatus,
  });
});

// ---------------------------------------------------------------------------
// Opciones configurables del flujo de resolución (listas editables en Configuración)
// ---------------------------------------------------------------------------

router.get('/options', (req, res) => {
  res.json(getWorkflowOptions());
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

router.post(
  '/',
  requirePermission('ticket.create'),
  uploadMiddleware().array('files', config.uploads.maxFilesPerTicket),
  uploadSizeError,
  (req, res) => {
    const body = req.body || {};
    const title = safeStr(body.title);
    const description = safeStr(body.description);
    const categoryId = parseIntSafe(body.category_id);
    const priority = body.priority || 'MEDIUM';
    let departmentId = body.department_id == null || body.department_id === '' ? null : parseIntSafe(body.department_id);
    if (departmentId === null && req.user.department_id) departmentId = req.user.department_id;

    validate({
      title: rules.required(title, 'Título') + rules.max(title, 200, 'Título'),
      description: rules.required(description, 'Descripción') + rules.max(description, 10000, 'Descripción'),
      category: rules.required(categoryId, 'Categoría'),
      priority: rules.oneOf(priority, PRIORITIES, 'Prioridad'),
    });

    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!category) return res.status(400).json({ error: 'Categoría inválida' });

    if (req.files && req.files.length > config.uploads.maxFilesPerTicket) {
      return res.status(400).json({ error: `Máximo ${config.uploads.maxFilesPerTicket} archivos por ticket` });
    }

    const filesCheck = validateFiles(req.files);
    if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.reason });

    const number = nextTicketNumber();
    const info = db.prepare(
      `INSERT INTO tickets (ticket_number, title, description, reporter_id, category_id, department_id, priority, sla_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(number, title, description, req.user.id, categoryId, departmentId, priority, computeSlaDue(priority));
    const ticketId = info.lastInsertRowid;

    let attachments = [];
    try {
      attachments = persistAndInsertAttachments(filesCheck.validated, ticketId, null, req.user.id);
    } catch (err) {
      db.prepare('DELETE FROM ticket_attachments WHERE ticket_id = ?').run(ticketId);
      db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
      return res.status(500).json({ error: 'Error al guardar los archivos adjuntos' });
    }

    recordHistory(ticketId, req.user.id, 'CREATED', `Ticket creado por ${req.user.name} ${req.user.last_name}`);
    touchTicket(ticketId);

    // Avisa al personal de soporte (quien puede ver todos los tickets) de que llegó un ticket nuevo.
    const created = getTicket(ticketId);
    notifyStaff({
      type: 'NEW_TICKET',
      title: `Nuevo ticket: ${created.ticket_number}`,
      body: `${PRIORITY_LABEL[created.priority] || created.priority} · ${created.title}`,
      ticketId: created.id,
      excludeUserId: req.user.id,
      link: `/app/tickets/${created.id}`,
    });

    emitTicketEvent(ticketId, 'refresh');
    return res.status(201).json({ ticket: created, attachments });
  }
);

router.get('/', (req, res) => {
  // "Mis tickets" (frontend) pasa own=1 para forzar el scope al reportante,
  // incluso para usuarios con permiso ticket.view.all (admin/técnicos).
  const forceOwn = String(req.query.own) === '1';
  const viewOnlyOwn = forceOwn || !hasPerm(req.user, 'ticket.view.all');
  res.json(listQuery(req, viewOnlyOwn));
});

router.get('/export', requirePermission('ticket.export'), asyncHandler(async (req, res) => {
  const { conds, params } = buildConditions(req, false);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`${LIST_SQL} ${where} ORDER BY t.created_at DESC LIMIT 5000`).all(...params);

  const cols = [
    'Número', 'Título', 'Estado', 'Prioridad', 'Categoría', 'Departamento',
    'Reportado por', 'Correo reportante', 'Asignado a', 'Equipo', 'Creado', 'Actualizado',
    'Resuelto', 'Cerrado', 'Fecha de cierre', 'Vencimiento SLA', 'Vencido',
  ];
  const sep = ';';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // Neutraliza inyección de fórmulas al abrir el XLSX (celdas que inician con = + - @).
  const xlsxSafe = (v) => {
    const s = String(v ?? '');
    return /^[=+\-@]/.test(s) ? `'${s}` : s;
  };
  const lines = [cols.map(esc).join(sep)];
  for (const r of rows) {
    lines.push([
      esc(r.ticket_number),
      esc(r.title),
      esc(STATUS_LABEL[r.status] || r.status),
      esc(PRIORITY_LABEL[r.priority] || r.priority),
      esc(r.category_name),
      esc(r.department_name),
      esc(r.reporter_name),
      esc(r.reporter_email || ''),
      esc(r.assigned_name),
      esc(r.team_name),
      esc(r.created_at),
      esc(r.updated_at || ''),
      esc(r.resolved_at || ''),
      esc(r.closed_at || ''),
      esc(r.resolved_at || r.closed_at || ''),
      esc(r.sla_due_at || ''),
      esc(r.is_overdue ? 'Sí' : 'No'),
    ].join(sep));
  }

  const format = String(req.query.format || 'csv').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Tickets');
    sheet.columns = cols.map((c) => ({ header: c, key: c.replace(/\s+/g, '_') }));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + cols.length)}1` };
    for (const r of rows) {
      sheet.addRow([
        xlsxSafe(r.ticket_number), xlsxSafe(r.title), STATUS_LABEL[r.status] || r.status,
        PRIORITY_LABEL[r.priority] || r.priority, xlsxSafe(r.category_name), xlsxSafe(r.department_name),
        xlsxSafe(r.reporter_name), xlsxSafe(r.reporter_email || ''), xlsxSafe(r.assigned_name), xlsxSafe(r.team_name),
        r.created_at, r.updated_at || '', r.resolved_at || '', r.closed_at || '',
        r.resolved_at || r.closed_at || '', r.sla_due_at || '', r.is_overdue ? 'Sí' : 'No',
      ]);
    }
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
    });
    sheet.columns.forEach((c) => {
      c.width = Math.max(10, Math.min(32, (c.header.length + 8)));
    });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="tickets-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  if (format === 'pdf') {
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="tickets-${stamp}.pdf"`);
      res.send(Buffer.concat(chunks));
    });

    doc.fontSize(16).text('Reporte de tickets', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor('#64748b').text(`Generado el ${new Date().toLocaleString('es-ES')} · ${rows.length} registros`, { align: 'center' });
    doc.moveDown(0.8);
    doc.fillColor('#111827');

    const cell = (x, y, w, text, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(bold ? '#ffffff' : '#111827');
      if (bold) {
        doc.text(String(text ?? ''), x + 2, y + 2, { width: w - 4, ellipsis: true });
      } else {
        doc.text(String(text ?? ''), x + 2, y, { width: w - 4, height: 18, ellipsis: true, lineBreak: false });
      }
    };

    const headerTexts = ['N°', 'Título', 'Estado', 'Prioridad', 'Categoría', 'Reportado por', 'Asignado a', 'Creado'];
    const widths = [62, 170, 62, 55, 70, 90, 90, 82];
    const rowH = 18;
    let y = doc.y;

    // Encabezado de tabla
    doc.rect(36, y, 36 + widths.reduce((a, b) => a + b, 0), rowH).fill('#2563eb');
    let x = 36;
    headerTexts.forEach((h, i) => {
      cell(x, y, widths[i], h, true);
      x += widths[i];
    });
    y += rowH;

    for (const r of rows) {
      if (y + rowH > doc.page.height - 40) {
        doc.addPage();
        y = 36;
        doc.rect(36, y, 36 + widths.reduce((a, b) => a + b, 0), rowH).fill('#2563eb');
        x = 36;
        headerTexts.forEach((h, i) => {
          cell(x, y, widths[i], h, true);
          x += widths[i];
        });
        y += rowH;
      }
      x = 36;
      doc.rect(36, y, 36 + widths.reduce((a, b) => a + b, 0), rowH).fill(y % 36 === 0 ? '#f1f5f9' : '#ffffff');
      const cells = [
        r.ticket_number, r.title, STATUS_LABEL[r.status] || r.status,
        PRIORITY_LABEL[r.priority] || r.priority, r.category_name || '',
        r.reporter_name, r.assigned_name, String(r.created_at).slice(0, 10),
      ];
      cells.forEach((c, i) => {
        cell(x, y, widths[i], c);
        x += widths[i];
      });
      y += rowH;
    }
    doc.end();
    return;
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tickets-${stamp}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
}));

router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  // Las notas internas solo son visibles para quien puede crearlas (técnicos/admin).
  const canSeeInternal = hasPerm(req.user, 'ticket.note');
  const internalFilter = canSeeInternal ? '' : 'AND tc.is_internal = 0';
  // NOTE_ATTACHMENT_ADDED comparte la Visibility de NOTE_ADDED: sin este permiso
  // el reportante no debe saber ni que existió un archivo interno ni cómo se llama.
  const historyFilter = canSeeInternal ? '' : `AND th.action NOT IN ('NOTE_ADDED','NOTE_ATTACHMENT_ADDED')`;

  const attachments = db.prepare(`
    SELECT ta.*, u.name || ' ' || u.last_name AS uploader_name
    FROM ticket_attachments ta
    LEFT JOIN users u ON u.id = ta.uploader_id
    LEFT JOIN ticket_comments tc ON tc.id = ta.comment_id
    WHERE ta.ticket_id = ?
      AND (ta.comment_id IS NULL OR tc.is_internal = 0 OR ?)
    ORDER BY ta.created_at ASC, ta.id ASC`).all(id, canSeeInternal ? 1 : 0);

  const comments = db.prepare(`
    SELECT tc.*, u.name || ' ' || u.last_name AS user_name,
           (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.comment_id = tc.id) AS attachment_count
    FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ? ${internalFilter} ORDER BY tc.created_at ASC, tc.id ASC`).all(id);

  const history = db.prepare(`
    SELECT th.*, u.name || ' ' || u.last_name AS user_name
    FROM ticket_history th LEFT JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ? ${historyFilter} ORDER BY th.created_at ASC, th.id ASC`).all(id);

  const can = {
    resolve: hasPerm(req.user, 'ticket.resolve'),
    close: hasPerm(req.user, 'ticket.close'),
    reopen: hasPerm(req.user, 'ticket.reopen'),
    note: canSeeInternal,
    assign: hasPerm(req.user, 'ticket.assign'),
    manage: hasPerm(req.user, 'ticket.update.any'),
    cancel: hasPerm(req.user, 'ticket.update.any'),
    comment: hasPerm(req.user, 'ticket.comment'),
  };

  res.json({ ticket, attachments, comments, history, can });
});

// Conversación en vivo: emite comentarios, cambios y "escribiendo…" por SSE.
router.get('/:id/stream', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');

  // Las notas internas no deben salir hacia el reportante.
  const canSeeInternal = hasPerm(req.user, 'ticket.note');

  const unsubscribe = onTicketEvent((evt) => {
    if (evt.ticketId !== id) return;
    if (evt.type === 'comment' && evt.data?.comment?.is_internal && !canSeeInternal) return;
    if (evt.type === 'typing') {
      if (evt.data?.user_id === req.user.id) return;
      if (evt.data?.internal && !canSeeInternal) return;
    }
    try {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data || {})}\n\n`);
    } catch {
      // conexión cerrada; el cierre se maneja en req.on('close')
    }
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(':hb\n\n');
    } catch {
      // ignorar
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

router.post('/:id/typing', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }
  if (!hasPerm(req.user, 'ticket.comment')) {
    return res.status(403).json({ error: 'No tiene permiso para comentar' });
  }
  emitTicketEvent(id, 'typing', {
    user_id: req.user.id,
    user_name: `${req.user.name} ${req.user.last_name}`,
    internal: false,
  });
  res.json({ ok: true });
});

router.patch('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

  const canManage = hasPerm(req.user, 'ticket.update.any');
  const canAssign = hasPerm(req.user, 'ticket.assign');
  const canReopen = canManage || hasPerm(req.user, 'ticket.reopen');

  const body = req.body || {};
  const sets = [];
  const entries = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'Estado inválido' });
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso para cambiar el estado' });
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(body.status)) {
      return res.status(400).json({ error: 'Use el flujo específico para resolver, cerrar o cancelar el ticket' });
    }
    if (ticket.status === 'CANCELLED' && body.status !== 'CANCELLED') {
      return res.status(400).json({ error: 'No puede cambiar el estado de un ticket cancelado' });
    }
    const reopening = ['RESOLVED', 'CLOSED'].includes(ticket.status) && body.status === 'OPEN';
    if (reopening && !canReopen) return res.status(403).json({ error: 'No tiene permiso para reabrir el ticket' });
    if (body.status !== ticket.status) {
      sets.push({ col: 'status = ?', val: body.status });
      entries.push({
        action: reopening ? 'REOPENED' : 'STATUS_CHANGED',
        desc: historyDesc('status', ticket, body.status),
        old: ticket.status,
        new: body.status,
      });
      if (reopening) {
        // La fecha de resolución se limpia para no distorsionar métricas, pero
        // el contenido de la resolución anterior se conserva (no se borra).
        sets.push({ col: 'resolved_at = ?', val: null });
        sets.push({ col: 'closed_at = ?', val: null });
        sets.push({ col: 'pending_reason = ?', val: null });
        sets.push({ col: 'sla_due_at = ?', val: computeSlaDue(ticket.priority) });
        // La encuesta CSAT mide la satisfacción con la resolución anterior. Al reabrir
        // el ticket esa valoración deja de ser válida y se reinicia, para que
        // el reporte no mezcle una nota con un servicio que aún no ha ocurrido.
        sets.push({ col: 'csat_rating = ?', val: null });
        sets.push({ col: 'csat_comment = ?', val: null });
        sets.push({ col: 'csat_answered_at = ?', val: null });
      } else if (body.status === 'RESOLVED') {
        sets.push({ col: 'resolved_at = ?', val: nowIso() });
        sets.push({ col: 'resolved_by = ?', val: req.user.id });
        sets.push({ col: 'closed_at = ?', val: null });
        sets.push({ col: 'pending_reason = ?', val: null });
        sets.push({ col: 'resolution_notified = ?', val: 0 });
      } else if (body.status === 'CLOSED') {
        sets.push({ col: 'closed_at = ?', val: nowIso() });
        sets.push({ col: 'closed_by = ?', val: req.user.id });
        sets.push({ col: 'pending_reason = ?', val: null });
      } else if (body.status === 'CANCELLED') {
        sets.push({ col: 'cancelled_at = ?', val: nowIso() });
        sets.push({ col: 'cancelled_by = ?', val: req.user.id });
        sets.push({ col: 'cancel_reason = ?', val: safeStr(body.cancel_reason) || null });
        sets.push({ col: 'closed_at = ?', val: null });
        sets.push({ col: 'pending_reason = ?', val: null });
      } else if (body.status !== 'PENDING') {
        sets.push({ col: 'pending_reason = ?', val: null });
      }
    }
  }

  if (body.pending_reason !== undefined) {
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso' });
    const value = safeStr(body.pending_reason) || null;
    if (value !== ticket.pending_reason) {
      sets.push({ col: 'pending_reason = ?', val: value });
      entries.push({
        action: 'PENDING_REASON_SET',
        desc: value ? `Motivo de pendiente: ${value}` : 'Motivo de pendiente removido',
        old: ticket.pending_reason,
        new: value,
      });
    }
  }

  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return res.status(400).json({ error: 'Prioridad inválida' });
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso para cambiar la prioridad' });
    if (body.priority !== ticket.priority) {
      sets.push({ col: 'priority = ?', val: body.priority });
      // Recalcula la fecha límite de SLA con la nueva prioridad.
      if (!['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) {
        sets.push({ col: 'sla_due_at = ?', val: computeSlaDue(body.priority) });
      }
      entries.push({ action: 'PRIORITY_CHANGED', desc: historyDesc('priority', ticket, body.priority), old: ticket.priority, new: body.priority });
    }
  }

  if (body.category_id !== undefined) {
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso' });
    const catId = body.category_id === '' || body.category_id == null ? null : parseIntSafe(body.category_id);
    const cat = catId ? db.prepare('SELECT id FROM categories WHERE id = ?').get(catId) : null;
    if (!cat) return res.status(400).json({ error: 'Categoría inválida' });
    if (catId !== ticket.category_id) {
      sets.push({ col: 'category_id = ?', val: catId });
      entries.push({ action: 'CATEGORY_CHANGED', desc: historyDesc('category', ticket, catId), old: ticket.category_id, new: catId });
    }
  }

  if (body.assigned_to_id !== undefined) {
    if (!canAssign) return res.status(403).json({ error: 'No tiene permiso para asignar tickets' });
    const targetId = body.assigned_to_id === '' || body.assigned_to_id == null ? null : parseIntSafe(body.assigned_to_id);
    if (targetId !== null) {
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
      if (!u) return res.status(400).json({ error: 'Usuario inválido para asignación' });
    }
    if (targetId !== ticket.assigned_to_id) {
      sets.push({ col: 'assigned_to_id = ?', val: targetId });
      entries.push({ action: 'ASSIGNED', desc: historyDesc('assigned', ticket, targetId), old: ticket.assigned_to_id, new: targetId });
    }
  }

  if (body.assigned_team_id !== undefined) {
    if (!canAssign) return res.status(403).json({ error: 'No tiene permiso para asignar tickets' });
    const targetTeam = body.assigned_team_id === '' || body.assigned_team_id == null ? null : parseIntSafe(body.assigned_team_id);
    if (targetTeam !== null) {
      const tm = db.prepare('SELECT id FROM teams WHERE id = ? AND active = 1').get(targetTeam);
      if (!tm) return res.status(400).json({ error: 'Equipo inválido para asignación' });
    }
    if (targetTeam !== ticket.assigned_team_id) {
      sets.push({ col: 'assigned_team_id = ?', val: targetTeam });
      entries.push({ action: 'ASSIGNED_TEAM', desc: historyDesc('assigned_team', ticket, targetTeam), old: ticket.assigned_team_id, new: targetTeam });
    }
  }

  if (body.title !== undefined) {
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso' });
    const value = safeStr(body.title);
    validate({ title: rules.required(value, 'Título') + rules.max(value, 200, 'Título') });
    if (value !== ticket.title) {
      sets.push({ col: 'title = ?', val: value });
      entries.push({ action: 'UPDATED', desc: historyDesc('title', ticket, value), old: ticket.title, new: value });
    }
  }

  if (body.description !== undefined) {
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso' });
    const value = safeStr(body.description);
    validate({ description: rules.required(value, 'Descripción') + rules.max(value, 10000, 'Descripción') });
    if (value !== ticket.description) {
      sets.push({ col: 'description = ?', val: value });
      entries.push({ action: 'UPDATED', desc: historyDesc('description', ticket, value), old: ticket.description, new: value });
    }
  }

  if (!sets.length) return res.json({ ticket });

  const changedAssign = sets.some((s) => s.col.startsWith('assigned_to_id'));
  const setSql = sets.map((s) => s.col).join(', ');
  db.prepare(`UPDATE tickets SET ${setSql}, updated_at = ? WHERE id = ?`).run(...sets.map((s) => s.val), nowIso(), id);
  for (const e of entries) recordHistory(id, req.user.id, e.action, e.desc, e.old, e.new);

  const updated = getTicket(id);
  if (changedAssign) {
    notifyAssigned(updated, `${req.user.name} ${req.user.last_name}`);
    notifyTicketParticipants(updated, {
      type: 'ASSIGNED',
      actorId: req.user.id,
      titleForReporter: `Ticket asignado: ${updated.ticket_number}`,
      titleForAssignee: `Ticket asignado a usted: ${updated.ticket_number}`,
    });
  }
  if (updated.status === 'CANCELLED') {
    notifyCancelled(updated, `${req.user.name} ${req.user.last_name}`, updated.cancel_reason);
    notifyTicketCancelled(updated, req.user.id, updated.cancel_reason);
  } else if (updated.status === 'CLOSED') {
    notifyTicketClosed(updated, req.user.id, null);
  }
  emitTicketEvent(id, 'refresh');
  res.json({ ticket: updated });
});

function processComment(req, res, attachOnly) {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  const isInternal = ['1', 'true', 'on', 'si', 'sí'].includes(String(req.body?.is_internal ?? '').toLowerCase());
  if (isInternal) {
    if (!hasPerm(req.user, 'ticket.note')) {
      return res.status(403).json({ error: 'No tiene permiso para agregar notas internas' });
    }
  } else if (!hasPerm(req.user, 'ticket.comment')) {
    return res.status(403).json({ error: 'No tiene permiso para comentar' });
  }

  const hasFiles = Array.isArray(req.files) && req.files.length > 0;
  const message = safeStr(req.body.message);
  if (message) validate({ message: rules.max(message, 4000, 'Mensaje') });

  if (req.files && req.files.length > config.uploads.maxFilesPerTicket) {
    return res.status(400).json({ error: `Máximo ${config.uploads.maxFilesPerTicket} archivos por solicitud` });
  }
  if (!attachOnly && !message && !hasFiles) {
    return res.status(400).json({ error: 'Escriba un mensaje o adjunte un archivo' });
  }

  const filesCheck = validateFiles(req.files || []);
  if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.reason });

  const finalMessage = attachOnly
    ? message
    : message || (isInternal ? 'Nota interna con archivos adjuntos.' : 'Se adjuntaron archivos a este ticket.');
  const info = db.prepare(
    'INSERT INTO ticket_comments (ticket_id, user_id, message, is_internal) VALUES (?, ?, ?, ?)'
  ).run(ticket.id, req.user.id, finalMessage, isInternal ? 1 : 0);
  const commentId = info.lastInsertRowid;

  let attachments = [];
  if (filesCheck.validated.length) {
    try {
      attachments = persistAndInsertAttachments(filesCheck.validated, ticket.id, commentId, req.user.id, isInternal);
    } catch (err) {
      db.prepare('DELETE FROM ticket_comments WHERE id = ?').run(commentId);
      db.prepare('DELETE FROM ticket_attachments WHERE comment_id = ?').run(commentId);
      return res.status(500).json({ error: 'Error al guardar los archivos adjuntos' });
    }
  }

  recordHistory(
    ticket.id,
    req.user.id,
    isInternal ? 'NOTE_ADDED' : 'COMMENT_ADDED',
    isInternal
      ? `${req.user.name} ${req.user.last_name} agregó una nota interna`
      : `${req.user.name} ${req.user.last_name} agregó un comentario`
  );
  touchTicket(ticket.id);

  // Contador de uso de la respuesta rápida (plantilla). Solo se incrementa aquí,
  // después de que el comentario (y sus adjuntos) quedaron persistidos, y
  // únicamente si el usuario escribió un mensaje real.
  //
  // El identificador de la plantilla es opcional y llega en el FormData del
  // comentario. La validación usa la MISMA regla de visibilidad del selector, de
  // modo que nadie puede acreditar uso de una plantilla ajena (de otro usuario o
  // de un equipo del que no es miembro). Si la plantilla ya no es visible o fue
  // desactivada, el comentario se guarda igual y solo se omite el contador:
  // nunca se bloquea el envío por esto.
  if (!attachOnly && message) {
    const templateId = parseIntSafe(req.body?.canned_response_id);
    if (templateId) {
      const template = visibleTemplateFor(req.user, templateId);
      if (template && template.is_active) {
        // Una sola sentencia atómica: no hay endpoint que permita incrementarlo
        // de forma arbitraria ni lecturas-modificación-escrituras que se
        // pisen entre peticiones concurrentes.
        db.prepare('UPDATE canned_responses SET use_count = use_count + 1 WHERE id = ?').run(template.id);
      }
    }
  }

  const comment = db.prepare(
    `SELECT tc.*, u.name || ' ' || u.last_name AS user_name,
            (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.comment_id = tc.id) AS attachment_count
     FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id
     WHERE tc.id = ?`
  ).get(commentId);
  comment.is_internal = !!comment.is_internal;

  emitTicketEvent(ticket.id, 'comment', { comment, attachments });

  if (!isInternal) {
    notifyComment(ticket, comment, `${req.user.name} ${req.user.last_name}`);
    const title = `Nuevo comentario: ${ticket.ticket_number}`;
    notifyTicketParticipants(ticket, {
      type: 'COMMENT',
      actorId: req.user.id,
      titleForReporter: title,
      titleForAssignee: title,
    });
  }

  return res.status(201).json({
    comment,
    attachments,
  });
}

router.post(
  '/:id/comments',
  uploadMiddleware().array('files', config.uploads.maxFilesPerTicket),
  uploadSizeError,
  (req, res) => processComment(req, res, false)
);

router.post(
  '/:id/attachments',
  uploadMiddleware().array('files', config.uploads.maxFilesPerTicket),
  uploadSizeError,
  (req, res) => processComment(req, res, true)
);

router.post('/:id/assign', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!hasPerm(req.user, 'ticket.assign')) return res.status(403).json({ error: 'No tiene permiso para asignar' });

  const updates = [];
  const entries = [];
  const now = nowIso();

  if (Object.prototype.hasOwnProperty.call(req.body, 'assigned_to_id')) {
    const value = req.body.assigned_to_id;
    const targetId = value === null || value === '' ? null : parseIntSafe(value);
    if (targetId !== null) {
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
      if (!u) return res.status(400).json({ error: 'Usuario inválido para asignación' });
    }
    if (targetId !== ticket.assigned_to_id) {
      updates.push({ col: 'assigned_to_id = ?', val: targetId });
      entries.push({ action: 'ASSIGNED', desc: historyDesc('assigned', ticket, targetId), old: ticket.assigned_to_id, new: targetId });
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'assigned_team_id')) {
    const value = req.body.assigned_team_id;
    const targetTeam = value === null || value === '' ? null : parseIntSafe(value);
    if (targetTeam !== null) {
      const tm = db.prepare('SELECT id FROM teams WHERE id = ? AND active = 1').get(targetTeam);
      if (!tm) return res.status(400).json({ error: 'Equipo inválido para asignación' });
    }
    if (targetTeam !== ticket.assigned_team_id) {
      updates.push({ col: 'assigned_team_id = ?', val: targetTeam });
      entries.push({ action: 'ASSIGNED_TEAM', desc: historyDesc('assigned_team', ticket, targetTeam), old: ticket.assigned_team_id, new: targetTeam });
    }
  }

  if (updates.length) {
    const setSql = updates.map((u) => u.col).join(', ');
    db.prepare(`UPDATE tickets SET ${setSql}, updated_at = ? WHERE id = ?`).run(...updates.map((u) => u.val), now, id);
    for (const e of entries) recordHistory(id, req.user.id, e.action, e.desc, e.old, e.new);
  }

  const updated = getTicket(id);
  if (updates.some((u) => u.col.startsWith('assigned_to_id'))) {
    notifyAssigned(updated, `${req.user.name} ${req.user.last_name}`);
    notifyTicketParticipants(updated, {
      type: 'ASSIGNED',
      actorId: req.user.id,
      titleForReporter: `Ticket asignado: ${updated.ticket_number}`,
      titleForAssignee: `Ticket asignado a usted: ${updated.ticket_number}`,
    });
  }
  if (updates.length) emitTicketEvent(id, 'refresh');
  res.json({ ticket: updated });
});

// ---------------------------------------------------------------------------
// Flujo de resolución: resolver / cerrar / reabrir
// ---------------------------------------------------------------------------

function notifyTicketClosed(ticket, actorId, note) {
  const link = `/app/tickets/${ticket.id}`;
  const ids = [];
  const suffix = note ? ` ${note}` : '';
  if (ticket.reporter_id && Number(ticket.reporter_id) !== Number(actorId)) {
    ids.push(
      createNotification({
        userId: ticket.reporter_id,
        ticketId: ticket.id,
        type: 'CLOSED',
        title: `Ticket cerrado: ${ticket.ticket_number}`,
        body: `"${ticket.title}" fue cerrado.${suffix}`,
        link,
      })
    );
  }
  if (ticket.assigned_to_id && Number(ticket.assigned_to_id) !== Number(actorId)) {
    ids.push(
      createNotification({
        userId: ticket.assigned_to_id,
        ticketId: ticket.id,
        type: 'CLOSED',
        title: `Ticket cerrado: ${ticket.ticket_number}`,
        body: `"${ticket.title}" fue cerrado.`,
        link,
      })
    );
  }
  if (ticket.reporter_id && isCsatEnabled()) {
    ids.push(
      createNotification({
        userId: ticket.reporter_id,
        ticketId: ticket.id,
        type: 'CSAT',
        title: '¿Cómo fue la atención?',
        body: `Califique su experiencia en el ticket ${ticket.ticket_number}.`,
        link,
      })
    );
  }
  return ids;
}

function notifyTicketCancelled(ticket, actorId, reason) {
  const link = `/app/tickets/${ticket.id}`;
  const ids = [];
  if (ticket.reporter_id && Number(ticket.reporter_id) !== Number(actorId)) {
    ids.push(
      createNotification({
        userId: ticket.reporter_id,
        ticketId: ticket.id,
        type: 'CANCELLED',
        title: `Ticket cancelado: ${ticket.ticket_number}`,
        body: `"${ticket.title}" fue cancelado${reason ? `. Motivo: ${reason}` : ''}.`,
        link,
      })
    );
  }
  if (ticket.assigned_to_id && Number(ticket.assigned_to_id) !== Number(actorId)) {
    ids.push(
      createNotification({
        userId: ticket.assigned_to_id,
        ticketId: ticket.id,
        type: 'CANCELLED',
        title: `Ticket cancelado: ${ticket.ticket_number}`,
        body: `"${ticket.title}" fue cancelado.`,
        link,
      })
    );
  }
  return ids;
}

function isTruthyFlag(value) {
  return ['1', 'true', 'on', 'si', 'sí', 'yes'].includes(String(value ?? '').toLowerCase());
}

router.post(
  '/:id/resolve',
  requirePermission('ticket.resolve'),
  uploadMiddleware().array('files', config.uploads.maxFilesPerTicket),
  uploadSizeError,
  (req, res) => {
    const id = parseIntSafe(req.params.id);
    const ticket = getTicket(id);
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) {
      return res.status(400).json({ error: 'El ticket ya está en un estado terminal y no puede resolverse' });
    }

    const body = req.body || {};
    const resolution = safeStr(body.resolution);
    validate({
      resolution: rules.required(resolution, 'Solución') + rules.max(resolution, 10000, 'Solución'),
    });

    const resolutionCategory = safeStr(body.resolution_category).slice(0, 120) || null;
    const rootCause = safeStr(body.root_cause).slice(0, 120) || null;

    let timeSpent = null;
    if (body.time_spent_minutes !== undefined && body.time_spent_minutes !== '') {
      const n = parseIntSafe(body.time_spent_minutes);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        return res.status(400).json({ error: 'Tiempo empleado inválido' });
      }
      timeSpent = n;
    }

    if (req.files && req.files.length > config.uploads.maxFilesPerTicket) {
      return res.status(400).json({ error: `Máximo ${config.uploads.maxFilesPerTicket} archivos por solicitud` });
    }
    const filesCheck = validateFiles(req.files || []);
    if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.reason });

    const notify = isTruthyFlag(body.notify);
    const now = nowIso();

    let attachments = [];
    try {
      attachments = persistAndInsertAttachments(filesCheck.validated, id, null, req.user.id);
    } catch {
      return res.status(500).json({ error: 'Error al guardar los archivos adjuntos' });
    }

    db.prepare(
      `UPDATE tickets
         SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution = ?,
             resolution_category = ?, root_cause = ?, time_spent_minutes = ?,
             closed_at = NULL, closed_by = NULL, pending_reason = NULL,
             resolution_notified = ?, updated_at = ?
       WHERE id = ?`
    ).run(now, req.user.id, resolution, resolutionCategory, rootCause, timeSpent, notify ? 1 : 0, now, id);

    const previous = ticket.status;
    recordHistory(
      id,
      req.user.id,
      'RESOLVED',
      `Ticket resuelto: ${STATUS_LABEL[previous] || previous} → Resuelto`,
      previous,
      'RESOLVED'
    );

    if (notify) {
      // Notificación real al reportante: comentario público con la solución
      // y correo con el detalle de la resolución.
      db.prepare(
        'INSERT INTO ticket_comments (ticket_id, user_id, message, is_internal) VALUES (?, ?, ?, 0)'
      ).run(id, req.user.id, `El ticket fue resuelto.\n\nSolución: ${resolution}`);
      recordHistory(
        id,
        req.user.id,
        'COMMENT_ADDED',
        `${req.user.name} ${req.user.last_name} notificó la resolución al usuario`
      );
      notifyResolved(ticket, `${req.user.name} ${req.user.last_name}`, resolution);
    }
    if (ticket.reporter_id && Number(ticket.reporter_id) !== Number(req.user.id)) {
      createNotification({
        userId: ticket.reporter_id,
        ticketId: id,
        type: 'RESOLVED',
        title: `Ticket resuelto: ${ticket.ticket_number}`,
        body: `"${ticket.title}" fue resuelto. ${resolution.slice(0, 160)}`,
        link: `/app/tickets/${id}`,
      });
    }

    emitTicketEvent(id, 'refresh');
    return res.json({ ticket: getTicket(id), attachments });
  }
);

router.post('/:id/close', requirePermission('ticket.close'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (ticket.status === 'CLOSED') return res.status(400).json({ error: 'El ticket ya está cerrado' });
  if (ticket.status === 'CANCELLED') return res.status(400).json({ error: 'No puede cerrar un ticket cancelado' });

  if (requireResolutionToClose() && ticket.status !== 'CANCELLED' && !ticket.resolved_at && !ticket.resolution) {
    return res.status(400).json({ error: 'Debe registrar una resolución antes de cerrar el ticket.' });
  }

  const note = safeStr(req.body?.note).slice(0, 2000) || null;
  const now = nowIso();
  db.prepare(
    `UPDATE tickets SET status = 'CLOSED', closed_at = ?, closed_by = ?, pending_reason = NULL, updated_at = ? WHERE id = ?`
  ).run(now, req.user.id, now, id);

  recordHistory(
    id,
    req.user.id,
    'CLOSED',
    `Ticket cerrado: ${STATUS_LABEL[ticket.status] || ticket.status} → Cerrado${note ? `. ${note}` : ''}`,
    ticket.status,
    'CLOSED'
  );
  const updated = getTicket(id);
  notifyTicketClosed(updated, req.user.id, note);
  emitTicketEvent(id, 'refresh');
  res.json({ ticket: updated });
});

// Cancelar con motivo obligatorio: notifica al reportante y audita la acción.
router.post('/:id/cancel', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!hasPerm(req.user, 'ticket.update.any')) {
    return res.status(403).json({ error: 'No tiene permiso para cancelar tickets' });
  }
  if (ticket.status === 'CANCELLED') return res.status(400).json({ error: 'El ticket ya está cancelado' });
  if (['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'No puede cancelar un ticket resuelto o cerrado' });
  }

  const reason = safeStr(req.body?.reason);
  validate({ reason: rules.required(reason, 'Motivo de cancelación') + rules.max(reason, 2000, 'Motivo de cancelación') });

  const now = nowIso();
  db.prepare(
    `UPDATE tickets
       SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = ?,
           closed_at = NULL, closed_by = NULL, resolved_at = NULL,
           pending_reason = NULL, updated_at = ?
     WHERE id = ?`
  ).run(reason, req.user.id, now, now, id);

  recordHistory(
    id,
    req.user.id,
    'CANCELLED',
    `Ticket cancelado: ${STATUS_LABEL[ticket.status] || ticket.status} → Cancelado${reason ? `. Motivo: ${reason}` : ''}`,
    ticket.status,
    'CANCELLED'
  );
  touchTicket(id);

  const updated = getTicket(id);
  notifyCancelled(updated, `${req.user.name} ${req.user.last_name}`, reason);
  notifyTicketCancelled(updated, req.user.id, reason);
  emitTicketEvent(id, 'refresh');
  res.json({ ticket: updated });
});

// Encuesta de satisfacción (solo el reportante, una vez por ticket).
router.post('/:id/csat', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (ticket.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Solo el reportante puede calificar este ticket' });
  }
  if (!['CLOSED', 'RESOLVED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'Solo puede calificar tickets cerrados o resueltos' });
  }
  if (ticket.csat_answered_at) {
    return res.status(400).json({ error: 'Ya calificó este ticket' });
  }
  if (!isCsatEnabled()) {
    return res.status(400).json({ error: 'La encuesta de satisfacción está desactivada' });
  }

  const rating = parseIntSafe(req.body?.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Calificación inválida (1-5)' });
  }
  const comment = safeStr(req.body?.comment).slice(0, 2000) || null;

  const now = nowIso();
  db.prepare(
    `UPDATE tickets SET csat_rating = ?, csat_comment = ?, csat_answered_at = ?, updated_at = ? WHERE id = ?`
  ).run(rating, comment, now, now, id);

  recordHistory(
    id,
    req.user.id,
    'CSAT_RATED',
    `Encuesta de satisfacción: ${rating}${comment ? ` / ${comment}` : ''}`
  );

  if (ticket.resolved_by) {
    createNotification({
      userId: ticket.resolved_by,
      ticketId: id,
      type: 'CSAT_RATED',
      title: `Calificación recibida: ${rating}/5`,
      body: ticket.title,
      link: `/app/tickets/${id}`,
    });
  }

  const updated = getTicket(id);
  emitTicketEvent(id, 'refresh');
  res.json({ ticket: updated });
});

router.post('/:id/reopen', requirePermission('ticket.reopen'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'Solo se pueden reabrir tickets resueltos o cerrados' });
  }

  const reason = safeStr(req.body?.reason);
  validate({
    reason: rules.required(reason, 'Motivo de reapertura') + rules.max(reason, 2000, 'Motivo de reapertura'),
  });

  const now = nowIso();
  // Se conservan solution/root_cause/time_spent/resolved_by de la resolución anterior.
  // La encuesta CSAT sí se reinicia: valoraba la resolución que ya no está en pie.
  db.prepare(
    `UPDATE tickets
       SET status = 'OPEN', reopened_at = ?, reopened_by = ?, reopen_reason = ?,
           resolved_at = NULL, closed_at = NULL, pending_reason = NULL,
           sla_due_at = ?, updated_at = ?,
           csat_rating = NULL, csat_comment = NULL, csat_answered_at = NULL
     WHERE id = ?`
  ).run(now, req.user.id, reason, computeSlaDue(ticket.priority), now, id);

  recordHistory(
    id,
    req.user.id,
    'REOPENED',
    `Ticket reabierto: ${STATUS_LABEL[ticket.status] || ticket.status} → Abierto. Motivo: ${reason}`,
    ticket.status,
    'OPEN'
  );
  emitTicketEvent(id, 'refresh');
  res.json({ ticket: getTicket(id) });
});

export { nameForTeam };

export default router;
