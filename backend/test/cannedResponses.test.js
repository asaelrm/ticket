import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import {
  TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_KEYS,
  extractTemplateVariables,
  validateTemplateBody,
  MAX_TEMPLATE_BODY,
  MAX_COMMENT_LENGTH,
} from '../src/utils/templateVars.js';

const PASSWORD = 'Prueba1234!';

let admin;
let tech;
let techId;
let tech2;
let tech2Id;
let emp;
let empRoleId;
let techRoleId;

let seq = 0;
const uniq = (prefix) => `${prefix} ${Date.now()}-${seq++}`;

async function createUser({ username, roleId }) {
  const res = await admin.post('/api/users', {
    name: username,
    last_name: 'Prueba',
    username,
    email: `${username}@empresa.com`,
    password: PASSWORD,
    role_id: roleId,
    active: true,
  });
  assert.equal(res.status, 201);
  const client = createClient();
  await client.login(username, PASSWORD);
  return { client, id: res.body.user.id };
}

async function makeTeam(name, memberIds) {
  const res = await admin.post('/api/teams', { name });
  assert.equal(res.status, 201);
  const id = res.body.team.id;
  const put = await admin.put(`/api/teams/${id}/members`, { user_ids: memberIds });
  assert.equal(put.status, 200);
  return id;
}

async function makeTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: 'Impresora sin papel',
    description: 'La impresora no imprime',
    category_id: 1,
    priority: 'HIGH',
    ...over,
  });
  assert.equal(res.status, 201);
  return res.body.ticket;
}

before(async () => {
  admin = createClient();
  await admin.login('admin', '123456');
  tech = createClient();
  await tech.login('tecnico', 'Tecnico1234!');
  emp = createClient();
  await emp.login('empleado', 'Empleado1234!');

  techId = (await tech.get('/api/auth/me')).body.user.id;
  const roles = (await admin.get('/api/roles')).body.roles;
  const techRole = roles.find((r) => r.code === 'TECHNICIAN').id;
  techRoleId = techRole;
  empRoleId = roles.find((r) => r.code === 'EMPLOYEE').id;

  tech2 = await createUser({ username: `tec${Date.now() % 100000}`, roleId: techRole });
  tech2Id = tech2.id;
});

describe('catálogo de variables', () => {
  it('expone exactamente las diez variables acordadas', () => {
    assert.deepEqual(TEMPLATE_VARIABLE_KEYS, [
      'ticket_number',
      'ticket_title',
      'reporter_name',
      'ticket_status',
      'ticket_priority',
      'category_name',
      'department_name',
      'team_name',
      'technician_name',
      'sla_due',
    ]);
    assert.equal(TEMPLATE_VARIABLES.length, 10);
  });

  it('detecta variables usadas y desconocidas sin evaluarlas', () => {
    const { used, unknown } = extractTemplateVariables(
      'Hola {{ticket_number}} de {{team_name}} y {{__proto__}} {{constructor}}'
    );
    assert.deepEqual(used, ['ticket_number', 'team_name']);
    assert.deepEqual(unknown, ['__proto__', 'constructor']);
  });

  it('acepta espacios dentro de las llaves', () => {
    assert.deepEqual(extractTemplateVariables('{{ ticket_title }}').used, ['ticket_title']);
  });

  it('valida el cuerpo vacío y el máximo de 2000 caracteres', () => {
    assert.equal(validateTemplateBody('   ').ok, false);
    assert.equal(validateTemplateBody('a'.repeat(MAX_TEMPLATE_BODY)).ok, true);
    assert.equal(validateTemplateBody('a'.repeat(MAX_TEMPLATE_BODY + 1)).ok, false);
  });

  it('el máximo de la plantilla es menor que el del comentario', () => {
    assert.ok(MAX_TEMPLATE_BODY < MAX_COMMENT_LENGTH);
  });
});

