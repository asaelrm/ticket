import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId } from '../middleware/org.js';

const router = express.Router();
router.use(requireAuth, requirePermission('report.view'));

// ETAPA 4B: contexto organizacional obligatorio y exclusivamente server-side.
// La organización sale SIEMPRE de currentOrgId(req.user), nunca de query/body/
// headers. Un SUPERADMIN global (organization_id NULL) no obtiene reportes
// globales: NULL se traduce en `1 = 0` para que todos los reportes salgan
// vacíos/ceros, exactamente igual que el Dashboard (ETAPA 4A).
function reportOrgScope(req, alias = 't') {
  const org = currentOrgId(req.user);
  const col = alias ? `${alias}.organization_id` : 'organization_id';
  return {
    org,
    sql: org ? `${col} = ?` : '1 = 0',
    params: org ? [org] : [],
  };
}

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];
const OPEN_IN = `t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
const STATUS_LABEL = {
  OPEN: 'Abierto', ASSIGNED: 'Asignado', IN_PROGRESS: 'En proceso', PENDING: 'Pendiente',
  RESOLVED: 'Resuelto', CLOSED: 'Cerrado', CANCELLED: 'Cancelado',
};
const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };
const EXPORT_SECTIONS = new Set(['summary', 'status', 'priority', 'category', 'department', 'reporters', 'resolved', 'technicians', 'teams', 'csat', 'details']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros compartidos por todas las métricas y el detalle del reporte.
// ETAPA 4B: el scope organizacional es la primera condición SIEMPRE. Se deriva
// de la sesión (reportOrgScope) y es obligatorio: con org -> `t.organization_id
// = ?`; sin org (SUPERADMIN) -> `1 = 0`. Nunca se omite ni se acepta del cliente.
function ticketFilter(req) {
  const conds = [];
  const params = [];
  const scope = reportOrgScope(req);
  conds.push(scope.sql);
  params.push(...scope.params);
  if (req.query.from && DATE_RE.test(String(req.query.from))) {
    conds.push('t.created_at >= ?');
    params.push(`${req.query.from}T00:00:00.000Z`);
  }
  if (req.query.to && DATE_RE.test(String(req.query.to))) {
    conds.push('t.created_at <= ?');
    params.push(`${req.query.to}T23:59:59.999Z`);
  }
  if (Object.hasOwn(STATUS_LABEL, req.query.status)) {
    conds.push('t.status = ?');
    params.push(req.query.status);
  }
  if (Object.hasOwn(PRIORITY_LABEL, req.query.priority)) {
    conds.push('t.priority = ?');
    params.push(req.query.priority);
  }
  for (const [key, column] of [['department', 'department_id'], ['category', 'category_id']]) {
    const value = Number(req.query[key]);
    if (Number.isSafeInteger(value) && value > 0) {
      conds.push(`t.${column} = ?`);
      params.push(value);
    }
  }
  return { conds, params, scope };
}

