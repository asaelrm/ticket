import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requirePermission('report.view'));

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];
const OPEN_IN = `t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
const STATUS_LABEL = {
  OPEN: 'Abierto', ASSIGNED: 'Asignado', IN_PROGRESS: 'En proceso', PENDING: 'Pendiente',
  RESOLVED: 'Resuelto', CLOSED: 'Cerrado', CANCELLED: 'Cancelado',
};
const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Filtro por rango de fecha de creación. Devuelve condiciones ya parametrizadas.
function dateFilter(req) {
  const conds = [];
  const params = [];
  if (req.query.from && DATE_RE.test(String(req.query.from))) {
    conds.push('t.created_at >= ?');
    params.push(`${req.query.from}T00:00:00.000Z`);
  }
  if (req.query.to && DATE_RE.test(String(req.query.to))) {
    conds.push('t.created_at <= ?');
    params.push(`${req.query.to}T23:59:59.999Z`);
  }
  return { conds, params };
}

function whereFrom(conds) {
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

// Contexto reutilizable: filtro de fecha, WHERE base y combinador de condiciones.
function ctx(req) {
  const df = dateFilter(req);
  return {
    df,
    base: whereFrom(df.conds),
    combine(extra = []) {
      const conds = [...extra, ...df.conds];
      return { sql: whereFrom(conds), params: [...df.params] };
    },
  };
}

function summaryData(req) {
  const { df, base, combine } = ctx(req);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${base}`).get(...df.params).n;

  const wOpen = combine([OPEN_IN]);
  const open = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${wOpen.sql}`).get(...OPEN_STATUSES, ...wOpen.params).n;

  const wUnresolved = combine([OPEN_IN, 't.created_at < ?']);
  const unresolved = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t ${wUnresolved.sql}`)
    .get(...OPEN_STATUSES, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), ...wUnresolved.params).n;

  const wResolved = combine([`t.status IN ('RESOLVED','CLOSED')`]);
  const resolved = db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${wResolved.sql}`).get(...wResolved.params).n;

  const wAvg = combine(['(t.resolved_at IS NOT NULL OR t.closed_at IS NOT NULL)']);
  const avgResolution = db
    .prepare(
      `SELECT AVG((julianday(COALESCE(t.resolved_at, t.closed_at, t.updated_at)) - julianday(t.created_at)) * 24) AS hours
       FROM tickets t ${wAvg.sql}`
    )
    .get(...wAvg.params).hours;

  return {
    total,
    open,
    resolved,
    unresolved_week: unresolved,
    avg_resolution_hours: Math.round((avgResolution || 0) * 10) / 10,
  };
}

function byStatusData(req) {
  const { df, base } = ctx(req);
  return db
    .prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t ${base} GROUP BY t.status ORDER BY n DESC`)
    .all(...df.params);
}

function byPriorityData(req) {
  const { combine } = ctx(req);
  const w = combine([OPEN_IN]);
  return db
    .prepare(`SELECT t.priority, COUNT(*) AS n FROM tickets t ${w.sql} GROUP BY t.priority ORDER BY n DESC`)
    .all(...OPEN_STATUSES, ...w.params);
}

function byCategoryData(req) {
  const { combine } = ctx(req);
  const w = combine(['c.active = 1']);
  return db
    .prepare(
      `SELECT c.name, c.color, COUNT(t.id) AS n,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM categories c
       LEFT JOIN tickets t ON t.category_id = c.id ${w.sql.replace(/^WHERE /, 'AND ')}
       GROUP BY c.id ORDER BY n DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...w.params);
}

function byDepartmentData(req) {
  const { df, base } = ctx(req);
  return db
    .prepare(
      `SELECT COALESCE(d.name, 'Sin departamento') AS name, COUNT(t.id) AS n,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM tickets t
       LEFT JOIN departments d ON d.id = t.department_id ${base}
       GROUP BY d.id ORDER BY n DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...df.params);
}

function byDayData(req) {
  const { combine } = ctx(req);
  const w = combine(['(t.resolved_at IS NOT NULL OR t.closed_at IS NOT NULL)']);
  return db
    .prepare(
      `SELECT date(COALESCE(t.resolved_at, t.closed_at)) AS day, COUNT(*) AS n
       FROM tickets t ${w.sql} GROUP BY day ORDER BY day DESC LIMIT 30`
    )
    .all(...w.params);
}

function byUserData(req) {
  const { combine } = ctx(req);
  const w = combine([]);
  return db
    .prepare(
      `SELECT r.name || ' ' || r.last_name AS reporter, COUNT(*) AS total,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM tickets t JOIN users r ON r.id = t.reporter_id ${w.sql}
       GROUP BY t.reporter_id ORDER BY total DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...w.params);
}

function rangeOf(req) {
  return { from: req.query.from || null, to: req.query.to || null };
}

// Reporte completo (usado por /export y /full). Cada sección se calcula una vez.
function reportData(req) {
  return {
    range: rangeOf(req),
    summary: summaryData(req),
    by_status: byStatusData(req),
    by_priority: byPriorityData(req),
    by_category: byCategoryData(req),
    by_department: byDepartmentData(req),
    by_day: byDayData(req),
    by_user: byUserData(req),
  };
}

router.get('/summary', (req, res) => {
  res.json({ ...summaryData(req), range: rangeOf(req) });
});

router.get('/by-status', (req, res) => {
  res.json({ data: byStatusData(req) });
});

router.get('/by-priority', (req, res) => {
  res.json({ data: byPriorityData(req) });
});

router.get('/by-category', (req, res) => {
  res.json({ data: byCategoryData(req) });
});

router.get('/by-department', (req, res) => {
  res.json({ data: byDepartmentData(req) });
});

router.get('/performance', (req, res) => {
  res.json({ by_day: byDayData(req), by_user: byUserData(req) });
});

// Reporte completo en una sola petición (evita 6 llamadas desde el frontend).
router.get('/full', (req, res) => {
  const r = reportData(req);
  res.json({
    range: r.range,
    summary: r.summary,
    byStatus: r.by_status,
    byPriority: r.by_priority,
    byCategory: r.by_category,
    byDepartment: r.by_department,
    byDay: r.by_day,
    byUser: r.by_user,
  });
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
