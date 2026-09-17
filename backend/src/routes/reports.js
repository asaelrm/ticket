import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requirePermission('report.view'));

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];
const STATUS_LABEL = {
  OPEN: 'Abierto', ASSIGNED: 'Asignado', IN_PROGRESS: 'En proceso', PENDING: 'Pendiente',
  RESOLVED: 'Resuelto', CLOSED: 'Cerrado', CANCELLED: 'Cancelado',
};
const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Filtro por rango de fecha de creación. Devuelve condiciones ya parametrizadas.
function dateFilter(req, alias = 't') {
  const conds = [];
  const params = [];
  if (req.query.from && DATE_RE.test(String(req.query.from))) {
    conds.push(`${alias}.created_at >= ?`);
    params.push(`${req.query.from}T00:00:00.000Z`);
  }
  if (req.query.to && DATE_RE.test(String(req.query.to))) {
    conds.push(`${alias}.created_at <= ?`);
    params.push(`${req.query.to}T23:59:59.999Z`);
  }
  return { conds, params };
}

function whereFrom(conds) {
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

function reportData(req) {
  const df = dateFilter(req);
  const base = whereFrom(df.conds);

  const combine = (extra = []) => {
    const conds = [...extra, ...df.conds];
    return { sql: whereFrom(conds), params: [...df.params] };
  };

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${base}`).get(...df.params).n;

  const openCond = `t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
  const wOpen = combine([openCond]);
  const open = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${wOpen.sql}`).get(...OPEN_STATUSES, ...wOpen.params).n;

  const wUnresolved = combine([openCond, 't.created_at < ?']);
  const unresolved = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t ${wUnresolved.sql}`)
    .get(...OPEN_STATUSES, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), ...wUnresolved.params).n;

  const wResolved = combine([`t.status IN ('RESOLVED','CLOSED')`]);
  const resolved = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${wResolved.sql}`).get(...wResolved.params).n;

  const wAvg = combine([`(t.resolved_at IS NOT NULL OR t.closed_at IS NOT NULL)`]);
  const avgResolution = db
    .prepare(
      `SELECT AVG((julianday(COALESCE(t.resolved_at, t.closed_at, t.updated_at)) - julianday(t.created_at)) * 24) AS hours
       FROM tickets t ${wAvg.sql}`
    )
    .get(...wAvg.params).hours;

  const byStatus = db
    .prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t ${base} GROUP BY t.status ORDER BY n DESC`)
    .all(...df.params);

  const wPriority = combine([openCond]);
  const byPriority = db
    .prepare(`SELECT t.priority, COUNT(*) AS n FROM tickets t ${wPriority.sql} GROUP BY t.priority ORDER BY n DESC`)
    .all(...OPEN_STATUSES, ...wPriority.params);

  const wCat = combine([`c.active = 1`]);
  const byCategory = db
    .prepare(
      `SELECT c.name, c.color, COUNT(t.id) AS n,
         SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
       FROM categories c
       LEFT JOIN tickets t ON t.category_id = c.id ${wCat.sql.replace(/^WHERE /, 'AND ')}
       GROUP BY c.id ORDER BY n DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...wCat.params);

  const byDepartment = db
    .prepare(
      `SELECT COALESCE(d.name, 'Sin departamento') AS name, COUNT(t.id) AS n,
         SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
       FROM tickets t
       LEFT JOIN departments d ON d.id = t.department_id ${base}
       GROUP BY d.id ORDER BY n DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...df.params);

  const wDay = combine([`(t.resolved_at IS NOT NULL OR t.closed_at IS NOT NULL)`]);
  const byDay = db
    .prepare(
      `SELECT date(COALESCE(t.resolved_at, t.closed_at)) AS day, COUNT(*) AS n
       FROM tickets t ${wDay.sql} GROUP BY day ORDER BY day DESC LIMIT 30`
    )
    .all(...wDay.params);

  const wUser = combine([]);
  const byUser = db
    .prepare(
      `SELECT r.name || ' ' || r.last_name AS reporter, COUNT(*) AS total,
         SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
       FROM tickets t JOIN users r ON r.id = t.reporter_id ${wUser.sql}
       GROUP BY t.reporter_id ORDER BY total DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...wUser.params);

  return {
    range: { from: req.query.from || null, to: req.query.to || null },
    summary: {
      total,
      open,
      resolved,
      unresolved_week: unresolved,
      avg_resolution_hours: Math.round((avgResolution || 0) * 10) / 10,
    },
    by_status: byStatus,
    by_priority: byPriority,
    by_category: byCategory,
    by_department: byDepartment,
    by_day: byDay,
    by_user: byUser,
  };
}

router.get('/summary', (req, res) => {
  const { summary, range } = reportData(req);
  res.json({ ...summary, range });
});

router.get('/by-status', (req, res) => {
  res.json({ data: reportData(req).by_status });
});

router.get('/by-priority', (req, res) => {
  res.json({ data: reportData(req).by_priority });
});

router.get('/by-category', (req, res) => {
  res.json({ data: reportData(req).by_category });
});

router.get('/by-department', (req, res) => {
  res.json({ data: reportData(req).by_department });
});

router.get('/performance', (req, res) => {
  const r = reportData(req);
  res.json({ by_day: r.by_day, by_user: r.by_user });
});

// Exporta el reporte completo como CSV organizado por secciones (Excel/ES con ';').
router.get('/export', (req, res) => {
  const r = reportData(req);
  const sep = ';';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = (...cells) => cells.map(esc).join(sep);
  const lines = [];

  const rangeLabel =
    r.range.from || r.range.to
      ? `Del ${r.range.from || 'inicio'} al ${r.range.to || 'hoy'}`
      : 'Todo el historial';
  lines.push(row('REPORTE DE TICKETS'));
  lines.push(row('Rango', rangeLabel));
  lines.push(row('Generado', new Date().toLocaleString('es-ES')));
  lines.push('');

  lines.push(row('RESUMEN'));
  lines.push(row('Métrica', 'Valor'));
  lines.push(row('Total de tickets', r.summary.total));
  lines.push(row('Tickets abiertos', r.summary.open));
  lines.push(row('Resueltos + cerrados', r.summary.resolved));
  lines.push(row('Sin resolver > 7 días', r.summary.unresolved_week));
  lines.push(
    row(
      'Tiempo medio de resolución',
      r.summary.avg_resolution_hours >= 24
        ? `${(r.summary.avg_resolution_hours / 24).toFixed(1)} días`
        : `${r.summary.avg_resolution_hours} h`
    )
  );
  lines.push('');

  lines.push(row('TICKETS POR ESTADO'));
  lines.push(row('Estado', 'Cantidad'));
  for (const d of r.by_status) lines.push(row(STATUS_LABEL[d.status] || d.status, d.n));
  lines.push('');

  lines.push(row('TICKETS ABIERTOS POR PRIORIDAD'));
  lines.push(row('Prioridad', 'Cantidad'));
  for (const d of r.by_priority) lines.push(row(PRIORITY_LABEL[d.priority] || d.priority, d.n));
  lines.push('');

  lines.push(row('TICKETS POR CATEGORÍA'));
  lines.push(row('Categoría', 'Total', 'Abiertos'));
  for (const d of r.by_category) lines.push(row(d.name, d.n, d.open));
  lines.push('');

  lines.push(row('TICKETS POR DEPARTAMENTO'));
  lines.push(row('Departamento', 'Total', 'Abiertos'));
  for (const d of r.by_department) lines.push(row(d.name, d.n, d.open));
  lines.push('');

  lines.push(row('TOP REPORTEROS'));
  lines.push(row('Empleado', 'Total', 'Abiertos'));
  for (const u of r.by_user) lines.push(row(u.reporter, u.total, u.open));
  lines.push('');

  lines.push(row('RESUELTOS POR DÍA (últimos 30)'));
  lines.push(row('Día', 'Cantidad'));
  for (const d of r.by_day) lines.push(row(d.day, d.n));

  const suffix = r.range.from || r.range.to ? `${r.range.from || 'inicio'}_${r.range.to || 'hoy'}` : 'completo';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="reporte-tickets-${suffix}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

export default router;