function whereFrom(conds) {
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

// Contexto reutilizable: filtro de fecha, WHERE base y combinador de condiciones.
function ctx(req) {
  const df = ticketFilter(req);
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
  // ETAPA 4B: el reporte enumera categorías, así que hace falta doble scope.
  // Las categorías visibles (WHERE sobre `c`) pertenecen a la organización
  // actual —una categoría de otra org no aparece ni con n = 0— y los tickets
  // contados (ON del LEFT JOIN) también. El scope del ticket ya llega primero
  // en df.conds (vía ticketFilter); los placeholders del ON aparecen antes que
  // los del WHERE, y por eso df.params precede a categoryScope.params.
  const df = ticketFilter(req);
  const categoryScope = reportOrgScope(req, 'c');
  return db
    .prepare(
      `SELECT c.name, c.color, COUNT(t.id) AS n,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM categories c
       LEFT JOIN tickets t ON t.category_id = c.id AND ${df.conds.join(' AND ')}
       WHERE ${categoryScope.sql} AND c.active = 1
       GROUP BY c.id ORDER BY n DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...df.params, ...categoryScope.params);
}

function byDepartmentData(req) {
  const { df, base } = ctx(req);
  // ETAPA 4B: el JOIN a departamentos se refuerza a la misma org del ticket
  // (`d.organization_id = t.organization_id`), así una referencia legacy
  // cross-org no revela el nombre/id del departamento de otra org: se agrupa
  // bajo 'Sin departamento'. Los tickets ya se acotan con el scope de ticket.
  return db
    .prepare(
      `SELECT COALESCE(d.name, 'Sin departamento') AS name, COUNT(t.id) AS n,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM tickets t
       LEFT JOIN departments d ON d.id = t.department_id AND d.organization_id = t.organization_id ${base}
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
  // ETAPA 4B: LEFT JOIN reforzado a la misma org del ticket. Un reporter
  // legacy cross-org no puede filtrar identidad ajena: su ticket se conserva
  // en el reporte agrupado bajo 'Sin reportero' (no se oculta un ticket de la
  // org por miedo a un JOIN incorrecto).
  return db
    .prepare(
      `SELECT COALESCE(r.name || ' ' || r.last_name, 'Sin reportero') AS reporter, COUNT(*) AS total,
         SUM(CASE WHEN ${OPEN_IN} THEN 1 ELSE 0 END) AS open
       FROM tickets t LEFT JOIN users r ON r.id = t.reporter_id AND r.organization_id = t.organization_id ${w.sql}
       GROUP BY t.reporter_id ORDER BY total DESC LIMIT 10`
    )
    .all(...OPEN_STATUSES, ...w.params);
}

// Instante en que un ticket se dio por terminado y si le vencía el SLA.
const DONE_AT = 'COALESCE(t.resolved_at, t.closed_at)';
// Tickets que un técnico concreto culminationó (resueltos o cerrados por él).
const COMPLETED_BY = '(t.resolved_by = u.id OR t.closed_by = u.id)';
const SLA_COMPUTABLE = `${COMPLETED_BY} AND t.sla_due_at IS NOT NULL AND ${DONE_AT} IS NOT NULL`;

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Cumplimiento de SLA en porcentaje sobre los tickets con SLA verificable.
// Si no hay ninguno comparable devuelve null: un 0% ahí sería mentira, no un dato.
function slaResult(total, within) {
  return {
    sla_comparable: total,
    sla_within: within,
    sla_breached: total - within,
    sla_pct: total ? Math.round((within / total) * 1000) / 10 : null,
  };
}

// --- Satisfacción (CSAT) --------------------------------------------------
// Un 0 de media o un 0% de respuesta no es lo mismo que "no hay datos":
// sin respuestas la media y la tasa se devuelven como null.

function csatData(req) {
  const { df, base, combine } = ctx(req);

  const totals = db
    .prepare(
      `SELECT COUNT(t.csat_rating) AS responses,
              AVG(t.csat_rating) AS average,
              SUM(CASE WHEN t.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS eligible
       FROM tickets t ${base}`
    )
    .get(...df.params);

  const responses = totals.responses || 0;
  const eligible = totals.eligible || 0;

  const wAnswered = combine(['t.csat_rating IS NOT NULL']);
  const counts = db
    .prepare(`SELECT t.csat_rating AS rating, COUNT(*) AS n FROM tickets t ${wAnswered.sql} GROUP BY t.csat_rating`)
    .all(...wAnswered.params);
  const byRating = new Map(counts.map((c) => [c.rating, c.n]));

  return {
    responses,
    eligible,
    // Denominador cero = tasa desconocida, no tasa cero.
    response_rate: eligible ? Math.round((responses / eligible) * 1000) / 10 : null,
    average: totals.average == null ? null : round2(totals.average),
    has_data: responses > 0,
    distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, n: byRating.get(rating) || 0 })),
    by_technician: csatBy(req, 'users u ON u.id = t.resolved_by AND u.organization_id = t.organization_id', {
      label: "COALESCE(u.name || ' ' || u.last_name, 'Sin técnico')",
      group: 't.resolved_by',
    }),
    by_department: csatBy(req, 'departments d ON d.id = t.department_id AND d.organization_id = t.organization_id', {
      label: "COALESCE(d.name, 'Sin departamento')",
      group: 'd.id',
    }),
    by_category: csatBy(req, 'categories c ON c.id = t.category_id AND c.organization_id = t.organization_id', {
      label: "COALESCE(c.name, 'Sin categoría')",
      group: 'c.id',
    }),
    by_month: csatByMonth(req),
  };
}

// Promedio y número de respuestas de la misma tabla para cada desglose.
// ETAPA 4B: el JOIN que recibe ya está reforzado a la misma org del ticket
// (ver llamadas en csatData), de modo que una identidad legacy cross-org cae
// en el bucket COALESCE 'Sin...' sin filtrar nombre/id ajeno y sin mezclar
// encuestas de otra organización (los tickets ya van acotados por ticketFilter).
function csatBy(req, join, { label, group }) {
  const { combine } = ctx(req);
  const w = combine(['t.csat_rating IS NOT NULL']);
  return db
    .prepare(
      `SELECT ${label} AS label, COUNT(*) AS responses, AVG(t.csat_rating) AS average
       FROM tickets t LEFT JOIN ${join} ${w.sql}
       GROUP BY ${group} HAVING responses > 0
       ORDER BY responses DESC, average DESC`
    )
    .all(...w.params)
    .map((r) => ({ ...r, average: round2(r.average) }));
}

