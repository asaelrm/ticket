import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';

// Clientes compartidos: el login tiene rate limit (10/min por IP) y cada
// archivo de test corre en su propio proceso, así que evitamos logins repetidos.
let adminC;
let empleadoC;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', 'Admin1234!');
  empleadoC = createClient();
  await empleadoC.login('empleado', 'Empleado1234!');
});

async function createTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `Ticket ${Math.random().toString(36).slice(2, 8)}`,
    description: over.description || 'Descripción de prueba',
    category_id: over.category_id ?? 1,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

describe('Contadores de filtros rápidos', () => {
  it('agrupa abiertos, pendientes, atendidos e en proceso', async () => {
    const before = await adminC.get('/api/tickets/counters');
    assert.equal(before.status, 200);

    const t1 = await createTicket(adminC);

    const mid = await adminC.get('/api/tickets/counters');
    assert.equal(mid.body.open - before.body.open, 1);
    assert.equal(mid.body.pending - before.body.pending, 1); // recién creado está en cola

    await adminC.patch(`/api/tickets/${t1.id}`, { assigned_to_id: 1, status: 'IN_PROGRESS' });
    const after = await adminC.get('/api/tickets/counters');
    assert.equal(after.body.attended - before.body.attended, 1);
    assert.equal(after.body.in_progress - before.body.in_progress, 1);
    assert.equal(after.body.pending - before.body.pending, 0);
  });

  it('cuenta retrasados usando la fecha límite de SLA', async () => {
    const before = await adminC.get('/api/tickets/counters');

    const t = await createTicket(adminC, { priority: 'CRITICAL' });
    assert.ok(t.sla_due_at, 'El ticket debe tener SLA al crearse');

    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      t.id
    );

    const after = await adminC.get('/api/tickets/counters');
    assert.equal(after.body.overdue - before.body.overdue, 1);

    const list = await adminC.get('/api/tickets?view=overdue');
    assert.ok(list.body.data.some((x) => x.id === t.id));
  });

  it('cuenta asignados a mí y a mi equipo', async () => {
    const team = await adminC.post('/api/teams', { name: `Soporte ${Date.now()}`, description: 'Equipo de prueba' });
    assert.equal(team.status, 201);
    const teamId = team.body.team.id;
    await adminC.put(`/api/teams/${teamId}/members`, { user_ids: [1] });

    const mine = await createTicket(adminC);
    const mteams = await createTicket(adminC);

    await adminC.patch(`/api/tickets/${mine.id}`, { assigned_to_id: 1 });
    await adminC.patch(`/api/tickets/${mteams.id}`, { assigned_team_id: teamId });

    const counters = await adminC.get('/api/tickets/counters');
    const listMine = await adminC.get('/api/tickets?view=mine');
    const listTeams = await adminC.get('/api/tickets?view=my-teams');

    assert.ok(counters.body.assigned_to_me >= 1);
    assert.ok(counters.body.assigned_to_my_teams >= 1);
    assert.ok(listMine.body.data.some((x) => x.id === mine.id));
    assert.ok(listTeams.body.data.some((x) => x.id === mteams.id));
    assert.ok(listTeams.body.data.some((x) => x.team_name === team.body.team.name));
  });

  it('cuenta cerrados por período con la fecha real de cierre', async () => {
    const before = await adminC.get('/api/tickets/counters');

    // Resuelto hoy → suma en today/mes/trimestre/año
    const today = await createTicket(adminC);
    await adminC.patch(`/api/tickets/${today.id}`, { status: 'RESOLVED' });

    // Cerrado ayer
    const yesterday = await createTicket(adminC);
    const yesterISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await adminC.patch(`/api/tickets/${yesterday.id}`, { status: 'RESOLVED' });
    db.prepare('UPDATE tickets SET resolved_at = ?, closed_at = NULL WHERE id = ?').run(yesterISO, yesterday.id);

    const after = await adminC.get('/api/tickets/counters');
    assert.equal(after.body.closed.today - before.body.closed.today, 1);
    assert.equal(after.body.closed.yesterday - before.body.closed.yesterday, 1);
    assert.equal(after.body.closed.month - before.body.closed.month, 2);
    assert.equal(after.body.closed.year - before.body.closed.year, 2);

    const listToday = await adminC.get('/api/tickets?view=closed&closed_period=today');
    assert.ok(listToday.body.data.some((x) => x.id === today.id));
    assert.ok(!listToday.body.data.some((x) => x.id === yesterday.id));

    const listYesterday = await adminC.get('/api/tickets?view=closed&closed_period=yesterday');
    assert.ok(listYesterday.body.data.some((x) => x.id === yesterday.id));
    assert.ok(!listYesterday.body.data.some((x) => x.id === today.id));
  });

  it('empleado solo ve sus propios contadores', async () => {
    const c = createClient();
    await c.login('empleado', 'Empleado1234!');
    const counters = await c.get('/api/tickets/counters');
    assert.equal(counters.status, 200);

    const t = await createTicket(c);
    const after = await c.get('/api/tickets/counters');
    assert.equal(after.body.all - counters.body.all, 1);
  });
});

