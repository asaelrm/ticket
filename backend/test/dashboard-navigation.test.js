import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db from '../src/db.js';

// Pruebas del contrato que el Dashboard necesita para poder navegar al listado
// de tickets: los paneles por categoría y por departamento tienen que entregar
// el `id` de la fila, y "Tickets recientes" tiene que entregar el `id` del
// ticket y su técnico.
//
// Lo que se fija aquí NO es el aspecto de la pantalla (eso lo comprueba
// frontend/src/pages/Dashboard.test.jsx) sino que los datos que la UI enlaza
// existen y que el listado al que apuntan devuelve exactamente lo que la fila
// del panel anuncia. Si estas dos piezas se desincronizan, el enlace lleva a un
// listado cuyo total no cuadra con la cifra que se enseñó, que es el defecto que
// la navegación aims a evitar.

let adminC;
let techId;

before(async () => {
  adminC = createClient();
  await adminC.login('admin', '123456');

  const roles = await adminC.get('/api/users/roles');
  const techRole = roles.body.roles.find((r) => r.code === 'TECHNICIAN');
  assert.ok(techRole, 'el rol Técnico debe existir en el seed');

  const res = await adminC.post('/api/users', {
    name: 'Navegación',
    last_name: 'Técnico',
    username: `nav${Math.random().toString(36).slice(2, 7)}`,
    email: `nav${Math.random().toString(36).slice(2, 7)}@empresa.com`,
    password: 'Tecnico1234!',
    position: 'Soporte técnico',
    role_id: techRole.id,
  });
  assert.equal(res.status, 201);
  techId = res.body.user.id;
});

async function newTicket(over = {}) {
  const res = await adminC.post('/api/tickets', {
    title: over.title || `Nav ${Math.random().toString(36).slice(2, 7)}`,
    description: 'Descripción de navegación',
    category_id: over.category_id || 1,
    department_id: over.department_id,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201, 'el ticket de prueba debe crearse');
  return res.body.ticket;
}

const isNumber = (v) => Number.isInteger(v);

describe('Dashboard · navegación por categoría', () => {
  it('devuelve el id de cada categoría activa para poder enlazarla', async () => {
    const res = await adminC.get('/api/dashboard/by-category');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0, 'el seed debe traer categorías');

    for (const row of res.body.data) {
      assert.ok(isNumber(row.id), `la categoría "${row.name}" debe traer id numérico`);
      assert.ok(row.name, 'debe traer el nombre');
    }
  });

  it('incluye también las categorías sin tickets, para que "Ver todas" las alcance', async () => {
    const res = await adminC.get('/api/dashboard/by-category');
    const total = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE active = 1').get().n;

    // El panel oculta por defecto las que no tienen tickets abiertos y las
    // enseña con un interruptor. Si el endpoint las recortara, ese interruptor
    // no tendría nada que revelar.
    assert.equal(res.body.data.length, total, 'no debe recortar el catálogo de categorías');
    assert.ok(
      res.body.data.some((r) => r.n === 0 && r.open === 0),
      'debe incluir al menos una categoría sin tickets'
    );
  });

  it('cuenta `open` solo con los estados no terminales y coincide con ?category=<id>&active=1', async () => {
    const categoryId = 1;
    const before = (await adminC.get('/api/dashboard/by-category')).body.data.find((r) => r.id === categoryId);

    const fresh = await newTicket({ category_id: categoryId });
    const resolved = await newTicket({ category_id: categoryId });
    await adminC.post(`/api/tickets/${resolved.id}/resolve`, { resolution: 'Resuelto de prueba' });

    const after = (await adminC.get('/api/dashboard/by-category')).body.data.find((r) => r.id === categoryId);
    assert.equal(after.n - before.n, 2, 'los dos tickets nuevos cuentan en el total');
    assert.equal(after.open - before.open, 1, 'solo el que sigue abierto cuenta como abierto');

    // Este es el enlace exacto que emite la fila del panel.
    const list = await adminC.get(`/api/tickets?category=${categoryId}&active=1&perPage=100`);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, after.open, 'el listado debe traer los mismos tickets que la fila anuncia');
    assert.ok(list.body.data.some((t) => t.id === fresh.id), 'el ticket abierto debe estar en el listado');
    assert.ok(
      !list.body.data.some((t) => t.id === resolved.id),
      'el ticket resuelto no debe salir con active=1'
    );
  });
});