// La evolución se agrupa por la fecha en que se respondió, no por la de
// creación del ticket: es cuando existe la medición.
function csatByMonth(req) {
  const { combine } = ctx(req);
  const w = combine(['t.csat_rating IS NOT NULL']);
  return db
    .prepare(
      `SELECT substr(COALESCE(t.csat_answered_at, t.updated_at), 1, 7) AS month,
              COUNT(*) AS responses, AVG(t.csat_rating) AS average
       FROM tickets t ${w.sql}
       GROUP BY month ORDER BY month ASC`
    )
    .all(...w.params)
    .map((r) => ({ ...r, average: round2(r.average) }));
}

// --- Rendimiento por técnico y por equipo ---------------------------------

// ETAPA 4B: el JOIN a usuarios valida en CADA brazo la organización del ticket
// (user.organization_id = ticket.organization_id). La semántica del reporte
// exige un técnico válido para atribuir métricas: un ticket con referencia
// legacy cross-org no genera fila ajena ni métricas atribuidas a otra org. El
// ticket no se pierde: sigue en /summary, /full y el detalle (misma decisión
// que /by-technician en ETAPA 4A: la asignación inválida se trata como sin
// dueño allí y queda fuera de la atribución aquí).
function technicianData(req) {
  const { combine } = ctx(req);
  const w = combine([]);
  const rows = db
    .prepare(
      `SELECT u.id, u.name || ' ' || u.last_name AS technician,
         SUM(CASE WHEN t.assigned_to_id = u.id THEN 1 ELSE 0 END) AS assigned,
         SUM(CASE WHEN t.assigned_to_id = u.id AND ${OPEN_IN} THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN t.resolved_by = u.id THEN 1 ELSE 0 END) AS resolved,
         SUM(CASE WHEN t.closed_by = u.id THEN 1 ELSE 0 END) AS closed,
         COALESCE(SUM(CASE WHEN t.resolved_by = u.id THEN t.time_spent_minutes ELSE 0 END), 0) AS total_time_minutes,
         AVG(CASE WHEN t.resolved_by = u.id THEN t.time_spent_minutes END) AS avg_time_minutes,
         AVG(CASE WHEN t.resolved_by = u.id AND t.resolved_at IS NOT NULL
             THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) AS avg_resolution_hours,
         SUM(CASE WHEN ${SLA_COMPUTABLE} THEN 1 ELSE 0 END) AS sla_comparable,
         SUM(CASE WHEN ${SLA_COMPUTABLE} AND ${DONE_AT} <= t.sla_due_at THEN 1 ELSE 0 END) AS sla_within
       FROM tickets t
       JOIN users u ON (u.id = t.assigned_to_id AND u.organization_id = t.organization_id)
                    OR (u.id = t.resolved_by AND u.organization_id = t.organization_id)
                    OR (u.id = t.closed_by AND u.organization_id = t.organization_id)
       ${w.sql}
       GROUP BY u.id
       ORDER BY resolved DESC, closed DESC, assigned DESC`
    )
    .all(...OPEN_STATUSES, ...w.params);

  return rows.map((r) => ({
    ...r,
    avg_time_minutes: round1(r.avg_time_minutes),
    avg_resolution_hours: round1(r.avg_resolution_hours),
    ...slaResult(r.sla_comparable, r.sla_within),
  }));
}

// Un ticket solo conserva el equipo que tiene ahora: no hay histórico de a qué
// equipo pertenecía cuando se resolvió. 'assigned' y 'open' sí son fiables;
// lo completado se atribuye al equipo actual y así se declara en la respuesta.
const TEAM_BASIS = 'current_assignment';