describe('Equipos de trabajo', () => {
  it('admin gestiona equipos y agrega miembros', async () => {
    const team = await adminC.post('/api/teams', { name: `Mesa ${Date.now()}` });
    assert.equal(team.status, 201);

    const teamId = team.body.team.id;
    const members = await adminC.put(`/api/teams/${teamId}/members`, { user_ids: [1, 2] });
    assert.equal(members.status, 200);
    assert.equal(members.body.members.length, 2);

    const list = await adminC.get('/api/teams');
    assert.ok(list.body.data.some((t) => t.id === teamId && t.member_count === 2));

    const patch = await adminC.patch(`/api/teams/${teamId}`, { name: `Mesa Apache ${Date.now()}` });
    assert.equal(patch.status, 200);

    const del = await adminC.del(`/api/teams/${teamId}`);
    assert.equal(del.status, 200);
  });

  it('empleado no puede crear equipos', async () => {
    const res = await empleadoC.post('/api/teams', { name: 'No autorizado' });
    assert.equal(res.status, 403);
  });

  it('asignar a equipo registra historial y filtro por equipo funciona', async () => {
    const team = await adminC.post('/api/teams', { name: `HD ${Date.now()}` });
    const teamId = team.body.team.id;

    const t = await createTicket(adminC);
    const assign = await adminC.patch(`/api/tickets/${t.id}`, { assigned_team_id: teamId });
    assert.equal(assign.status, 200);
    assert.equal(assign.body.ticket.team_name, team.body.team.name);

    const detail = await adminC.get(`/api/tickets/${t.id}`);
    assert.ok(detail.body.history.some((h) => h.action === 'ASSIGNED_TEAM'));

    const filtered = await adminC.get(`/api/tickets?team=${teamId}`);
    assert.ok(filtered.body.data.some((x) => x.id === t.id && x.team_name === team.body.team.name));
  });
});

