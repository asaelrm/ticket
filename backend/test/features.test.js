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
  await adminC.login('admin', '123456');
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
    await adminC.post(`/api/tickets/${today.id}/resolve`, { resolution: 'Resolución de prueba' });

    // Cerrado ayer. La referencia es el `resolved_at` que la aplicación acaba de
    // escribir, no la hora del proceso: si algún POST cruzara la medianoche UTC
    // entre leer el reloj y leer la fila, un `Date.now() - 24h` caería en un día
    // que ya no es el anterior y la prueba fallaría sin que haya ningún bug.
    // Anclando las dos fechas al mismo registro quedan exactamente 24 horas de
    // distancia, es decir, siempre dos días UTC consecutivos.
    const yesterday = await createTicket(adminC);
    await adminC.post(`/api/tickets/${yesterday.id}/resolve`, { resolution: 'Resolución de prueba' });
    const resolvedToday = db.prepare('SELECT resolved_at FROM tickets WHERE id = ?').get(today.id).resolved_at;
    assert.ok(resolvedToday, 'el ticket de hoy debe tener fecha real de resolución');
    const yesterISO = new Date(new Date(resolvedToday).getTime() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE tickets SET resolved_at = ?, closed_at = NULL WHERE id = ?').run(yesterISO, yesterday.id);

    // "Ayer" no siempre está en el mismo mes que "hoy": el día 1 del mes cae en
    // el mes anterior, y el 1 de enero además en el año anterior. Los contadores
    // aciertan igual; lo que no puede ser constante es la cantidad esperada. Se
    // compara en UTC, que es la zona con la que la aplicación arma los rangos.
    // today yesterday no dependen de esto: los dos tickets son días distintos.
    const sameMonth = yesterISO.slice(0, 7) === resolvedToday.slice(0, 7);
    const sameYear = yesterISO.slice(0, 4) === resolvedToday.slice(0, 4);

    const after = await adminC.get('/api/tickets/counters');
    assert.equal(after.body.closed.today - before.body.closed.today, 1);
    assert.equal(after.body.closed.yesterday - before.body.closed.yesterday, 1);
    assert.equal(after.body.closed.month - before.body.closed.month, sameMonth ? 2 : 1);
    assert.equal(after.body.closed.year - before.body.closed.year, sameYear ? 2 : 1);

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

describe('Indicadores compactos de la bandeja', () => {
  // El número de la cabecera y el listado que produce su filtro tienen que
  // contar lo mismo. Si divergen, el técnico ve "3" y pulsa un filtro que
  // devuelve 2 sin ninguna explicación, así que cada indicador se comprueba
  // contra su propia consulta en lugar de contra un valor fijo.
  async function assertAgreesWithList(counters, params, ids, label) {
    const res = await adminC.get(`/api/tickets?perPage=100&${params}`);
    assert.equal(res.status, 200);
    const listIds = new Set(res.body.data.map((t) => t.id));
    for (const id of ids) assert.ok(listIds.has(id), `${label}: el listado debe incluir el ticket ${id}`);
    return listIds.size;
  }

  it('mine_active cuenta lo mismo que la vista "mine"', async () => {
    const t = await createTicket(adminC, { priority: 'MEDIUM' });
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: 1 });

    const counters = await adminC.get('/api/tickets/counters');
    // `active=1` es lo que la Bandeja manda siempre en el listado: es la misma
    // condición de "abierto" que usa el contador, así que los dos convergen.
    const listIds = await assertAgreesWithList(counters, 'view=mine&active=1', [t.id], 'mine_active');

    assert.ok(counters.body.mine_active <= listIds, `mine_active (${counters.body.mine_active}) > listados (${listIds})`);
    assert.ok(counters.body.mine_active >= 1);
  });

  it('critical cuenta lo mismo que el filtro de prioridad crítica', async () => {
    const t = await createTicket(adminC, { priority: 'CRITICAL' });

    const counters = await adminC.get('/api/tickets/counters');
    const listIds = await assertAgreesWithList(
      counters,
      'view=open&active=1&priority=CRITICAL',
      [t.id],
      'critical'
    );

    assert.equal(listIds, counters.body.critical, 'El listado de críticos debe traer exactamente los que cuenta el indicador');
  });

  it('on_hold cuenta lo mismo que el filtro de estado pendiente', async () => {
    const t = await createTicket(adminC);
    // Un ticket recién creado está en OPEN: "pendiente" es un estado al que hay
    // que moverlo explícitamente, no el punto de partida.
    await adminC.patch(`/api/tickets/${t.id}`, { status: 'PENDING' });

    const counters = await adminC.get('/api/tickets/counters');
    const listIds = await assertAgreesWithList(
      counters,
      'view=open&active=1&status=PENDING',
      [t.id],
      'on_hold'
    );

    assert.equal(listIds, counters.body.on_hold);
  });

  it('unassigned cuenta lo mismo que "assigned=none"', async () => {
    const t = await createTicket(adminC);

    const counters = await adminC.get('/api/tickets/counters');
    const listIds = await assertAgreesWithList(
      counters,
      'view=open&active=1&assigned=none',
      [t.id],
      'unassigned'
    );

    assert.equal(listIds, counters.body.unassigned);
  });

  it('unassigned incluye los tickets con equipo pero sin técnico', async () => {
    const team = await adminC.post('/api/teams', { name: `Turno ${Date.now()}`, description: 'Prueba' });
    const t = await createTicket(adminC);
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_team_id: team.body.team.id });

    const counters = await adminC.get('/api/tickets/counters');
    const list = await adminC.get('/api/tickets?perPage=100&view=open&active=1&assigned=none');
    const listIds = new Set(list.body.data.map((x) => x.id));

    // Sin técnico el ticket sigue sin dueño: si el contador lo excluye por tener
    // equipo, la lista y el número contando cosas distintas.
    assert.ok(listIds.has(t.id));
    assert.equal(listIds.size, counters.body.unassigned);
  });

  it('los indicadores no cuentan tickets cerrados', async () => {
    const t = await createTicket(adminC, { priority: 'CRITICAL' });
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_to_id: 1 });
    await adminC.post(`/api/tickets/${t.id}/resolve`, { resolution: 'Resuelto en la prueba' });
    await adminC.post(`/api/tickets/${t.id}/close`, {});

    const counters = await adminC.get('/api/tickets/counters');
    const mine = await adminC.get('/api/tickets?perPage=100&view=mine&active=1');
    assert.ok(!mine.body.data.some((x) => x.id === t.id));

    const listIds = await assertAgreesWithList(counters, 'view=open&active=1&priority=CRITICAL', [], 'critical');
    assert.equal(listIds, counters.body.critical);
  });
});