function teamData(req) {
  const { combine } = ctx(req);
  const w = combine(['t.assigned_team_id IS NOT NULL']);
  const rows = db
    .prepare(
      `SELECT tm.id, tm.name AS team,
         SUM(CASE WHEN t.assigned_team_id = tm.id THEN 1 ELSE 0 END) AS assigned,
         SUM(CASE WHEN t.assigned_team_id = tm.id AND ${OPEN_IN} THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN ${DONE_AT} IS NOT NULL THEN 1 ELSE 0 END) AS completed,
         AVG(CASE WHEN t.resolved_at IS NOT NULL
             THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) AS avg_resolution_hours,
         SUM(CASE WHEN t.sla_due_at IS NOT NULL AND ${DONE_AT} IS NOT NULL THEN 1 ELSE 0 END) AS sla_comparable,
         SUM(CASE WHEN t.sla_due_at IS NOT NULL AND ${DONE_AT} IS NOT NULL AND ${DONE_AT} <= t.sla_due_at THEN 1 ELSE 0 END) AS sla_within
       FROM tickets t JOIN teams tm ON tm.id = t.assigned_team_id AND tm.organization_id = t.organization_id
       ${w.sql}
       GROUP BY tm.id
       ORDER BY open DESC, completed DESC`
    )
    .all(...OPEN_STATUSES, ...w.params);

  return {
    basis: TEAM_BASIS,
    note: 'Los tickets completados se atribuyen al equipo asignado actualmente; el modelo no guarda el equipo que los resolvió en su momento.',
    data: rows.map((r) => ({
      ...r,
      avg_resolution_hours: round1(r.avg_resolution_hours),
      ...slaResult(r.sla_comparable, r.sla_within),
    })),
  };
}

function ticketDetailsData(req) {
  // ETAPA 4B: detalle CRÍTICO (/full y /export). Todos los JOIN de identidad
  // (reporter, asignado, departamento, categoría) se refuerzan a la misma org
  // del ticket con LEFT JOIN: una identidad legacy cross-org aparece con la
  // etiqueta segura ('Sin reportero'/'Sin asignar'/'Sin...') y el ticket se
  // conserva — nunca se cae una fila legítima de A por esconder un JOIN.
  const { df, base } = ctx(req);
  return db.prepare(`
    SELECT t.ticket_number, t.title, t.status, t.priority, t.created_at, t.resolved_at, t.closed_at,
           COALESCE(d.name, 'Sin departamento') AS department,
           COALESCE(c.name, 'Sin categoría') AS category,
           COALESCE(r.name || ' ' || r.last_name, 'Sin reportero') AS reporter,
           COALESCE(a.name || ' ' || a.last_name, 'Sin asignar') AS assigned_to
    FROM tickets t
    LEFT JOIN users r ON r.id = t.reporter_id AND r.organization_id = t.organization_id
    LEFT JOIN users a ON a.id = t.assigned_to_id AND a.organization_id = t.organization_id
    LEFT JOIN departments d ON d.id = t.department_id AND d.organization_id = t.organization_id
    LEFT JOIN categories c ON c.id = t.category_id AND c.organization_id = t.organization_id
    ${base}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 500
  `).all(...df.params);
}

function rangeOf(req) {
  return {
    from: req.query.from || null,
    to: req.query.to || null,
    status: Object.hasOwn(STATUS_LABEL, req.query.status) ? req.query.status : null,
    priority: Object.hasOwn(PRIORITY_LABEL, req.query.priority) ? req.query.priority : null,
    department: Number.isSafeInteger(Number(req.query.department)) ? Number(req.query.department) : null,
    category: Number.isSafeInteger(Number(req.query.category)) ? Number(req.query.category) : null,
  };
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
    by_technician: technicianData(req),
    by_team: teamData(req),
    csat: csatData(req),
    details: ticketDetailsData(req),
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
  res.json({
    by_day: byDayData(req),
    by_user: byUserData(req),
    by_technician: technicianData(req),
    by_team: teamData(req),
  });
});

router.get('/csat', (req, res) => {
  res.json(csatData(req));
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
    byTechnician: r.by_technician,
    byTeam: r.by_team,
    csat: r.csat,
    details: r.details,
  });
});