describe('Dashboard · navegación por departamento', () => {
  it('devuelve el id de cada departamento para poder enlazarlo', async () => {
    const res = await adminC.get('/api/dashboard/by-department');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0, 'el seed debe traer departamentos');

    for (const row of res.body.data) {
      assert.ok(isNumber(row.id), `el departamento "${row.name}" debe traer id numérico`);
      assert.ok(row.name, 'debe traer el nombre');
    }
  });

  it('no recorta el catálogo y separa abiertos de totales', async () => {
    const res = await adminC.get('/api/dashboard/by-department');
    const total = db.prepare('SELECT COUNT(*) AS n FROM departments').get().n;
    assert.equal(res.body.data.length, total, 'no debe recortar el catálogo de departamentos');
  });

  it('el listado con ?department=<id>&active=1 devuelve los mismos tickets que la fila', async () => {
    const departmentId = 2;
    const before = (await adminC.get('/api/dashboard/by-department')).body.data.find((r) => r.id === departmentId);

    const fresh = await newTicket({ department_id: departmentId });
    const closed = await newTicket({ department_id: departmentId });
    await adminC.post(`/api/tickets/${closed.id}/resolve`, { resolution: 'Resuelto de prueba' });
    await adminC.post(`/api/tickets/${closed.id}/close`, {});

    const after = (await adminC.get('/api/dashboard/by-department')).body.data.find((r) => r.id === departmentId);
    assert.equal(after.n - before.n, 2);
    assert.equal(after.open - before.open, 1, 'el cerrado no cuenta como abierto');

    const list = await adminC.get(`/api/tickets?department=${departmentId}&active=1&perPage=100`);
    assert.equal(list.body.total, after.open);
    assert.ok(list.body.data.some((t) => t.id === fresh.id));
    assert.ok(!list.body.data.some((t) => t.id === closed.id));
  });
});

describe('Dashboard · navegación por técnico', () => {
  it('el listado con ?assigned=<id>&active=1 devuelve los mismos tickets que la carga', async () => {
    // El técnico tiene que tener carga para tener fila: /by-technician solo
    // devuelve a quien tiene tickets no terminales asignados.
    const assigned = await newTicket();
    await adminC.patch(`/api/tickets/${assigned.id}`, { assigned_to_id: techId });

    const res = await adminC.get('/api/dashboard/by-technician');
    assert.equal(res.status, 200);
    const row = res.body.data.find((r) => r.id === techId);
    assert.ok(row, 'el técnico con carga debe aparecer en el reparto');

    const list = await adminC.get(`/api/tickets?assigned=${techId}&active=1&perPage=100`);

    assert.equal(list.status, 200);
    assert.equal(list.body.total, row.active, 'la carga del técnico y el listado deben coincidir');
    assert.ok(list.body.data.some((t) => t.id === assigned.id));
  });
});

describe('Dashboard · tickets recientes', () => {
  it('incluye el id del ticket para poder abrir su ficha', async () => {
    const ticket = await newTicket({ title: 'Reciente navegable' });

    const res = await adminC.get('/api/dashboard/recent');
    assert.equal(res.status, 200);
    const row = res.body.data.find((r) => r.id === ticket.id);
    assert.ok(row, 'el ticket recién creado debe aparecer en el listado de recientes');

    // El id tiene que ser el real: con `undefined` el enlace del panel llevaba a
    // /api/tickets/undefined.
    assert.ok(isNumber(row.id), 'debe traer el id numérico del ticket');
    const detail = await adminC.get(`/api/tickets/${row.id}`);
    assert.equal(detail.status, 200, 'el id del panel debe abrir una ficha real');
    assert.equal(detail.body.ticket.id, ticket.id);
  });

  it('incluye el técnico asignado y el reportante, con guion cuando no hay dueño', async () => {
    const orphan = await newTicket({ title: 'Reciente sin dueño' });
    const taken = await newTicket({ title: 'Reciente con dueño' });
    await adminC.patch(`/api/tickets/${taken.id}`, { assigned_to_id: techId });

    const res = await adminC.get('/api/dashboard/recent');
    const withOwner = res.body.data.find((r) => r.id === taken.id);
    const without = res.body.data.find((r) => r.id === orphan.id);

    assert.equal(withOwner.assigned_name, 'Navegación Técnico');
    assert.ok(withOwner.reporter_name, 'debe seguir trayendo el reportante');
    // Sin dueño no hay fila en el LEFT JOIN: se devuelve null y la UI lo pinta
    // como guion, sin tener que pedir otro endpoint.
    assert.equal(without.assigned_name, null);
  });

  it('conserva categoría, prioridad, estado y fecha de creación', async () => {
    const res = await adminC.get('/api/dashboard/recent');
    const row = res.body.data[0];
    assert.ok(row.ticket_number, 'debe traer el número de ticket');
    assert.ok(row.title, 'debe traer el título');
    assert.ok(row.status, 'debe traer el estado');
    assert.ok(row.priority, 'debe traer la prioridad');
    assert.ok(row.created_at, 'debe traer la fecha de creación');
  });
});

describe('Dashboard · tendencia de 14 días', () => {
  it('devuelve 14 puntos y los que no registraron actividad van a cero', async () => {
    const res = await adminC.get('/api/dashboard/trend?range=day');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 14, 'la gráfica de 14 días necesita 14 puntos');

    const today = new Date().toISOString().slice(0, 10);
    const point = res.body.data.find((d) => d.label === today);
    assert.ok(point, 'debe incluir el día de hoy');

    // Un día sin actividad vale 0 en ambos contadores, no null ni negativo: es lo
    // que permite a la UI distinguir "no se registró nada" y pintar el estado
    // vacío en vez de una gráfica plana.
    for (const d of res.body.data) {
      assert.ok(Number.isInteger(d.created) && d.created >= 0, `${d.label}: created debe ser un entero >= 0`);
      assert.ok(Number.isInteger(d.resolved) && d.resolved >= 0, `${d.label}: resolved debe ser un entero >= 0`);
    }
  });
});