describe('Búsqueda, ordenamiento y paginación', () => {
  it('busca por correo, reportante, departamento y técnico asignado', async () => {
    // Ticket reportado por el empleado para que el correo/nombre/departamento coincidan.
    const t = await createTicket(empleadoC, { title: 'Consulta soporte tecnico' });
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: 2 });

    const byEmail = await adminC.get('/api/tickets?search=empleado%40empresa.com');
    assert.ok(byEmail.body.data.some((x) => x.id === t.id));

    const byReporter = await adminC.get('/api/tickets?search=Empleado%20Demo');
    assert.ok(byReporter.body.data.some((x) => x.id === t.id));

    const byTech = await adminC.get('/api/tickets?search=Empleado');
    assert.ok(byTech.body.data.some((x) => x.id === t.id));

    const byDept = await adminC.get('/api/tickets?search=Recursos%20Humanos');
    assert.ok(byDept.body.data.some((x) => x.id === t.id));
  });

  it('ordena por fecha de cierre real', async () => {
    const a = await createTicket(adminC);
    const b = await createTicket(adminC);
    await adminC.patch(`/api/tickets/${a.id}`, { status: 'RESOLVED' });
    db.prepare('UPDATE tickets SET resolved_at = ? WHERE id = ?').run(
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      a.id
    );
    await adminC.patch(`/api/tickets/${b.id}`, { status: 'RESOLVED' });

    const asc = await adminC.get('/api/tickets?sort=closed_at&dir=asc&view=closed');
    assert.equal(asc.status, 200);
    const idxA = asc.body.data.findIndex((x) => x.id === a.id);
    const idxB = asc.body.data.findIndex((x) => x.id === b.id);
    assert.ok(idxA === -1 || idxB === -1 || idxA < idxB, 'el cierre más antiguo debe ir primero');
  });

  it('pagina y respeta perPage de 10/25/50/100', async () => {
    for (let i = 0; i < 30; i++) await createTicket(adminC);

    for (const perPage of [10, 25, 50, 100]) {
      const res = await adminC.get(`/api/tickets?perPage=${perPage}&page=1`);
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length <= perPage);
      assert.equal(res.body.perPage, perPage);
      assert.ok(res.body.pages >= 1);
    }

    const page1 = await adminC.get('/api/tickets?perPage=10&page=1');
    const page2 = await adminC.get('/api/tickets?perPage=10&page=2');
    assert.notEqual(page1.body.data[0].id, page2.body.data[0].id);
  });

  it('combina filtros de búsqueda avanzada', async () => {
    const t = await createTicket(adminC, { title: 'Impresora HP oficina', category_id: 2, priority: 'HIGH' });
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 1);
    const iso = from.toISOString().slice(0, 10);

    const res = await adminC.get(`/api/tickets?category=2&priority=HIGH&from=${iso}&search=Impresora`);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((x) => x.id === t.id));

    const clean = await adminC.get('/api/tickets?category=2&priority=LOW&search=Impresora');
    assert.ok(!clean.body.data.some((x) => x.id === t.id), 'filtros combinados deben restringir');
  });
});

describe('Usuarios asignables y roles', () => {
  it('lista usuarios asignables con su departamento', async () => {
    const res = await adminC.get('/api/users/assignable');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 2);
    const admin = res.body.data.find((u) => u.id === 1);
    assert.ok(admin, 'debe incluir al administrador');
    assert.equal(admin.name, 'Administrador');
    assert.ok('department_name' in admin, 'debe incluir department_name');
  });

  it('devuelve roles con permisos y usuarios, y el catálogo de permisos', async () => {
    const roles = await adminC.get('/api/roles');
    assert.equal(roles.status, 200);
    assert.ok(Array.isArray(roles.body.roles));
    const admin = roles.body.roles.find((r) => r.code === 'ADMIN');
    assert.ok(admin, 'debe existir el rol ADMIN');
    assert.ok(admin.permissions.includes('ticket.resolve'));
    assert.equal(typeof admin.users, 'number');

    const perms = await adminC.get('/api/roles/permissions');
    assert.equal(perms.status, 200);
    assert.ok(Array.isArray(perms.body.permissions));
    assert.ok(perms.body.permissions.some((p) => p.code === 'ticket.note'));
    assert.ok(perms.body.permissions.every((p) => p.description));
  });

  it('crea, consulta, edita y cambia estado de un usuario (regresión)', async () => {
    const rolesRes = await adminC.get('/api/users/roles');
    const roleId = rolesRes.body.roles.find((r) => r.code === 'EMPLOYEE').id;
    const uname = `regres_${Date.now()}`;
    const payload = {
      name: 'Regresión',
      last_name: 'Usuario',
      username: uname,
      email: `${uname}@test.local`,
      password: '123456',
      role_id: roleId,
    };

    const created = await adminC.post('/api/users', payload);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.user.id;
    assert.ok(id, 'debe devolver el usuario creado');

    const detail = await adminC.get(`/api/users/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.user.id, id);

    const updated = await adminC.patch(`/api/users/${id}`, { ...payload, name: 'Regresión Editada' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.user.name, 'Regresión Editada');

    const disabled = await adminC.patch(`/api/users/${id}/status`, { active: false });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.user.active, false);
  });
});
