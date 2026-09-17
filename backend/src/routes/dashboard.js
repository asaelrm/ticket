import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requirePermission('dashboard.view'));

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function mondayOfCurrentWeek() {
  const d = new Date();
  const diff = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

router.get('/summary', (req, res) => {
  const counts = { OPEN: 0, ASSIGNED: 0, IN_PROGRESS: 0, PENDING: 0, RESOLVED: 0, CLOSED: 0, CANCELLED: 0 };
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
  for (const row of byStatus) counts[row.status] = row.n;

  const openTotal = OPEN_STATUSES.reduce((a, s) => a + counts[s], 0);
  const critical = db.prepare(
    `SELECT COUNT(*) AS n FROM tickets WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND priority = 'CRITICAL'`
  ).get(...OPEN_STATUSES).n;

  const year = new Date().getUTCFullYear();
  const month = String(new Date().getUTCMonth() + 1).padStart(2, '0');
  const createdMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE strftime('%Y-%m', created_at) = ?`).get(`${year}-${month}`).n;
  const resolvedMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status = 'RESOLVED' AND strftime('%Y-%m', resolved_at) = ?`).get(`${year}-${month}`).n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;

  res.json({ counts, openTotal, critical, createdMonth, resolvedMonth, total });
});

router.get('/by-status', (req, res) => {
  res.json({ data: db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC').all() });
});

router.get('/by-priority', (req, res) => {
  const data = db.prepare(
    `SELECT priority, COUNT(*) AS n FROM tickets WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')}) GROUP BY priority ORDER BY n DESC`
  ).all(...OPEN_STATUSES);
  const open = data.reduce((a, b) => a + b.n, 0);
  res.json({ data, open });
});

router.get('/by-category', (req, res) => {
  const data = db.prepare(`
    SELECT c.name, c.color, COUNT(t.id) AS n,
      SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
    FROM categories c
    LEFT JOIN tickets t ON t.category_id = c.id
    WHERE c.active = 1
    GROUP BY c.id ORDER BY n DESC LIMIT 10
  `).all(...OPEN_STATUSES);
  res.json({ data });
});

router.get('/by-department', (req, res) => {
  const data = db.prepare(`
    SELECT d.name, COUNT(t.id) AS n,
      SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
    FROM departments d
    LEFT JOIN tickets t ON t.department_id = d.id
    GROUP BY d.id ORDER BY n DESC LIMIT 10
  `).all(...OPEN_STATUSES);
  res.json({ data });
});

router.get('/trend', (req, res) => {
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  const data = [];
  const countCreatedDay = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE date(created_at) = ?');
  const countResolvedDay = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE date(resolved_at) = ?');
  const countCreatedMonth = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE strftime('%Y-%m', created_at) = ?");
  const countResolvedMonth = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE strftime('%Y-%m', resolved_at) = ?");

  if (range === 'day') {
    for (let i = 13; i >= 0; i--) {
      const label = isoDate(-i);
      data.push({
        label,
        created: countCreatedDay.get(label).n,
        resolved: countResolvedDay.get(label).n,
      });
    }
  } else if (range === 'week') {
    const base = mondayOfCurrentWeek();
    for (let i = 7; i >= 0; i--) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const start = d.toISOString();
      const end = new Date(d);
      end.setUTCDate(end.getUTCDate() + 7);
      data.push({
        label: start.slice(0, 10),
        created: db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND created_at < ?').get(start, end.toISOString()).n,
        resolved: db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE resolved_at >= ? AND resolved_at < ?').get(start, end.toISOString()).n,
      });
    }
  } else {
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      data.push({
        label,
        created: countCreatedMonth.get(label).n,
        resolved: countResolvedMonth.get(label).n,
      });
    }
  }

  res.json({ data });
});

router.get('/recent', (req, res) => {
  const data = db.prepare(`
    SELECT t.ticket_number, t.title, t.status, t.priority, t.created_at,
      c.name AS category_name, r.name || ' ' || r.last_name AS reporter_name
    FROM tickets t
    JOIN users r ON r.id = t.reporter_id
    LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY t.created_at DESC LIMIT 8`).all();
  res.json({ data });
});

export default router;