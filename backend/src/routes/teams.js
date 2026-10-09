import express from 'express';
import runtime from '../db/runtime.js';
import { nowIso } from '../utils/time.js';
import { safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg, requireOrg } from '../middleware/org.js';
import { insertTeamMember } from '../utils/kbTeamChildWrites.js';

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

// ETAPA 3 (aislamiento por organización): equipos SIEMPRE dentro de la org del
// contexto de sesión. Un SUPERADMIN sin contexto obtiene una lista vacía.
router.get('/', async (req, res) => {
  try {
    if (!canViewTeams(req.user)) return res.status(403).json({ error: 'No tiene permiso para ver equipos' });
    const rows = await runtime.queryMany(`${LIST_SQL} WHERE te.active = 1 AND te.organization_id = ? ORDER BY te.name ASC`, currentOrgId(req.user));
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Equipos que se pueden asignar. Mismo criterio que /api/users/assignable:
// asignación de tickets (ticket.assign), filtro por equipo de la búsqueda
// avanzada (ticket.view.all) y administración de equipos (team.manage).
router.get(
  '/assignable',
  requireAnyPermission(['ticket.assign', 'ticket.view.all', 'team.manage']),
  async (req, res) => {
    try {
      const rows = await runtime.queryMany(
        `SELECT te.id, te.name, te.description,
           (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = te.id) AS member_count
         FROM teams te WHERE te.active = 1 AND te.organization_id = ? ORDER BY te.name ASC`,
        currentOrgId(req.user)
      );
      res.json({ data: rows });
    } catch (err) {
      res.status(500).json({ error: 'Error interno' });
    }
  }
);

// Equipos a los que pertenece el usuario autenticado.
//
// La Bandeja lo consulta para no ofrecer la pestaña "Mi equipo" a quien no
// pertenece a ninguno: `view=my-teams` y el contador `assigned_to_my_teams` se
// calculan sobre `team_members`, así que sin membresía siempre valdrían 0 y la
// pestaña no aportaría nada (en DEV llegó a estar permanentemente en 0).
//
// Se declara antes que `/:id` a propósito: si no, Express lo interpretaría como
// un id y respondería "Equipo no encontrado".
//
// Usa el mismo criterio que `myTeamIds` en routes/tickets.js —pertenencia, sin
// filtrar por `active`— para que "la pestaña existe" y "la vista devuelve
// tickets" nunca se contradigan. Solo lectura, y con el mismo alcance que la
// propia vista: cualquier usuario autenticado conoce los suyos.
router.get('/mine', async (req, res) => {
  try {
    const rows = await runtime.queryMany(
      `SELECT te.id, te.name
         FROM team_members tm
         JOIN teams te ON te.id = tm.team_id
        WHERE tm.user_id = ? AND te.organization_id = ?
        ORDER BY te.name ASC`,
      req.user.id,
      currentOrgId(req.user)
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Detalle: alias de organización devuelve 404 (no revela la existencia de un
// equipo de otra organización). Un SUPERADMIN sin contexto (org NULL) también
// obtiene 404: las rutas normales exigen una organización real.
router.get('/:id', async (req, res) => {
  try {
    if (!canViewTeams(req.user)) return res.status(403).json({ error: 'No tiene permiso para ver equipos' });
    const id = parseIntSafe(req.params.id);
    const team = await runtime.queryOne(`${LIST_SQL} WHERE te.id = ? AND te.organization_id = ?`, id, currentOrgId(req.user));
    if (!team) return res.status(404).json({ error: 'Equipo no encontrado' });

    const members = await runtime.queryMany(`
      SELECT u.id, u.name, u.last_name, u.username, u.email, u.position,
             d.name AS department_name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE tm.team_id = ? AND u.active = 1
      ORDER BY u.name, u.last_name
    `, id);

    res.json({ team, members });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Creación: exige contexto de organización y rechaza que el cliente intente
// fijar `organization_id` en el cuerpo (mismo patrón que departments).
router.post('/', requirePermission('team.manage'), requireOrg, async (req, res) => {
  try {
    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = safeStr(req.body.name);
    const description = safeStr(req.body.description);
    if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (name.length > 100) return res.status(400).json({ error: 'El nombre no puede superar 100 caracteres' });

    // El nombre sigue siendo único global (SQLite); limitación conocida que se
    // resuelve en la etapa MSSQL (mismo criterio que departments/categories).
    const existingName = await runtime.queryOne('SELECT id FROM teams WHERE LOWER(name) = LOWER(?)', name);
    if (existingName) {
      return res.status(409).json({ error: 'Ya existe un equipo con ese nombre' });
    }

    const organizationId = currentOrgId(req.user);
    const result = await runtime.insertAndGetId('INSERT INTO teams (name, description, organization_id) VALUES (?, ?, ?)', name, description || null, organizationId);
    const team = await runtime.queryOne(`${LIST_SQL} WHERE te.id = ?`, result.id);
    res.status(201).json({ team });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id', requirePermission('team.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const existing = await runtime.queryOne('SELECT * FROM teams WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const name = req.body.name === undefined ? existing.name : safeStr(req.body.name);
    const description = req.body.description === undefined ? existing.description : safeStr(req.body.description);

    if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const dup = await runtime.queryOne('SELECT id FROM teams WHERE LOWER(name) = LOWER(?) AND id != ?', name, id);
    if (dup) return res.status(409).json({ error: 'Ya existe un equipo con ese nombre' });

    await runtime.execute('UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, description || null, nowIso(), id);
    const team = await runtime.queryOne(`${LIST_SQL} WHERE te.id = ?`, id);
    res.json({ team });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/:id', requirePermission('team.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const existing = await runtime.queryOne('SELECT id FROM teams WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

    await runtime.execute('DELETE FROM teams WHERE id = ?', id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Remplaza la lista de miembros de un equipo (team_id, [user_id, ...]).
// ETAPA 3: los miembros deben pertenecer a la MISMA organización del equipo.
// Un usuario de otra organización no existe para este equipo (400) y nunca se
// inserta. La organización del equipo nunca se modifica desde el cliente.
router.put('/:id/members', requirePermission('team.manage'), async (req, res) => {
  try {
    const id = parseIntSafe(req.params.id);
    const existing = await runtime.queryOne('SELECT * FROM teams WHERE id = ? AND organization_id = ?', id, currentOrgId(req.user));
    if (!existing) return res.status(404).json({ error: 'Equipo no encontrado' });

    const rejected = rejectClientOrg(req.body || {});
    if (rejected) return res.status(400).json({ error: rejected });

    const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map((v) => parseIntSafe(v)).filter((v) => v > 0) : [];
    const existingUsers = await runtime.queryMany(
      `SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND organization_id = ?`,
      ...ids,
      existing.organization_id
    ).then((rows) => rows.map((r) => r.id));
    for (const uid of ids) {
      if (!existingUsers.includes(uid)) {
        return res.status(400).json({ error: `El usuario ${uid} no existe o no pertenece a esta organización` });
      }
    }

    await runtime.transaction(async (tx) => {
      await tx.execute('DELETE FROM team_members WHERE team_id = ?', id);
      for (const uid of ids) {
        // insertTeamMember añade organization_id (derivada del equipo) y valida
        // que el usuario pertenece a esa misma organización en MSSQL; en SQLite
        // omite la columna y conserva el INSERT OR IGNORE anterior.
        await insertTeamMember(id, uid, { organizationId: existing.organization_id });
      }
    });

    const members = await runtime.queryMany(`
      SELECT u.id, u.name, u.last_name, u.username, u.email, u.position,
             d.name AS department_name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE tm.team_id = ? AND u.active = 1
      ORDER BY u.name, u.last_name
    `, id);
    const team = await runtime.queryOne(`${LIST_SQL} WHERE te.id = ?`, id);
    res.json({ team, members });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;