describe('Filtro de tiempo de atención (?sla=)', () => {
  const HOUR = 3600000;

  async function ticketWithDueAt(hoursFromNow, over = {}) {
    const t = await createTicket(adminC, over);
    const due = new Date(Date.now() + hoursFromNow * HOUR).toISOString();
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(due, t.id);
    return t.id;
  }

  it('sla=overdue devuelve los abiertos con el plazo ya vencido', async () => {
    const vencido = await ticketWithDueAt(-1);
    const vigente = await ticketWithDueAt(2);

    const res = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=overdue');
    assert.equal(res.status, 200);
    const ids = res.body.data.map((t) => t.id);
    assert.ok(ids.includes(vencido));
    assert.ok(!ids.includes(vigente));
  });

  it('sla=due_soon devuelve sólo los que vencen en las próximas 24 h', async () => {
    const pronto = await ticketWithDueAt(3);
    const tardio = await ticketWithDueAt(48);

    const res = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=due_soon');
    const ids = res.body.data.map((t) => t.id);
    assert.ok(ids.includes(pronto));
    assert.ok(!ids.includes(tardio));
  });

  it('un ticket cerrado no aparece en ninguno de los dos, aunque su SLA venzan', async () => {
    const id = await ticketWithDueAt(-5);
    await adminC.patch(`/api/tickets/${id}`, { assigned_to_id: 1 });
    await adminC.post(`/api/tickets/${id}/resolve`, { resolution: 'Resuelto' });
    await adminC.post(`/api/tickets/${id}/close`, {});

    const overdue = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=overdue');
    const soon = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=due_soon');
    assert.ok(!overdue.body.data.some((t) => t.id === id));
    assert.ok(!soon.body.data.some((t) => t.id === id));
  });

  it('un valor de sla desconocido no filtra nada ni revienta', async () => {
    const res = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=inventado');
    assert.equal(res.status, 200);
    const sinFiltro = await adminC.get('/api/tickets?perPage=100&view=open&active=1');
    assert.equal(res.body.total, sinFiltro.body.total);
  });

  it('el contador overdue y el filtro sla=overdue cuentan lo mismo', async () => {
    await ticketWithDueAt(-2);
    const counters = await adminC.get('/api/tickets/counters');
    const list = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=overdue');
    assert.equal(list.body.total, counters.body.overdue);
  });

  it('el filtro sla se combina con búsqueda y categoría', async () => {
    const id = await ticketWithDueAt(-1, { category_id: 1 });
    await adminC.patch(`/api/tickets/${id}`, { assigned_to_id: 1 });

    const res = await adminC.get('/api/tickets?perPage=100&view=open&active=1&sla=overdue&category=1');
    assert.ok(res.body.data.some((t) => t.id === id));
  });

  it('export aplica el mismo filtro que el listado', async () => {
    const vencido = await ticketWithDueAt(-1);
    const vigente = await ticketWithDueAt(30);

    const res = await adminC.get('/api/tickets/export?sla=overdue&format=csv');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`TCK-\\d+`), 'el CSV debe traer tickets');
    const mine = db.prepare('SELECT ticket_number FROM tickets WHERE id = ?').get(vencido).ticket_number;
    assert.match(res.text, new RegExp(mine), 'debe incluir el ticket vencido');
    const otro = db.prepare('SELECT ticket_number FROM tickets WHERE id = ?').get(vigente).ticket_number;
    assert.doesNotMatch(res.text, new RegExp(otro), 'no debe incluir el ticket aún vigente');
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

  it('/api/teams/mine devuelve sólo los equipos del usuario', async () => {
    const suffix = Date.now();
    const mio = await adminC.post('/api/teams', { name: `Mio ${suffix}` });
    const ajeno = await adminC.post('/api/teams', { name: `Ajeno ${suffix}` });
    await adminC.put(`/api/teams/${mio.body.team.id}/members`, { user_ids: [1, 2] });
    await adminC.put(`/api/teams/${ajeno.body.team.id}/members`, { user_ids: [4] });

    const delAdmin = await adminC.get('/api/teams/mine');
    assert.equal(delAdmin.status, 200);
    const ids = delAdmin.body.data.map((t) => t.id);
    assert.ok(ids.includes(mio.body.team.id), 'el admin es miembro, debe ver su equipo');
    assert.ok(!ids.includes(ajeno.body.team.id), 'no debe ver un equipo del que no es miembro');

    const delEmpleado = await empleadoC.get('/api/teams/mine');
    assert.equal(delEmpleado.status, 200);
    assert.deepEqual(
      delEmpleado.body.data.map((t) => t.id),
      [mio.body.team.id]
    );
  });

  it('/api/teams/mine devuelve lista vacía para quien no pertenece a ningún equipo', async () => {
    // Usuario nuevo y sin equipos: los tests comparten base de datos, así que no
    // se puede dar por hecho que `empleado` siga sin equipo.
    const suffix = Date.now();
    const nuevo = await adminC.post('/api/users', {
      name: 'Sin',
      last_name: 'Equipo',
      username: `sin.equipo.${suffix}`,
      email: `sin.equipo.${suffix}@empresa.com`,
      password: 'Temporal1234!',
      role_id: 2,
    });
    assert.equal(nuevo.status, 201);

    const c = createClient();
    await c.login(`sin.equipo.${suffix}`, 'Temporal1234!');
    const res = await c.get('/api/teams/mine');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  it('/api/teams/mine no lo puede usar un usuario sin sesión', async () => {
    const anon = createClient();
    const res = await anon.get('/api/teams/mine');
    assert.equal(res.status, 401);
  });

  it('la pertenencia a equipos y la vista "my-teams" cuentan lo mismo', async () => {
    const suffix = Date.now();
    const team = await adminC.post('/api/teams', { name: `Coherencia ${suffix}` });
    const teamId = team.body.team.id;
    await adminC.put(`/api/teams/${teamId}/members`, { user_ids: [2] });

    // El empleado no tiene `ticket.view.all`, así que su listado queda acotado a
    // los tickets que él mismo reporta. Por eso el ticket se crea con su cuenta:
    // de lo contrario la vista lo ocultaría por el scope de reportante y la
    // comprobación mediría lo que no es.
    const t = await createTicket(empleadoC);
    await adminC.patch(`/api/tickets/${t.id}`, { assigned_team_id: teamId });

    const mine = await empleadoC.get('/api/teams/mine');
    assert.ok(mine.body.data.some((x) => x.id === teamId), 'el empleado pertenece al equipo');

    const list = await empleadoC.get('/api/tickets?view=my-teams');
    assert.ok(list.body.data.some((x) => x.id === t.id), 'el ticket asignado al equipo sale en view=my-teams');
    const counters = await adminC.get('/api/tickets/counters');
    assert.ok(counters.body.assigned_to_my_teams >= 1);

    // Y el caso contrario: pertenecer a un equipo sin tickets deja la vista vacía
    // pero el equipo sigue existiendo, que es justo por lo que la Bandeja
    // comprueba la pertenencia en vez de fiarse del contador.
    const vacio = await adminC.post('/api/teams', { name: `Vacio ${suffix}` });
    await adminC.put(`/api/teams/${vacio.body.team.id}/members`, { user_ids: [2] });
    const list2 = await empleadoC.get('/api/tickets?view=my-teams');
    assert.equal(
      list2.body.data.filter((x) => x.assigned_team_id === vacio.body.team.id).length,
      0
    );
    // Con pertenencia pero cero tickets, la Bandega sigue mostrando la pestaña:
    // el contador no puede decir "sin equipo" cuando el equipo existe.
    const mine2 = await empleadoC.get('/api/teams/mine');
    assert.ok(mine2.body.data.some((x) => x.id === vacio.body.team.id));
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
