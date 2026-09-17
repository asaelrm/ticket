import express from 'express';
import db, { nowIso } from '../db.js';
import config from '../config.js';
import { validate, rules, safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { uploadMiddleware, uploadSizeError } from '../middleware/upload.js';
import { validateFile, persistUpload } from '../utils/fileType.js';
import { nextTicketNumber } from '../utils/ticketNumber.js';

const router = express.Router();
router.use(requireAuth);

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
    COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name,
    c.name AS category_name, c.color AS category_color,
    d.name AS department_name,
    (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS attachment_count
  FROM tickets t
  JOIN users r ON r.id = t.reporter_id
  LEFT JOIN users au ON au.id = t.assigned_to_id
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
    case 'title':
      return `Título actualizado: "${ticket.title}" → "${newValue}"`;
    case 'description':
      return 'Descripción actualizada';
    default:
      return 'Ticket actualizado';
  }
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
      validated.push({ buffer: f.buffer, info });
    }
  }
  if (errors.length) return { ok: false, reason: errors.join('. ') };
  return { ok: true, validated };
}

function persistAndInsertAttachments(validated, ticketId, commentId, userId) {
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
    recordHistory(ticketId, userId, 'ATTACHMENT_ADDED', `Se adjuntó ${saved.originalName}`);
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_LIST_RE = /^\d+(,\d+)*$/;
const ENUM_LIST = { status: STATUSES, priority: PRIORITIES };

function buildConditions(req, viewOnlyOwn) {
  const conds = [];
  const params = [];
  const q = req.query;

  if (viewOnlyOwn) {
    conds.push('t.reporter_id = ?');
    params.push(req.user.id);
  }

  if (q.search) {
    conds.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.ticket_number LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(q.search)}%`;
    params.push(like, like, like);
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

  if (q.assigned === 'none') {
    conds.push('t.assigned_to_id IS NULL');
  } else if (q.assigned && ID_LIST_RE.test(String(q.assigned))) {
    conds.push('t.assigned_to_id = ?');
    params.push(parseInt(q.assigned, 10));
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

  return { conds, params };
}

function sortClause(req) {
  const allowed = ['ticket_number', 'created_at', 'updated_at', 'priority', 'status', 'title'];
  const col = allowed.includes(req.query.sort) ? req.query.sort : 'created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${dir}, t.id DESC`;
}

const LIST_SQL = `
  SELECT t.*,
    r.name || ' ' || r.last_name AS reporter_name,
    COALESCE(au.name || ' ' || au.last_name, '') AS assigned_name,
    c.name AS category_name, c.color AS category_color,
    d.name AS department_name,
    (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS attachment_count
  FROM tickets t
  JOIN users r ON r.id = t.reporter_id
  LEFT JOIN users au ON au.id = t.assigned_to_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN departments d ON d.id = t.department_id
`;

function listQuery(req, viewOnlyOwn) {
  const { conds, params } = buildConditions(req, viewOnlyOwn);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseIntSafe(req.query.perPage) || 15));

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${where}`).get(...params).n;
  const data = db.prepare(`${LIST_SQL} ${where} ${sortClause(req)} LIMIT ? OFFSET ?`).all(
    ...params, perPage, (page - 1) * perPage
  );
  return { data, total, page, perPage, pages: Math.ceil(total / perPage) };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

router.post(
  '/',
  requirePermission('ticket.create'),
  uploadMiddleware().array('files', 20),
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
      `INSERT INTO tickets (ticket_number, title, description, reporter_id, category_id, department_id, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(number, title, description, req.user.id, categoryId, departmentId, priority);
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

    return res.status(201).json({ ticket: getTicket(ticketId), attachments });
  }
);

router.get('/', (req, res) => {
  const viewOnlyOwn = !hasPerm(req.user, 'ticket.view.all');
  res.json(listQuery(req, viewOnlyOwn));
});

