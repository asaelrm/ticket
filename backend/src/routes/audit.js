import express from 'express';
import runtime from '../db/runtime.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId } from '../middleware/org.js';
import { parseIntSafe } from '../utils/validation.js';

const router = express.Router();
router.use(requireAuth, requirePermission('settings.manage'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Auditoría consultable: historial de cambios sobre tickets.
router.get('/', async (req, res) => {
  try {
    const conds = [];
    const params = [];

    // ETAPA 3: la auditoría es el historial de TICKETS, así que se acota a la
    // organización del actor. Un SUPERADMIN global (org null) obtiene un listado
    // vacío, coherente con su listado de tickets vacío.
    const org = currentOrgId(req.user);
    const sifha = req.user.permissions.includes('ticket.sifha.view')
      ? (req.user.sifha_organization_ids || []).filter(Number.isInteger) : [];
    if (sifha.length) {
      const scopes = [];
      if (org) { scopes.push('(t.organization_id = ? AND t.support_scope = ?)'); params.push(org, 'INTERNAL'); }
      scopes.push(`(t.organization_id IN (${sifha.map(() => '?').join(',')}) AND t.support_scope = ?)`);
      params.push(...sifha, 'SIFHA');
      conds.push(`(${scopes.join(' OR ')})`);
    } else {
      conds.push(org ? 't.organization_id = ? AND t.support_scope = ?' : '1 = 0');
      if (org) params.push(org, 'INTERNAL');
    }

    if (req.query.search) {
      const term = String(req.query.search).toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
      const like = `%${term}%`;
      conds.push("(lower(th.description) LIKE ? ESCAPE '\\' OR lower(t.ticket_number) LIKE ? ESCAPE '\\' OR lower(t.title) LIKE ? ESCAPE '\\')");
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

    const total = await runtime.queryOne(
      `SELECT COUNT(*) AS n FROM ticket_history th
       JOIN tickets t ON t.id = th.ticket_id ${where}`,
      ...params
    );

    const rows = await runtime.queryMany(
      `SELECT th.*, u.name || ' ' || u.last_name AS user_name,
              t.ticket_number, t.title AS ticket_title
       FROM ticket_history th
       JOIN tickets t ON t.id = th.ticket_id
       LEFT JOIN users u ON u.id = th.user_id
       ${where}
       ORDER BY th.id DESC LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      (page - 1) * perPage
    );

    // El catálogo es metadato de la misma auditoría: debe recorrer los tickets
    // visibles para la organización actual y nunca revelar acciones exclusivas
    // de otra empresa.
    const actionScope = conds.find((condition) => condition.includes('t.support_scope')) || (org ? 't.organization_id = ? AND t.support_scope = ?' : '1 = 0');
    const actionParams = sifha.length
      ? (org ? [org, 'INTERNAL', ...sifha, 'SIFHA'] : [...sifha, 'SIFHA'])
      : (org ? [org, 'INTERNAL'] : []);
    const actions = await runtime.queryMany(
      `SELECT DISTINCT th.action FROM ticket_history th
       JOIN tickets t ON t.id = th.ticket_id
       WHERE ${actionScope}
       ORDER BY th.action`,
      ...actionParams
    );
    const actionList = actions.map((r) => r.action);

    res.json({ data: rows, total: total.n, page, perPage, pages: Math.ceil(total.n / perPage), actions: actionList });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
