import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { parseIntSafe } from '../utils/validation.js';

const router = express.Router();
router.use(requireAuth, requirePermission('settings.manage'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Auditoría consultable: historial de cambios sobre tickets.
router.get('/', (req, res) => {
  const conds = [];
  const params = [];

  if (req.query.search) {
    const like = `%${String(req.query.search).toLowerCase()}%`;
    conds.push(`(lower(th.description) LIKE ? OR lower(t.ticket_number) LIKE ? OR lower(t.title) LIKE ?)`);
    params.push(like, like, like);
  }
  if (req.query.action) {
    conds.push('th.action = ?');
    params.push(String(req.query.action).slice(0, 40));
  }
  if (req.query.user && /^\d+$/.test(String(req.query.user))) {
    conds.push('th.user_id = ?');
    params.push(parseIntSafe(req.query.user));
  }
  if (req.query.from && DATE_RE.test(String(req.query.from))) {
    conds.push('th.created_at >= ?');
    params.push(`${req.query.from}T00:00:00.000Z`);
  }
  if (req.query.to && DATE_RE.test(String(req.query.to))) {
    conds.push('th.created_at <= ?');
    params.push(`${req.query.to}T23:59:59.999Z`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const page = Math.max(1, parseIntSafe(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseIntSafe(req.query.perPage) || 30));

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ticket_history th
       JOIN tickets t ON t.id = th.ticket_id ${where}`
    )
    .get(...params).n;

  const rows = db
    .prepare(
      `SELECT th.*, u.name || ' ' || u.last_name AS user_name,
              t.ticket_number, t.title AS ticket_title
       FROM ticket_history th
       JOIN tickets t ON t.id = th.ticket_id
       LEFT JOIN users u ON u.id = th.user_id
       ${where}
       ORDER BY th.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, perPage, (page - 1) * perPage);

  const actions = db.prepare('SELECT DISTINCT action FROM ticket_history ORDER BY action').all().map((r) => r.action);

  res.json({ data: rows, total, page, perPage, pages: Math.ceil(total / perPage), actions });
});

export default router;