describe('visibilidad y aislamiento entre usuarios y equipos', () => {
  it('el técnico ve la global, la propia y la de su equipo; no las de otros', async () => {
    const global = await admin.post('/api/canned-responses', {
      title: uniq('Global'),
      body: 'Hola {{reporter_name}}',
      scope: 'GLOBAL',
    });
    assert.equal(global.status, 201);

    const own = await tech.post('/api/canned-responses', {
      title: uniq('Personal'),
      body: 'Texto propio',
      scope: 'PERSONAL',
    });
    assert.equal(own.status, 201);

    const otherPersonal = await tech2.client.post('/api/canned-responses', {
      title: uniq('Ajena'),
      body: 'No deberías ver esto',
      scope: 'PERSONAL',
    });
    assert.equal(otherPersonal.status, 201);

    const teamA = await makeTeam(uniq('Equipo A'), [techId]);
    const teamB = await makeTeam(uniq('Equipo B'), [tech2Id]);
    const inTeamA = await admin.post('/api/canned-responses', {
      title: uniq('De equipo A'),
      body: 'Respuesta del equipo A',
      scope: 'TEAM',
      team_id: teamA,
    });
    const inTeamB = await admin.post('/api/canned-responses', {
      title: uniq('De equipo B'),
      body: 'Respuesta del equipo B',
      scope: 'TEAM',
      team_id: teamB,
    });
    assert.equal(inTeamA.status, 201);
    assert.equal(inTeamB.status, 201);

    const res = await tech.get('/api/canned-responses?limit=100');
    assert.equal(res.status, 200);
    const ids = res.body.data.map((t) => t.id);
    assert.ok(ids.includes(global.body.template.id), 'debe ver la global');
    assert.ok(ids.includes(own.body.template.id), 'debe ver la propia');
    assert.ok(ids.includes(inTeamA.body.template.id), 'debe ver la de su equipo');
    assert.ok(!ids.includes(otherPersonal.body.template.id), 'no debe ver la personal ajena');
    assert.ok(!ids.includes(inTeamB.body.template.id), 'no debe ver la de otro equipo');
    // El total también viene filtrado: no revela la existencia de ajenas.
    assert.equal(res.body.total, ids.length);

    // El empleado no pertenece a ningún equipo: solo ve la global.
    const asEmp = await emp.get('/api/canned-responses?limit=100');
    const empIds = asEmp.body.data.map((t) => t.id);
    assert.ok(empIds.includes(global.body.template.id));
    assert.ok(!empIds.includes(inTeamA.body.template.id));
    assert.ok(!empIds.includes(own.body.template.id));
  });

  it('al salir del equipo se pierde el acceso a sus plantillas', async () => {
    const teamId = await makeTeam(uniq('Temporal'), [tech2Id]);
    const tpl = await admin.post('/api/canned-responses', {
      title: uniq('Temporal'),
      body: 'Solo mientras esté en el equipo',
      scope: 'TEAM',
      team_id: teamId,
    });
    assert.equal(tpl.status, 201);
    const id = tpl.body.template.id;

    let res = await tech2.client.get('/api/canned-responses?limit=100');
    assert.ok(res.body.data.map((t) => t.id).includes(id));

    await admin.put(`/api/teams/${teamId}/members`, { user_ids: [] });

    res = await tech2.client.get('/api/canned-responses?limit=100');
    assert.ok(!res.body.data.map((t) => t.id).includes(id));
    assert.equal((await tech2.client.get(`/api/canned-responses/${id}`)).status, 404);
  });

  it('una plantilla desactivada desaparece del selector pero sigue gestionable por su dueño', async () => {
    const created = await tech.post('/api/canned-responses', {
      title: uniq('Se desactiva'),
      body: 'Temporal',
      scope: 'PERSONAL',
    });
    const id = created.body.template.id;

    const off = await tech.patch(`/api/canned-responses/${id}`, { is_active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.template.is_active, 0);

    const list = await tech.get('/api/canned-responses?limit=100');
    assert.ok(!list.body.data.map((t) => t.id).includes(id));

    const mine = await tech.get('/api/canned-responses/mine');
    assert.ok(mine.body.data.map((t) => t.id).includes(id));

    const on = await tech.patch(`/api/canned-responses/${id}`, { is_active: true });
    assert.equal(on.body.template.is_active, 1);
  });
});

describe('permisos de administración por ámbito', () => {
  it('un técnico no puede crear plantillas globales ni de equipo', async () => {
    const global = await tech.post('/api/canned-responses', { title: 'X', body: 'Y', scope: 'GLOBAL' });
    assert.equal(global.status, 403);
    const teamId = await makeTeam(uniq('Permisos'), [tech2Id]);
    const team = await tech.post('/api/canned-responses', { title: 'X', body: 'Y', scope: 'TEAM', team_id: teamId });
    assert.equal(team.status, 403);
  });

  it('un técnico no puede editar la global ni la personal ajena (404, no 403)', async () => {
    const global = await admin.post('/api/canned-responses', {
      title: uniq('Global intocable'),
      body: 'Original',
      scope: 'GLOBAL',
    });
    const other = await tech2.client.post('/api/canned-responses', {
      title: uniq('Ajena intocable'),
      body: 'Original',
      scope: 'PERSONAL',
    });

    assert.equal((await tech.patch(`/api/canned-responses/${global.body.template.id}`, { body: 'hack' })).status, 404);
    assert.equal((await tech.patch(`/api/canned-responses/${other.body.template.id}`, { body: 'hack' })).status, 404);
    assert.equal((await tech.get(`/api/canned-responses/${other.body.template.id}`)).status, 404);
  });

  it('nadie puede promover su plantilla personal a global sin settings.manage', async () => {
    const own = await tech.post('/api/canned-responses', {
      title: uniq('Promoción'),
      body: 'Quiero ser global',
      scope: 'PERSONAL',
    });
    const id = own.body.template.id;

    assert.equal((await tech.patch(`/api/canned-responses/${id}`, { scope: 'GLOBAL' })).status, 403);

    const asAdmin = await admin.patch(`/api/canned-responses/${id}`, { scope: 'GLOBAL' });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.body.template.scope, 'GLOBAL');
    assert.equal(asAdmin.body.template.owner_id, null);
  });

  it('el listado de gestión exige settings.manage o team.manage', async () => {
    assert.equal((await tech.get('/api/canned-responses/manage')).status, 403);
    assert.equal((await admin.get('/api/canned-responses/manage')).status, 200);
  });

  it('sin ticket.comment ni ticket.note no hay acceso al selector ni creación', async () => {
    const roles = (await admin.get('/api/roles')).body.roles;
    const original = roles.find((r) => r.id === empRoleId).permissions;
    try {
      const patch = await admin.patch(`/api/roles/${empRoleId}/permissions`, {
        permissions: original.filter((c) => c !== 'ticket.comment'),
      });
      assert.equal(patch.status, 200);

      assert.equal((await emp.get('/api/canned-responses')).status, 403);
      assert.equal((await emp.get('/api/canned-responses/mine')).status, 403);
      const create = await emp.post('/api/canned-responses', { title: 'X', body: 'Y', scope: 'PERSONAL' });
      assert.equal(create.status, 403);
    } finally {
      await admin.patch(`/api/roles/${empRoleId}/permissions`, { permissions: original });
    }
    assert.equal((await emp.get('/api/canned-responses')).status, 200);
  });
});

