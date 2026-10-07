import express from 'express';
import db from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId } from '../middleware/org.js';
import { slaAtRiskUntilIso } from '../utils/sla.js';

const router = express.Router();
router.use(requireAuth, requirePermission('dashboard.view'));

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

// ETAPA 4A (aislamiento multiempresa del Dashboard): el contexto de
// organización sale SIEMPRE de la sesión autenticada (currentOrgId); el
// cliente no puede aportarlo (body/query/headers se ignoran). Con organización
// la consulta queda restringida con `alias.organization_id = ?`; sin
// organización (SUPERADMIN global, organization_id NULL) se usa `1 = 0`:
// ninguno de estos endpoints es administración global, así que NULL nunca
// significa "todas las organizaciones".
function dashboardScope(req, alias = 't') {
  const org = currentOrgId(req.user);
  const col = alias ? `${alias}.organization_id` : 'organization_id';
  return {
    org,
    sql: org ? `${col} = ?` : '1 = 0',
    params: org ? [org] : [],
  };
}

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
  // ETAPA 4A: todos los totales cuentan solo los tickets de la organización de
  // la sesión. Un SUPERADMIN global (org NULL) obtiene ceros: no hay un
  // dashboard global accidental.
  const scope = dashboardScope(req);
  const counts = { OPEN: 0, ASSIGNED: 0, IN_PROGRESS: 0, PENDING: 0, RESOLVED: 0, CLOSED: 0, CANCELLED: 0 };
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM tickets t WHERE ${scope.sql} GROUP BY status`).all(...scope.params);
  for (const row of byStatus) counts[row.status] = row.n;

  const openTotal = OPEN_STATUSES.reduce((a, s) => a + counts[s], 0);
  const critical = db.prepare(
    `SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND priority = 'CRITICAL'`
  ).get(...scope.params, ...OPEN_STATUSES).n;

  const year = new Date().getUTCFullYear();
  const month = String(new Date().getUTCMonth() + 1).padStart(2, '0');
  const createdMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND strftime('%Y-%m', created_at) = ?`).get(...scope.params, `${year}-${month}`).n;
  const resolvedMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND status = 'RESOLVED' AND strftime('%Y-%m', resolved_at) = ?`).get(...scope.params, `${year}-${month}`).n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql}`).get(...scope.params).n;

  res.json({ counts, openTotal, critical, createdMonth, resolvedMonth, total });
});

router.get('/by-status', (req, res) => {
  const scope = dashboardScope(req);
  res.json({ data: db.prepare(`SELECT status, COUNT(*) AS n FROM tickets t WHERE ${scope.sql} GROUP BY status ORDER BY n DESC`).all(...scope.params) });
});

