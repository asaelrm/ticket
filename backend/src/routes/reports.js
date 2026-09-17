import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requirePermission('report.view'));

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

router.get('/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;

  const open = db.prepare(
    `SELECT COUNT(*) AS n FROM tickets WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
  ).get(...OPEN_STATUSES).n;

  const unresolved = db.prepare(
    `SELECT COUNT(*) AS n FROM tickets
     WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       AND created_at < ?`
  ).get(...OPEN_STATUSES, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()).n;

  const resolved = db.prepare(
    `SELECT COUNT(*) AS n FROM tickets WHERE status IN ('RESOLVED','CLOSED')`
  ).get().n;

  const avgResolution = db.prepare(
    `SELECT AVG((julianday(COALESCE(resolved_at, closed_at, updated_at)) - julianday(created_at)) * 24) AS hours
     FROM tickets WHERE resolved_at IS NOT NULL OR closed_at IS NOT NULL`
  ).get().hours;

  res.json({
    total,
    open,
    resolved,
    unresolved_week: unresolved,
    avg_resolution_hours: Math.round((avgResolution || 0) * 10) / 10,
  });
});

router.get('/by-status', (req, res) => {
  res.json({
    data: db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC').all(),
  });
});

router.get('/by-priority', (req, res) => {
  res.json({
    data: db.prepare(
      `SELECT priority, COUNT(*) AS n FROM tickets
       WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       GROUP BY priority ORDER BY n DESC`
    ).all(...OPEN_STATUSES),
  });
});

router.get('/by-category', (req, res) => {
  res.json({
    data: db.prepare(`
      SELECT c.name, c.color, COUNT(t.id) AS n,
        SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
      FROM categories c
      LEFT JOIN tickets t ON t.category_id = c.id
      WHERE c.active = 1
      GROUP BY c.id ORDER BY n DESC LIMIT 10
    `).all(...OPEN_STATUSES),
  });
});

router.get('/by-department', (req, res) => {
  res.json({
    data: db.prepare(`
      SELECT COALESCE(d.name, 'Sin departamento') AS name, COUNT(t.id) AS n,
        SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
      FROM tickets t
      LEFT JOIN departments d ON d.id = t.department_id
      GROUP BY d.id ORDER BY n DESC LIMIT 10
    `).all(...OPEN_STATUSES),
  });
});

router.get('/performance', (req, res) => {
  // Resueltos por día (últimos 30) y por categoría destacada.
  const byDay = db.prepare(`
    SELECT date(COALESCE(resolved_at, closed_at)) AS day, COUNT(*) AS n
    FROM tickets
    WHERE resolved_at IS NOT NULL OR closed_at IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all();

  const byUser = db.prepare(`
    SELECT r.name || ' ' || r.last_name AS reporter,
      COUNT(*) AS total,
      SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
    FROM tickets t JOIN users r ON r.id = t.reporter_id
    GROUP BY t.reporter_id ORDER BY total DESC LIMIT 10
  `).all(...OPEN_STATUSES);

  res.json({ by_day: byDay, by_user: byUser });
});

export default router;