// Exporta el reporte completo como CSV organizado por secciones (Excel/ES con ';').
router.get('/export', (req, res) => {
  const r = reportData(req);
  const requested = String(req.query.sections || '').split(',').filter((section) => EXPORT_SECTIONS.has(section));
  const sections = new Set(requested.length ? requested : EXPORT_SECTIONS);
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

  if (sections.has('summary')) {
    lines.push(row('RESUMEN'));
    lines.push(row('Métrica', 'Valor'));
    lines.push(row('Total de tickets', r.summary.total));
    lines.push(row('Tickets abiertos', r.summary.open));
    lines.push(row('Resueltos + cerrados', r.summary.resolved));
    lines.push(row('Sin resolver > 7 días', r.summary.unresolved_week));
    lines.push(row('Tiempo medio de resolución', r.summary.avg_resolution_hours >= 24 ? `${(r.summary.avg_resolution_hours / 24).toFixed(1)} días` : `${r.summary.avg_resolution_hours} h`));
    lines.push('');
  }
  if (sections.has('status')) {
    lines.push(row('TICKETS POR ESTADO'), row('Estado', 'Cantidad'), ...r.by_status.map((d) => row(STATUS_LABEL[d.status] || d.status, d.n)), '');
  }
  if (sections.has('priority')) {
    lines.push(row('TICKETS ABIERTOS POR PRIORIDAD'), row('Prioridad', 'Cantidad'), ...r.by_priority.map((d) => row(PRIORITY_LABEL[d.priority] || d.priority, d.n)), '');
  }
  if (sections.has('category')) {
    lines.push(row('TICKETS POR CATEGORÍA'), row('Categoría', 'Total', 'Abiertos'), ...r.by_category.map((d) => row(d.name, d.n, d.open)), '');
  }
  if (sections.has('department')) {
    lines.push(row('TICKETS POR DEPARTAMENTO'), row('Departamento', 'Total', 'Abiertos'), ...r.by_department.map((d) => row(d.name, d.n, d.open)), '');
  }
  if (sections.has('reporters')) {
    lines.push(row('TOP REPORTEROS'), row('Empleado', 'Total', 'Abiertos'), ...r.by_user.map((u) => row(u.reporter, u.total, u.open)), '');
  }
  if (sections.has('resolved')) {
    lines.push(row('RESUELTOS POR DÍA (últimos 30)'), row('Día', 'Cantidad'), ...r.by_day.map((d) => row(d.day, d.n)), '');
  }
  if (sections.has('technicians')) {
    lines.push(
      row('RENDIMIENTO POR TÉCNICO'),
      row('Técnico', 'Asignados', 'Abiertos', 'Resueltos', 'Cerrados', 'Tiempo total (min)', 'Tiempo medio (min)', 'Resolución media (h)', 'Incumpl. SLA', 'Cumplimiento SLA %')
    );
    for (const t of r.by_technician) {
      lines.push(row(t.technician, t.assigned, t.open, t.resolved, t.closed, t.total_time_minutes, t.avg_time_minutes ?? '', t.avg_resolution_hours ?? '', t.sla_breached, t.sla_pct ?? ''));
    }
    lines.push('');
  }
  if (sections.has('teams')) {
    lines.push(row('RENDIMIENTO POR EQUIPO'), row(r.by_team.note), row('Equipo', 'Asignados', 'Abiertos', 'Completados', 'Resolución media (h)', 'Incumpl. SLA', 'Cumplimiento SLA %'));
    for (const t of r.by_team.data) {
      lines.push(row(t.team, t.assigned, t.open, t.completed, t.avg_resolution_hours ?? '', t.sla_breached, t.sla_pct ?? ''));
    }
    lines.push('');
  }
  if (sections.has('csat')) {
    lines.push(row('SATISFACCIÓN (CSAT)'));
    lines.push(row('Respuestas recibidas', r.csat.responses));
    lines.push(row('Tickets resueltos/cerrados (base de la tasa)', r.csat.eligible));
    lines.push(row('Tasa de respuesta', r.csat.response_rate == null ? 'Sin base comparable' : `${r.csat.response_rate}%`));
    lines.push(row('Valoración media', r.csat.average == null ? 'Sin respuestas' : r.csat.average));
    lines.push(row('Distribución', ...r.csat.distribution.map((d) => `${d.rating}★: ${d.n}`)));
    lines.push(row('Evolución mensual', ...r.csat.by_month.map((m) => `${m.month}: ${m.average ?? 's/d'} (${m.responses})`)));
    for (const [title, key] of [['CSAT POR TÉCNICO', 'by_technician'], ['CSAT POR DEPARTAMENTO', 'by_department'], ['CSAT POR CATEGORÍA', 'by_category']]) {
      lines.push(row(title), row('Filtro', 'Respuestas', 'Media'));
      for (const item of r.csat[key]) lines.push(row(item.label, item.responses, item.average));
    }
    lines.push('');
  }
  if (sections.has('details')) {
    lines.push(row('DETALLE DE TICKETS'), row('Ticket', 'Título', 'Estado', 'Prioridad', 'Reportero', 'Asignado a', 'Departamento', 'Categoría', 'Creado', 'Resuelto/cerrado'));
    for (const ticket of r.details) lines.push(row(ticket.ticket_number, ticket.title, STATUS_LABEL[ticket.status] || ticket.status, PRIORITY_LABEL[ticket.priority] || ticket.priority, ticket.reporter, ticket.assigned_to, ticket.department, ticket.category, ticket.created_at, ticket.resolved_at || ticket.closed_at || ''));
  }

  const suffix = r.range.from || r.range.to ? `${r.range.from || 'inicio'}_${r.range.to || 'hoy'}` : 'completo';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="reporte-tickets-${suffix}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

export default router;