// Estado SLA de los turnos/tickets abiertos: vencidos, próximos a vencer y dentro de plazo.
router.get('/sla', (req, res) => {
  // ETAPA 4A: los conteos SLA y el listado solo cubren tickets de la
  // organización de la sesión. El JOIN de reporter se refuerza a la misma org
  // para neutralizar referencias legacy cross-org.
  const scope = dashboardScope(req);
  const nowIso = new Date().toISOString();
  const in24Iso = slaAtRiskUntilIso();
  const ph = OPEN_STATUSES.map(() => '?').join(',');
  const inClause = `status IN (${ph}) AND sla_due_at IS NOT NULL`;
  const overdue = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND ${inClause} AND sla_due_at < ?`)
    .get(...scope.params, ...OPEN_STATUSES, nowIso).n;
  const atRisk = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND ${inClause} AND sla_due_at >= ? AND sla_due_at < ?`)
    .get(...scope.params, ...OPEN_STATUSES, nowIso, in24Iso).n;
  const healthy = db
    .prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND ${inClause} AND sla_due_at >= ?`)
    .get(...scope.params, ...OPEN_STATUSES, in24Iso).n;
  const top = db
    .prepare(
      `SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.sla_due_at,
              (t.sla_due_at < ?) AS is_overdue,
              r.name || ' ' || r.last_name AS reporter_name
       FROM tickets t
       LEFT JOIN users r ON r.id = t.reporter_id AND r.organization_id = t.organization_id
       WHERE ${scope.sql} AND ${inClause}
       ORDER BY is_overdue DESC, t.sla_due_at ASC
       LIMIT 6`
    )
    .all(nowIso, ...scope.params, ...OPEN_STATUSES);
  res.json({ overdue, atRisk, healthy, top });
});

router.get('/by-priority', (req, res) => {
  const scope = dashboardScope(req);
  const data = db.prepare(
    `SELECT priority, COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) GROUP BY priority ORDER BY n DESC`
  ).all(...scope.params, ...OPEN_STATUSES);
  const open = data.reduce((a, b) => a + b.n, 0);
  res.json({ data, open });
});

// `id` viaja en la respuesta porque el panel navega al listado ya filtrado con
// `?category=<id>`: sin él la fila no tendría a qué enlace apuntar y el nombre
// no sería un destino válido. Es el mismo parámetro que ya acepta
// buildConditions en tickets.js, así que no hace falta ningún endpoint nuevo.
//
// `n` cuenta TODOS los tickets de la categoría y `open` solo los no terminales.
// La UI usa `open` para decidir qué paneles merece la pena enseñar y qué filas
// son navegables.
//
// Ya no hay LIMIT: el panel deja ocultas por defecto las categorías sin
// tickets abiertos y ofrece un "Ver todas", así que recortar el conjunto
// dejaría esas filas inalcanzables y el interruptor mentiría. El orden por `n`
// mantiene arriba lo que pesa y el desempate por nombre da una lista estable.
router.get('/by-category', (req, res) => {
  // ETAPA 4A: la categoría debe pertenecer a la organización del actor y los
  // tickets agregados también. El scope del ticket va en el ON del LEFT JOIN
  // para conservar las categorías propias sin tickets (n = 0) sin traer ni
  // nombres ni contadores de otras organizaciones.
  const ticketScope = dashboardScope(req, 't');
  const categoryScope = dashboardScope(req, 'c');
  const data = db.prepare(`
    SELECT c.id, c.name, c.color, COUNT(t.id) AS n,
      SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
    FROM categories c
    LEFT JOIN tickets t ON t.category_id = c.id AND ${ticketScope.sql}
    WHERE c.active = 1 AND ${categoryScope.sql}
    GROUP BY c.id ORDER BY n DESC, c.name ASC
  `).all(...OPEN_STATUSES, ...ticketScope.params, ...categoryScope.params);
  res.json({ data });
});

// Mismo criterio y mismo `id` navegable que /by-category, con el filtro
// `department` de buildConditions. Los departamentos no tienen columna `active`
// en este esquema, así que no se filtra por ella.
router.get('/by-department', (req, res) => {
  const ticketScope = dashboardScope(req, 't');
  const departmentScope = dashboardScope(req, 'd');
  const data = db.prepare(`
    SELECT d.id, d.name, COUNT(t.id) AS n,
      SUM(CASE WHEN t.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS open
    FROM departments d
    LEFT JOIN tickets t ON t.department_id = d.id AND ${ticketScope.sql}
    WHERE ${departmentScope.sql}
    GROUP BY d.id ORDER BY n DESC, d.name ASC
  `).all(...OPEN_STATUSES, ...ticketScope.params, ...departmentScope.params);
  res.json({ data });
});

// Reparto de la carga entre los técnicos.
//
// La carga se decide por la PROPIEDAD (assigned_to_id), no por el estado: un
// ticket pertenece a su técnico desde el momento en que se le asigna, y el
// estado es solo su avance dentro del trabajo. Los dos pueden divergir de forma
// real: "Asignarme" en Inbox/Tickets y la asignación masiva envían PATCH con
// solo assigned_to_id, y el PATCH de tickets.js NO mueve el status, así que
// queda `OPEN` con dueño. Si esta sección se filtrara por la lista
// ASSIGNED/IN_PROGRESS/PENDING, esos tickets no aparecerían en ninguna fila ni
// en `unassigned`: la sección informaría de menos tickets abiertos de los que
// el resumen declara, que es la contradicción que se vio en DEV.
//
// Por eso se cuentan todos los estados no terminales CON dueño, y `unassigned`
// son los no terminales SIN dueño. La suma de ambos tiene que dar exactamente
// el `openTotal` de /summary; lo fija la prueba 'no deja ningún ticket abierto
// fuera de la sección'.
//
// Un ticket asignado a un EQUIPO (assigned_team_id) cuenta como sin dueño: un
// equipo no es un técnico y no tiene fila propia. tickets.js:506 lo excluye de
// su contador `unassigned`, pero allí convive con el listado por equipo; aquí
// excluirlo volvería a hacer desaparecer tickets de esta sección.
//
// Se agrupa por `assigned_to_id` y no por rol para no dejar fuera a quien lleva
// la carga aunque su rol no sea TECHNICIAN (p. ej. un administrador de apoyo).
router.get('/by-technician', (req, res) => {
  // ETAPA 4A: solo tickets de la organización de la sesión (listado, totales y
  // "unassigned"). El JOIN a users se refuerza a la misma organización del
  // ticket para no dejar ver técnicos con referencias legacy cross-org.
  //
  // ETAPA 4A (corrección): la misma validación se aplica a los totales y a
  // "unassigned". Una asignación legacy cross-org no es un técnico válido: no
  // suma a technicians/active/overdue (totales) ni crea fila, y se trata como
  // NO asignado para que la sección no pierda tickets. Decisión documentada en
  // el comentario de `totals` y coherente con /needs-attention.
  const scope = dashboardScope(req);
  const nowIso = new Date().toISOString();
  const openPh = OPEN_STATUSES.map(() => '?').join(',');

  const data = db
    .prepare(
      `SELECT u.id,
              u.name,
              u.last_name,
              u.position,
              u.name || ' ' || u.last_name AS technician,
              COUNT(*) AS active,
              SUM(CASE WHEN t.status = 'OPEN' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN t.status = 'ASSIGNED' THEN 1 ELSE 0 END) AS assigned,
              SUM(CASE WHEN t.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN t.status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM tickets t
       JOIN users u ON u.id = t.assigned_to_id AND u.organization_id = t.organization_id
       WHERE ${scope.sql} AND t.status IN (${openPh})
       GROUP BY u.id
       ORDER BY active DESC, overdue DESC, technician ASC
       LIMIT 10`
    )
    .all(nowIso, ...scope.params, ...OPEN_STATUSES);

  // Los totales se calculan sobre TODOS los técnicos con carga y no solo sobre las
  // diez filas devueltas, para que el resumen de la cabecera no dependa del corte.
  //
  // ETAPA 4A (corrección): los totales aplican la MISMA validación de organización
  // que el listado (JOIN a users por la misma org del ticket). Un técnico solo es
  // válido si user.organization_id = ticket.organization_id, así que una asignación
  // legacy cross-org NO cuenta como técnico ni como carga suya.
  //
  // Coherencia con `unassigned`: la asignación cross-org se considera inválida y
  // se trata como NO asignado (u.id IS NULL tras el LEFT JOIN validado). Así cada
  // ticket abierto queda en la fila de un técnico válido o en "sin dueño", y
  // `totals.active + unassigned` sigue igualando el openTotal de /summary.
  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) AS technicians,
              COUNT(*) AS active,
              COALESCE(SUM(CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_due_at < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM tickets t
       JOIN users u ON u.id = t.assigned_to_id AND u.organization_id = t.organization_id
       WHERE ${scope.sql} AND t.status IN (${openPh})`
    )
    .get(nowIso, ...scope.params, ...OPEN_STATUSES);

  const unassigned = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_id AND u.organization_id = t.organization_id
       WHERE ${scope.sql} AND t.status IN (${openPh}) AND u.id IS NULL`
    )
    .get(...scope.params, ...OPEN_STATUSES).n;

  res.json({ data, unassigned, totals });
});

// Tickets que requieren intervención, para poder triarlos de un vistazo.
//
// Es una lista de triaje, no un tablero: cada ticket sale UNA sola vez con
// TODOS sus motivos en `reasons`. Para garantizarlo sin depender de que dos
// consultas casen entre sí, los cuatro indicadores se calculan una única vez
// en un CTE y tanto el filtro como el orden leen las MISMAS columnas. Un
// `UNION` de cuatro SELECT también evitaría duplicados, pero obligaría a
// repetir —y a mantener sincronizadas— las cuatro condiciones.
//
// Los estados son los mismos OPEN_STATUSES que ya usan /summary, /sla y
// /by-technician, para que la sección no contradiga al resto del dashboard. Los
// terminales (RESOLVED, CLOSED, CANCELLED) quedan fuera aunque en su día tuvieran
// prioridad crítica o un SLA vencido: ya no admiten intervención desde aquí.
//
// "Sin técnico" se decide por assigned_to_id y NUNCA por el estado: un ticket
// puede estar OPEN y tener dueño, porque "Asignarme" en Inbox/Tickets envía solo
// assigned_to_id y el PATCH de tickets.js no mueve el status (es el mismo caso
// que motivó la sección /by-technician). Un assigned_team_id tampoco cuenta como
// dueño: un equipo no es una persona. El criterio es el mismo que ya fijó
// 'Carga por técnico'.
//
// El orden de ATTENTION_REASONS ES el orden de gravedad que devuelven `reasons`,
// y la UI usa reasons[0] como el motivo dominante. Los niveles numéricos de
// urgencia viven solo en el ORDER BY de SQL (MIN(CASE...)); no se duplican aquí
// para que ambas cosas no puedan discrepar.
const ATTENTION_REASONS = [
  { key: 'SLA_OVERDUE', flag: 'is_overdue' },
  { key: 'CRITICAL', flag: 'is_critical' },
  { key: 'SLA_DUE_SOON', flag: 'is_due_soon' },
  { key: 'UNASSIGNED', flag: 'is_unassigned' },
];

// Los indicadores se calculan una vez y se reutilizan tal cual en el listado y
// en los totales, de modo que el resumen nunca puede discrepar de las filas.
// ETAPA 4A: el CTE recibe la condición de organización para que ni el listado
// ni los totales puedan incluir tickets de otras organizaciones.
//
// ETAPA 4A (corrección): la identidad del asignado se deriva del JOIN validado
// (misma org), nunca del FK crudo. Una asignación legacy cross-org se considera
// inválida: `assigned_to_id` y `technician_name` salen NULL y el ticket cuenta
// como sin dueño, sin ocultar el ticket (que pertenece legítimamente a la org).
function attentionFlaggedSql(openPh, ticketCond) {
  return `WITH flagged AS (
    SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.sla_due_at,
           u.id AS assigned_to_id, t.created_at, t.category_id, t.organization_id,
           (t.sla_due_at IS NOT NULL AND t.sla_due_at < ?) AS is_overdue,
           (t.priority = 'CRITICAL') AS is_critical,
           (t.sla_due_at IS NOT NULL AND t.sla_due_at >= ? AND t.sla_due_at < ?) AS is_due_soon,
           (u.id IS NULL) AS is_unassigned
    FROM tickets t
    LEFT JOIN users u ON u.id = t.assigned_to_id AND u.organization_id = t.organization_id
    WHERE ${ticketCond} AND t.status IN (${openPh})
  )`;
}

// Un ticket entra si cumple AL MENOS una condición. Es el mismo conjunto que
// devuelve /needs-attention, sin el corte de presentación.
const ATTENTION_FILTER =
  'WHERE is_overdue OR is_critical OR is_due_soon OR is_unassigned';

router.get('/needs-attention', (req, res) => {
  // ETAPA 4A: el CTE está acotado a la organización de la sesión, así que ni el
  // listado ni los totales pueden revelar tickets concretos de otra org. Los
  // JOIN de usuario/categoría se refuerzan a la misma org del ticket.
  const scope = dashboardScope(req);
  const flaggedSql = attentionFlaggedSql(OPEN_STATUSES.map(() => '?').join(','), scope.sql);
  const now = new Date().toISOString();
  const in24 = slaAtRiskUntilIso();

  // El corte es un tope de presentación, no un filtro de negocio: los totales
  // se calculan sobre TODOS los tickets que cumplen, no sobre las filas
  // devueltas, igual que /by-technician separa `data` de `totals`.
  const parsed = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 8;

  // `urgency` es el nivel del motivo MÁS GRAVE que cumple el ticket, y ordena
  // de más a menos urgente. Los desempates son deterministas: primero el SLA
  // (los NULL al final, para que un ticket sin plazo no empuje a los demás),
  // luego la antigüedad y por último el id, para que dos llamadas seguidas con
  // el mismo reloj devuelvan exactamente la misma lista.
  const rows = db
    .prepare(
      `${flaggedSql}
       SELECT f.id, f.ticket_number, f.title, f.status, f.priority, f.sla_due_at,
              f.assigned_to_id, f.created_at,
              f.is_overdue, f.is_critical, f.is_due_soon, f.is_unassigned,
              MIN(
                CASE WHEN f.is_overdue    THEN 0 ELSE 9 END,
                CASE WHEN f.is_critical   THEN 1 ELSE 9 END,
                CASE WHEN f.is_due_soon   THEN 2 ELSE 9 END,
                CASE WHEN f.is_unassigned THEN 3 ELSE 9 END
              ) AS urgency,
              u.name || ' ' || u.last_name AS technician_name,
              c.name AS category_name
       FROM flagged f
       LEFT JOIN users u ON u.id = f.assigned_to_id AND u.organization_id = f.organization_id
       LEFT JOIN categories c ON c.id = f.category_id AND c.organization_id = f.organization_id
       ${ATTENTION_FILTER}
       ORDER BY urgency ASC,
                CASE WHEN f.sla_due_at IS NULL THEN 1 ELSE 0 END ASC,
                f.sla_due_at ASC,
                f.created_at ASC,
                f.id ASC
       LIMIT ?`
    )
    .all(now, now, in24, ...scope.params, ...OPEN_STATUSES, limit);

  const data = rows.map((r) => ({
    id: r.id,
    ticket_number: r.ticket_number,
    title: r.title,
    status: r.status,
    priority: r.priority,
    sla_due_at: r.sla_due_at,
    assigned_to_id: r.assigned_to_id,
    technician_name: r.technician_name,
    category_name: r.category_name,
    created_at: r.created_at,
    urgency: r.urgency,
    // En el orden de ATTENTION_REASONS, que ya es el de mayor a menor gravedad.
    reasons: ATTENTION_REASONS.filter((x) => r[x.flag]).map((x) => x.key),
  }));

  // Los contadores son de TICKETS, no de motivos: un ticket vencido y crítico
  // suma en los dos. Por eso `total` puede ser menor que su suma, y la UI no
  // debe intentar cuadrarlos.
  const totals = db
    .prepare(
      `${flaggedSql}
       SELECT COUNT(*) AS total,
              COALESCE(SUM(is_overdue), 0) AS overdue,
              COALESCE(SUM(is_critical), 0) AS critical,
              COALESCE(SUM(is_due_soon), 0) AS dueSoon,
              COALESCE(SUM(is_unassigned), 0) AS unassigned
       FROM flagged
       ${ATTENTION_FILTER}`
    )
    .get(now, now, in24, ...scope.params, ...OPEN_STATUSES);

  res.json({ data, totals });
});

router.get('/trend', (req, res) => {
  // ETAPA 4A: todas las ventanas (día/semana/mes) cuentan solo tickets de la
  // organización de la sesión. Un SUPERADMIN global obtiene la estructura con
  // ceros, coherente con el resto del Dashboard.
  const scope = dashboardScope(req);
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  const data = [];
  const countCreatedDay = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND date(created_at) = ?`);
  const countResolvedDay = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND date(resolved_at) = ?`);
  const countCreatedMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND strftime('%Y-%m', created_at) = ?`);
  const countResolvedMonth = db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND strftime('%Y-%m', resolved_at) = ?`);

  if (range === 'day') {
    for (let i = 13; i >= 0; i--) {
      const label = isoDate(-i);
      data.push({
        label,
        created: countCreatedDay.get(...scope.params, label).n,
        resolved: countResolvedDay.get(...scope.params, label).n,
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
        created: db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND created_at >= ? AND created_at < ?`).get(...scope.params, start, end.toISOString()).n,
        resolved: db.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${scope.sql} AND resolved_at >= ? AND resolved_at < ?`).get(...scope.params, start, end.toISOString()).n,
      });
    }
  } else {
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      data.push({
        label,
        created: countCreatedMonth.get(...scope.params, label).n,
        resolved: countResolvedMonth.get(...scope.params, label).n,
      });
    }
  }

  res.json({ data });
});

// Últimos tickets creados, para abrir su ficha desde el panel.
//
// `t.id` es imprescindible: la tabla usa `/app/tickets/<id>` como destino del
// enlace de cada fila y, sin él, cada "Tickets recientes" llevaba a
// `/app/tickets/undefined`. Se añade al SELECT de este endpoint ya existente en
// lugar de crear otro, porque es el mismo dato y la misma consulta.
//
// `assigned_name` llega con un LEFT JOIN a users por `assigned_to_id` —el
// mismo criterio de dueño que usa /by-technician, no el estado— para que la fila
// muestre a quién se le asignó sin que la UI tenga que pedir un ticket por
// persona. Son dos uniones en una consulta: no hay N+1 ni llamadas extra.
router.get('/recent', (req, res) => {
  // ETAPA 4A: endpoint sensible que devuelve tickets concretos. Solo tickets de
  // la organización de la sesión, y los JOIN a reporter/categoría/asignado se
  // refuerzan a la misma org del ticket para neutralizar referencias legacy
  // cross-org.
  const scope = dashboardScope(req);
  const data = db.prepare(`
    SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.created_at,
      c.name AS category_name,
      r.name || ' ' || r.last_name AS reporter_name,
      a.name || ' ' || a.last_name AS assigned_name
    FROM tickets t
    LEFT JOIN users r ON r.id = t.reporter_id AND r.organization_id = t.organization_id
    LEFT JOIN categories c ON c.id = t.category_id AND c.organization_id = t.organization_id
    LEFT JOIN users a ON a.id = t.assigned_to_id AND a.organization_id = t.organization_id
    WHERE ${scope.sql}
    ORDER BY t.created_at DESC LIMIT 8`).all(...scope.params);
  res.json({ data });
});

export default router;