router.get('/export', requirePermission('ticket.export'), (req, res) => {
  const { conds, params } = buildConditions(req, false);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`${LIST_SQL} ${where} ORDER BY t.created_at DESC LIMIT 5000`).all(...params);

  const cols = ['ticket_number', 'title', 'estado', 'prioridad', 'categoría', 'departamento', 'reportado_por', 'asignado_a', 'creado_en', 'resuelto_en', 'cerrado_en'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      esc(r.ticket_number),
      esc(r.title),
      esc(STATUS_LABEL[r.status] || r.status),
      esc(PRIORITY_LABEL[r.priority] || r.priority),
      esc(r.category_name),
      esc(r.department_name),
      esc(r.reporter_name),
      esc(r.assigned_name),
      esc(r.created_at),
      esc(r.resolved_at || ''),
      esc(r.closed_at || ''),
    ].join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tickets-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

router.get('/:id', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  const attachments = db.prepare(`
    SELECT ta.*, u.name || ' ' || u.last_name AS uploader_name
    FROM ticket_attachments ta LEFT JOIN users u ON u.id = ta.uploader_id
    WHERE ta.ticket_id = ? ORDER BY ta.created_at ASC, ta.id ASC`).all(id);

  const comments = db.prepare(`
    SELECT tc.*, u.name || ' ' || u.last_name AS user_name
    FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id
    WHERE tc.ticket_id = ? ORDER BY tc.created_at ASC, tc.id ASC`).all(id);

  const history = db.prepare(`
    SELECT th.*, u.name || ' ' || u.last_name AS user_name
    FROM ticket_history th LEFT JOIN users u ON u.id = th.user_id
    WHERE th.ticket_id = ? ORDER BY th.created_at ASC, th.id ASC`).all(id);

  res.json({ ticket, attachments, comments, history });
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
        sets.push({ col: 'resolved_at = ?', val: null });
        sets.push({ col: 'closed_at = ?', val: null });
      } else if (body.status === 'RESOLVED') {
        sets.push({ col: 'resolved_at = ?', val: nowIso() });
        sets.push({ col: 'closed_at = ?', val: null });
      } else if (body.status === 'CLOSED') {
        sets.push({ col: 'closed_at = ?', val: nowIso() });
      }
    }
  }

  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return res.status(400).json({ error: 'Prioridad inválida' });
    if (!canManage) return res.status(403).json({ error: 'No tiene permiso para cambiar la prioridad' });
    if (body.priority !== ticket.priority) {
      sets.push({ col: 'priority = ?', val: body.priority });
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

  const setSql = sets.map((s) => s.col).join(', ');
  db.prepare(`UPDATE tickets SET ${setSql}, updated_at = ? WHERE id = ?`).run(...sets.map((s) => s.val), nowIso(), id);
  for (const e of entries) recordHistory(id, req.user.id, e.action, e.desc, e.old, e.new);
  res.json({ ticket: getTicket(id) });
});

function processComment(req, res, attachOnly) {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }
  if (!hasPerm(req.user, 'ticket.comment')) {
    return res.status(403).json({ error: 'No tiene permiso para comentar' });
  }

  const hasFiles = Array.isArray(req.files) && req.files.length > 0;
  const message = safeStr(req.body.message);

  if (req.files && req.files.length > config.uploads.maxFilesPerTicket) {
    return res.status(400).json({ error: `Máximo ${config.uploads.maxFilesPerTicket} archivos por solicitud` });
  }
  if (!attachOnly && !message && !hasFiles) {
    return res.status(400).json({ error: 'Escriba un mensaje o adjunte un archivo' });
  }

  const filesCheck = validateFiles(req.files || []);
  if (!filesCheck.ok) return res.status(400).json({ error: filesCheck.reason });

  const finalMessage = attachOnly ? message : message || 'Se adjuntaron archivos a este ticket.';
  const info = db.prepare(
    'INSERT INTO ticket_comments (ticket_id, user_id, message) VALUES (?, ?, ?)'
  ).run(ticket.id, req.user.id, finalMessage);
  const commentId = info.lastInsertRowid;

  let attachments = [];
  if (filesCheck.validated.length) {
    try {
      attachments = persistAndInsertAttachments(filesCheck.validated, ticket.id, commentId, req.user.id);
    } catch (err) {
      db.prepare('DELETE FROM ticket_comments WHERE id = ?').run(commentId);
      db.prepare('DELETE FROM ticket_attachments WHERE comment_id = ?').run(commentId);
      return res.status(500).json({ error: 'Error al guardar los archivos adjuntos' });
    }
  }

  recordHistory(ticket.id, req.user.id, 'COMMENT_ADDED', `${req.user.name} ${req.user.last_name} agregó un comentario`);
  touchTicket(ticket.id);

  return res.status(201).json({
    comment: { id: commentId, message: finalMessage, user_id: req.user.id, created_at: nowIso() },
    attachments,
  });
}

router.post(
  '/:id/comments',
  uploadMiddleware().array('files', 20),
  uploadSizeError,
  (req, res) => processComment(req, res, false)
);

router.post(
  '/:id/attachments',
  uploadMiddleware().array('files', 20),
  uploadSizeError,
  (req, res) => processComment(req, res, true)
);

router.post('/:id/assign', (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticket = getTicket(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!hasPerm(req.user, 'ticket.assign')) return res.status(403).json({ error: 'No tiene permiso para asignar' });

  const value = req.body.assigned_to_id;
  const targetId = value === null || value === '' ? null : parseIntSafe(value);
  if (targetId !== null) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(targetId);
    if (!u) return res.status(400).json({ error: 'Usuario inválido para asignación' });
  }

  db.prepare('UPDATE tickets SET assigned_to_id = ?, updated_at = ? WHERE id = ?').run(targetId, nowIso(), id);
  recordHistory(id, req.user.id, 'ASSIGNED', historyDesc('assigned', ticket, targetId), ticket.assigned_to_id, targetId);
  res.json({ ticket: getTicket(id) });
});

export default router;