describe('validación de datos', () => {
  it('rechaza scope inválido, equipo inexistente y equipo en plantilla global', async () => {
    assert.equal((await admin.post('/api/canned-responses', { title: 'A', body: 'B', scope: 'OTRO' })).status, 400);
    const badTeam = await admin.post('/api/canned-responses', { title: 'A', body: 'B', scope: 'TEAM', team_id: 999999 });
    assert.equal(badTeam.status, 400);
    const globalWithTeam = await admin.post('/api/canned-responses', {
      title: 'A',
      body: 'B',
      scope: 'GLOBAL',
      team_id: 1,
    });
    assert.equal(globalWithTeam.status, 400);
  });

  it('rechaza título o cuerpo vacíos y títulos duplicados en el mismo ámbito', async () => {
    assert.equal((await admin.post('/api/canned-responses', { title: '', body: 'B', scope: 'GLOBAL' })).status, 400);
    assert.equal((await admin.post('/api/canned-responses', { title: 'A', body: '', scope: 'GLOBAL' })).status, 400);

    const title = uniq('Única');
    assert.equal((await admin.post('/api/canned-responses', { title, body: 'B', scope: 'GLOBAL' })).status, 201);
    const dup = await admin.post('/api/canned-responses', { title: title.toUpperCase(), body: 'C', scope: 'GLOBAL' });
    assert.equal(dup.status, 409);

    // Mismo título en otro ámbito sí se permite.
    const teamId = await makeTeam(uniq('Dup'), [tech2Id]);
    const inTeam = await admin.post('/api/canned-responses', { title, body: 'B', scope: 'TEAM', team_id: teamId });
    assert.equal(inTeam.status, 201);
  });

  it('el owner_id y el use_count del cuerpo se ignoran siempre', async () => {
    const res = await tech.post('/api/canned-responses', {
      title: uniq('Inyección'),
      body: 'Hola',
      scope: 'PERSONAL',
      owner_id: 999999,
      use_count: 5000,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.template.use_count, 0);

    const me = await tech.get('/api/canned-responses/mine');
    const found = me.body.data.find((t) => t.id === res.body.template.id);
    assert.ok(found);
    assert.equal(found.owner_id, techId);
  });

  it('guarda el cuerpo verbatim: el escapado ocurre al renderizar, no al almacenar', async () => {
    const xss = '<img src=x onerror="alert(1)"> {{ticket_title}} {{unknown_var}}';
    const res = await admin.post('/api/canned-responses', { title: uniq('XSS'), body: xss, scope: 'GLOBAL' });
    assert.equal(res.status, 201);
    assert.equal(res.body.template.body, xss);
    // El servidor nunca interpola: el placeholder desconocido queda intacto.
    assert.ok(res.body.template.body.includes('{{unknown_var}}'));
  });

  it('búsqueda y paginación respetan el filtro de visibilidad', async () => {
    const marker = `zz${Date.now()}${seq++}`;
    const mine = await tech.post('/api/canned-responses', { title: `Buscar ${marker}`, body: 'x', scope: 'PERSONAL' });
    await tech2.client.post('/api/canned-responses', { title: `Buscar ${marker}`, body: 'x', scope: 'PERSONAL' });

    const res = await tech.get(`/api/canned-responses?q=${marker}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((t) => t.id), [mine.body.template.id]);
    assert.equal(res.body.total, 1);

    const paged = await tech.get('/api/canned-responses?limit=1&page=1');
    assert.equal(paged.body.data.length, 1);
    assert.equal(paged.body.limit, 1);
    assert.equal((await tech.get('/api/canned-responses?limit=500')).body.limit, 100);
  });

  it('no existe borrado físico ni incremento manual del contador', async () => {
    const created = await tech.post('/api/canned-responses', {
      title: uniq('No borra'),
      body: 'x',
      scope: 'PERSONAL',
    });
    const id = created.body.template.id;

    const del = await tech.del(`/api/canned-responses/${id}`);
    assert.ok(del.status === 404 || del.status === 405, `borrado debe fallar, llegó ${del.status}`);
    assert.equal((await tech.post(`/api/canned-responses/${id}/use`, {})).status, 404);

    const patched = await tech.patch(`/api/canned-responses/${id}`, { use_count: 99 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.template.use_count, 0);
  });
});

describe('contador de uso al comentar', () => {
  it('se incrementa solo tras guardar el comentario', async () => {
    const tpl = await tech.post('/api/canned-responses', {
      title: uniq('Contador'),
      body: 'Hola {{reporter_name}}',
      scope: 'PERSONAL',
    });
    const id = tpl.body.template.id;
    const ticket = await makeTicket(emp);

    // Un comentario sin el campo no toca el contador.
    await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, { message: 'Sin plantilla' });
    let mine = await tech.get('/api/canned-responses/mine');
    assert.equal(mine.body.data.find((t) => t.id === id).use_count, 0);

    const res = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Hola',
      canned_response_id: String(id),
    });
    assert.equal(res.status, 201);
    mine = await tech.get('/api/canned-responses/mine');
    assert.equal(mine.body.data.find((t) => t.id === id).use_count, 1);

    await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Otra vez',
      canned_response_id: String(id),
    });
    mine = await tech.get('/api/canned-responses/mine');
    assert.equal(mine.body.data.find((t) => t.id === id).use_count, 2);
  });

  it('no cuenta una plantilla ajena ni una desactivada, y el comentario se guarda igual', async () => {
    const ajena = await tech2.client.post('/api/canned-responses', {
      title: uniq('Ajena contador'),
      body: 'x',
      scope: 'PERSONAL',
    });
    const ajenaId = ajena.body.template.id;
    const ticket = await makeTicket(emp);

    const res = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Intento',
      canned_response_id: String(ajenaId),
    });
    assert.equal(res.status, 201);
    const asOwner = await tech2.client.get('/api/canned-responses/mine');
    assert.equal(asOwner.body.data.find((t) => t.id === ajenaId).use_count, 0);

    const own = await tech2.client.post('/api/canned-responses', {
      title: uniq('Propia inactiva'),
      body: 'x',
      scope: 'PERSONAL',
    });
    await tech2.client.patch(`/api/canned-responses/${own.body.template.id}`, { is_active: false });
    const off = await tech2.client.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Otro intento',
      canned_response_id: String(own.body.template.id),
    });
    assert.equal(off.status, 201);
    const after = await tech2.client.get('/api/canned-responses/mine');
    assert.equal(after.body.data.find((t) => t.id === own.body.template.id).use_count, 0);
  });

  it('cuenta el uso en notas internas', async () => {
    const tpl = await tech.post('/api/canned-responses', {
      title: uniq('Nota'),
      body: 'Revisado internamente',
      scope: 'PERSONAL',
    });
    const id = tpl.body.template.id;
    const ticket = await makeTicket(emp);

    const res = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Nota interna',
      is_internal: '1',
      canned_response_id: String(id),
    });
    assert.equal(res.status, 201);
    const mine = await tech.get('/api/canned-responses/mine');
    assert.equal(mine.body.data.find((t) => t.id === id).use_count, 1);
  });

  it('el envío normal sigue validando el máximo de 4000 caracteres', async () => {
    const ticket = await makeTicket(emp);
    const ok = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, { message: 'a'.repeat(4000) });
    assert.equal(ok.status, 201);
    const tooLong = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, { message: 'a'.repeat(4001) });
    assert.equal(tooLong.status, 400);
  });
});
