import express from 'express';
import db, { nowIso } from '../db.js';
import { safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

function hasPerm(user, code) {
  return user.permissions.includes(code);
}

const LIST_SQL = `
  SELECT te.*,
    (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = te.id) AS member_count,
    (SELECT COUNT(*) FROM tickets t
       WHERE t.assigned_team_id = te.id
         AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING')) AS open_tickets
  FROM teams te
`;

function canViewTeams(user) {
  return hasPerm(user, 'ticket.view.all') || hasPerm(user, 'user.view') || hasPerm(user, 'team.manage');
}

router.get('/', (req, res) => {
  if (!canViewTeams(req.user)) return res.status(403).json({ error: 'No tiene permiso para ver equipos' });
  const rows = db.prepare(`${LIST_SQL} WHERE te.active = 1 ORDER BY te.name ASC`).all();
  res.json({ data: rows });
});

// Equipos que se pueden asignar. Mismo criterio que /api/users/assignable:
// asignación de tickets (ticket.assign), filtro por equipo de la búsqueda
// avanzada (ticket.view.all) y administración de equipos (team.manage).
router.get(
  '/assignable',
  requireAnyPermission(['ticket.assign', 'ticket.view.all', 'team.manage']),
  (req, res) => {
    const rows = db.prepare(
      `SELECT te.id, te.name, te.description,
         (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = te.id) AS member_count
       FROM teams te WHERE te.active = 1 ORDER BY te.name ASC`
    ).all();
    res.json({ data: rows });
  }
);

router.get('/:id', (req, res) => {
  if (!canViewTeams(req.user)) return res.status(403).json({ error: 'No tiene permiso para ver equipos' });
  const id = parseIntSafe(req.params.id);
  const team = db.prepare(`${LIST_SQL} WHERE te.id = ?`).get(id);
  if (!team) return res.status(404).json({ error: 'Equipo no encontrado' });

  const members = db.prepare(`
    SELECT u.id, u.name, u.last_name, u.username, u.email, u.position,
           d.name AS department_name
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE tm.team_id = ? AND u.active = 1
    ORDER BY u.name, u.last_name
  `).all(id);

  res.json({ team, members });
});

router.post('/', requirePermission('team.manage'), (req, res) => {
  const name = safeStr(req.body.name);
  const description = safeStr(req.body.description);
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (name.length > 100) return res.status(400).json({ error: 'El nombre no puede superar 100 caracteres' });

  if (db.prepare('SELECT id FROM teams WHERE LOWER(name) = LOWER(?)').get(name)) {
    return res.status(409).json({ error: 'Ya existe un equipo con ese nombre' });
  }

  const info = db.prepare('INSERT INTO teams (name, description) VALUES (?, ?)').run(name, description || null);
  res.status(201).json({ team: db.prepare(`${LIST_SQL} WHERE te.id = ?`).get(info.lastInsertRowid) });
});

router.patch('/:id', requirePermission('team.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

  const name = req.body.name === undefined ? existing.name : safeStr(req.body.name);
  const description = req.body.description === undefined ? existing.description : safeStr(req.body.description);

  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const dup = db.prepare('SELECT id FROM teams WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
  if (dup) return res.status(409).json({ error: 'Ya existe un equipo con ese nombre' });

  db.prepare('UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, description || null, nowIso(), id);
  res.json({ team: db.prepare(`${LIST_SQL} WHERE te.id = ?`).get(id) });
});

router.delete('/:id', requirePermission('team.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Remplaza la lista de miembros de un equipo (team_id, [user_id, ...]).
router.put('/:id/members', requirePermission('team.manage'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map((v) => parseIntSafe(v)).filter((v) => v > 0) : [];
  const existingUsers = db
    .prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`)
    .all(...ids)
    .map((r) => r.id);
  for (const uid of ids) {
    if (!existingUsers.includes(uid)) {
      return res.status(400).json({ error: `El usuario ${uid} no existe` });
    }
  }

  db.prepare('BEGIN');
  try {
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)');
    for (const uid of ids) ins.run(id, uid);
    db.prepare('COMMIT');
  } catch (err) {
    db.prepare('ROLLBACK');
    throw err;
  }

  const members = db.prepare(`
    SELECT u.id, u.name, u.last_name, u.username, u.email, u.position,
           d.name AS department_name
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE tm.team_id = ? AND u.active = 1
    ORDER BY u.name, u.last_name
  `).all(id);
  res.json({ team: db.prepare(`${LIST_SQL} WHERE te.id = ?`).get(id), members });
});

export default router;