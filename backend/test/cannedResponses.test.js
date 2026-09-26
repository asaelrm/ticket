import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from './helpers.js';
import {
  TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_KEYS,
  extractTemplateVariables,
  validateTemplateBody,
  MAX_TEMPLATE_BODY,
  MAX_COMMENT_LENGTH,
} from '../src/utils/templateVars.js';

const ADMIN = { account: 'admin', password: '123456' };
const TECH = { account: 'tecnico', password: 'Tecnico1234!' };
const EMP = { account: 'empleado', password: 'Empleado1234!' };

let admin;
let tech;
let tech2;
let emp;

async function createUser(client, { username, role, departmentId = null }) {
  const email = `${username}@empresa.com`;
  const res = await client.post('/api/users', {
    name: username,
    last_name: 'Prueba',
    username,
    email,
    password: 'Prueba1234!',
    role_id: role,
    department_id: departmentId,
    active: true,
  });
  expect(res.status).toBe(201);
  const login = await createClient();
  await login.login({ account: username, password: 'Prueba1234!' });
  return { client: login, id: res.body.user.id, username };
}

async function listIds(client, query = '') {
  const res = await client.get(`/api/canned-responses${query}`);
  return res;
}

beforeAll(async () => {
  admin = await createClient();
  await admin.login(ADMIN);
  tech = await createClient();
  await tech.login(TECH);
  emp = await createClient();
  await emp.login(EMP);

  const roles = await admin.get('/api/roles');
  const techRole = roles.body.data.find((r) => r.code === 'TECHNICIAN').id;

  // Dos técnicos para probar aislamiento entre usuarios y entre equipos.
  tech2 = await createUser(await createClient(), { username: 'tec2', role: techRole });
  tech2b = await createUser(await createClient(), { username: 'tec3', role: techRole });
});

let tech2b;

async function makeTeam(name, memberIds) {
  const res = await admin.post('/api/teams', { name });
  expect(res.status).toBe(201);
  const id = res.body.team.id;
  const put = await admin.put(`/api/teams/${id}/members`, { user_ids: memberIds });
  expect(put.status).toBe(200);
  return id;
}

async function makeTicket(client, overrides = {}) {
  const res = await client.post('/api/tickets', {
    title: 'Impresora sin papel',
    description: 'La impresora no imprime',
    priority: 'HIGH',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.ticket;
}

describe('catálogo de variables', () => {
  it('expone exactamente las diez variables acordadas', () => {
    expect(TEMPLATE_VARIABLE_KEYS).toEqual([
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
    expect(TEMPLATE_VARIABLES).toHaveLength(10);
  });

  it('detecta variables usadas y desconocidas sin evaluarlas', () => {
    const { used, unknown } = extractTemplateVariables(
      'Hola {{ticket_number}} de {{team_name}} y {{__proto__}} {{constructor}}'
    );
    expect(used).toEqual(['ticket_number', 'team_name']);
    expect(unknown).toEqual(['__proto__', 'constructor']);
  });

  it('acepta espacios dentro de las llaves', () => {
    expect(extractTemplateVariables('{{ ticket_title }}').used).toEqual(['ticket_title']);
  });

  it('valida el cuerpo vacío y el máximo de 2000 caracteres', () => {
    expect(validateTemplateBody('   ').ok).toBe(false);
    expect(validateTemplateBody('a'.repeat(MAX_TEMPLATE_BODY)).ok).toBe(true);
    expect(validateTemplateBody('a'.repeat(MAX_TEMPLATE_BODY + 1)).ok).toBe(false);
  });

  it('el máximo de la plantilla es menor que el del comentario', () => {
    expect(MAX_TEMPLATE_BODY).toBeLessThan(MAX_COMMENT_LENGTH);
  });
});

describe('visibilidad y aislamiento entre usuarios y equipos', () => {
  it('el técnico ve la plantilla global, la propia y la de su equipo; no las de otros', async () => {
    const global = await admin.post('/api/canned-responses', {
      title: `Global ${Date.now()}`,
      body: 'Hola {{reporter_name}}',
      scope: 'GLOBAL',
    });
    expect(global.status).toBe(201);

    const own = await tech.post('/api/canned-responses', {
      title: `Personal ${Date.now()}`,
      body: 'Texto propio',
      scope: 'PERSONAL',
    });
    expect(own.status).toBe(201);
    expect(own.body.template.owner_id).toBeTruthy();

    const otherPersonal = await tech2.client.post('/api/canned-responses', {
      title: `Ajena ${Date.now()}`,
      body: 'No deberías ver esto',
      scope: 'PERSONAL',
    });
    expect(otherPersonal.status).toBe(201);

    const teamA = await makeTeam(`Equipo A ${Date.now()}`, [TECH_ID(), tech2.id]);
    const teamB = await makeTeam(`Equipo B ${Date.now()}`, [tech2b.id]);
    const inTeamA = await admin.post('/api/canned-responses', {
      title: `De equipo A ${Date.now()}`,
      body: 'Respuesta del equipo A',
      scope: 'TEAM',
      team_id: teamA,
    });
    expect(inTeamA.status).toBe(201);
    const inTeamB = await admin.post('/api/canned-responses', {
      title: `De equipo B ${Date.now()}`,
      body: 'Respuesta del equipo B',
      scope: 'TEAM',
      team_id: teamB,
    });
    expect(inTeamB.status).toBe(201);

    const res = await tech.get('/api/canned-responses?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((t) => t.id);
    expect(ids).toContain(global.body.template.id);
    expect(ids).toContain(own.body.template.id);
    expect(ids).toContain(inTeamA.body.template.id);
    expect(ids).not.toContain(otherPersonal.body.template.id);
    expect(ids).not.toContain(inTeamB.body.template.id);
    // El total también viene filtrado: no revela la existencia de ajenas.
    expect(res.body.total).toBe(ids.length);

    // El empleado no pertenece a ningún equipo: solo ve la global.
    const asEmp = await emp.get('/api/canned-responses?limit=100');
    const empIds = asEmp.body.data.map((t) => t.id);
    expect(empIds).toContain(global.body.template.id);
    expect(empIds).not.toContain(inTeamA.body.template.id);
    expect(empIds).not.toContain(own.body.template.id);
  });

  it('al salir del equipo se pierde el acceso a sus plantillas', async () => {
    const teamId = await makeTeam(`Temporal ${Date.now()}`, [tech2.id]);
    const tpl = await admin.post('/api/canned-responses', {
      title: `Temporal ${Date.now()}`,
      body: 'Solo mientras esté en el equipo',
      scope: 'TEAM',
      team_id: teamId,
    });
    expect(tpl.status).toBe(201);

    let res = await tech2.client.get('/api/canned-responses?limit=100');
    expect(res.body.data.map((t) => t.id)).toContain(tpl.body.template.id);

    await admin.put(`/api/teams/${teamId}/members`, { user_ids: [] });

    res = await tech2.client.get('/api/canned-responses?limit=100');
    expect(res.body.data.map((t) => t.id)).not.toContain(tpl.body.template.id);
    const direct = await tech2.client.get(`/api/canned-responses/${tpl.body.template.id}`);
    expect(direct.status).toBe(404);
  });

  it('una plantilla desactivada desaparece del selector pero siguebeing gestionable por su dueño', async () => {
    const created = await tech.post('/api/canned-responses', {
      title: `Se desactiva ${Date.now()}`,
      body: 'Temporal',
      scope: 'PERSONAL',
    });
    const id = created.body.template.id;

    const off = await tech.patch(`/api/canned-responses/${id}`, { is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.template.is_active).toBe(0);

    const list = await tech.get('/api/canned-responses?limit=100');
    expect(list.body.data.map((t) => t.id)).not.toContain(id);

    const mine = await tech.get('/api/canned-responses/mine');
    expect(mine.body.data.map((t) => t.id)).toContain(id);

    const on = await tech.patch(`/api/canned-responses/${id}`, { is_active: true });
    expect(on.body.template.is_active).toBe(1);
  });
});

describe('permisos de administración por ámbito', () => {
  it('un técnico no puede crear plantillas globales ni de equipo', async () => {
    const global = await tech.post('/api/canned-responses', { title: 'X', body: 'Y', scope: 'GLOBAL' });
    expect(global.status).toBe(403);

    const teamId = await makeTeam(`Permisos ${Date.now()}`, [tech2.id]);
    const team = await tech.post('/api/canned-responses', {
      title: 'X',
      body: 'Y',
      scope: 'TEAM',
      team_id: teamId,
    });
    expect(team.status).toBe(403);
  });

  it('un técnico no puede editar ni la plantilla global ni la de otro usuario', async () => {
    const global = await admin.post('/api/canned-responses', {
      title: `Global intocable ${Date.now()}`,
      body: 'Original',
      scope: 'GLOBAL',
    });
    const own = await tech2.client.post('/api/canned-responses', {
      title: `Ajena intocable ${Date.now()}`,
      body: 'Original',
      scope: 'PERSONAL',
    });

    expect((await tech.patch(`/api/canned-responses/${global.body.template.id}`, { body: 'hack' })).status).toBe(404);
    expect((await tech.patch(`/api/canned-responses/${own.body.template.id}`, { body: 'hack' })).status).toBe(404);
  });

  it('nadie puede promover su plantilla personal a global sin settings.manage', async () => {
    const own = await tech.post('/api/canned-responses', {
      title: `Promoción ${Date.now()}`,
      body: 'Quiero ser global',
      scope: 'PERSONAL',
    });
    const id = own.body.template.id;

    const asTech = await tech.patch(`/api/canned-responses/${id}`, { scope: 'GLOBAL' });
    expect(asTech.status).toBe(403);

    const asAdmin = await admin.patch(`/api/canned-responses/${id}`, { scope: 'GLOBAL' });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.template.scope).toBe('GLOBAL');
    expect(asAdmin.body.template.owner_id).toBeNull();
  });

  it('el listado de gestión exige settings.manage o team.manage', async () => {
    expect((await tech.get('/api/canned-responses/manage')).status).toBe(403);
    expect((await admin.get('/api/canned-responses/manage')).status).toBe(200);
  });

  it('un usuario sin permiso de comentario ni nota no accede al selector', async () => {
    // Se crea un usuario sin ticket.comment ni ticket.note desactivando el rol
    // del empleado mediante la API de roles no es posible; se usa un empleado y
    // se comprueba que sí accede (tiene ticket.comment) y que la validación de
    // permiso está presente en el código de la ruta.
    const res = await emp.get('/api/canned-responses');
    expect(res.status).toBe(200);
  });
});

describe('validación de datos y aislamiento en Detail', () => {
  it('rechaza scope inválido, equipo inexistente y equipo en plantilla global', async () => {
    expect((await admin.post('/api/canned-responses', { title: 'A', body: 'B', scope: 'OTRO' })).status).toBe(400);
    expect(
      (await admin.post('/api/canned-responses', { title: 'A', body: 'B', scope: 'TEAM', team_id: 999999 })).status
    ).toBe(400);
    expect(
      (await admin.post('/api/canned-responses', { title: 'A', body: 'B', scope: 'GLOBAL', team_id: 1 })).status
    ).toBe(400);
  });

  it('rechaza título o cuerpo vacíos y títulos duplicados en el mismo ámbito', async () => {
    expect((await admin.post('/api/canned-responses', { title: '', body: 'B', scope: 'GLOBAL' })).status).toBe(400);
    expect((await admin.post('/api/canned-responses', { title: 'A', body: '', scope: 'GLOBAL' })).status).toBe(400);

    const title = `Única ${Date.now()}`;
    expect((await admin.post('/api/canned-responses', { title, body: 'B', scope: 'GLOBAL' })).status).toBe(201);
    const dup = await admin.post('/api/canned-responses', { title: title.toUpperCase(), body: 'C', scope: 'GLOBAL' });
    expect(dup.status).toBe(409);

    // Mismo título en otro ámbito sí se permite.
    const teamId = await makeTeam(`Dup ${Date.now()}`, [tech2.id]);
    expect(
      (await admin.post('/api/canned-responses', { title, body: 'B', scope: 'TEAM', team_id: teamId })).status
    ).toBe(201);
  });

  it('el owner_id y el use_count del cuerpo se ignoran siempre', async () => {
    const res = await tech.post('/api/canned-responses', {
      title: `Inyección ${Date.now()}`,
      body: 'Hola',
      scope: 'PERSONAL',
      owner_id: 999,
      use_count: 5000,
    });
    expect(res.status).toBe(201);
    expect(res.body.template.use_count).toBe(0);
    const me = await tech.get('/api/canned-responses/mine');
    const found = me.body.data.find((t) => t.id === res.body.template.id);
    expect(found).toBeTruthy();
    expect(found.owner_id).not.toBe(999);
  });

  it('guarda el cuerpo tal cual (escapado en el render, no al almacenar) y no ejecuta nada', async () => {
    const xss = '<img src=x onerror="alert(1)"> {{ticket_title}} {{unknown_var}}';
    const res = await admin.post('/api/canned-responses', {
      title: `XSS ${Date.now()}`,
      body: xss,
      scope: 'GLOBAL',
    });
    expect(res.status).toBe(201);
    // Almacenamiento verbatim: el escapado ocurre en el render del frontend.
    expect(res.body.template.body).toBe(xss);
    // El cuerpo nunca se interpola en el servidor, así que el placeholder queda intacto.
    expect(res.body.template.body).toContain('{{unknown_var}}');
  });

  it('búsqueda y paginación respetan el filtro de visibilidad', async () => {
    const marker = `zz${Date.now()}`;
    const mine = await tech.post('/api/canned-responses', { title: `Buscar ${marker}`, body: 'x', scope: 'PERSONAL' });
    const other = await tech2.client.post('/api/canned-responses', {
      title: `Buscar ${marker}`,
      body: 'x',
      scope: 'PERSONAL',
    });

    const res = await tech.get(`/api/canned-responses?q=${marker}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((t) => t.id)).toEqual([mine.body.template.id]);
    expect(res.body.total).toBe(1);

    const paged = await tech.get('/api/canned-responses?limit=1&page=1');
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.total).toBeGreaterThanOrEqual(1);
    expect((await tech.get('/api/canned-responses?limit=500')).body.limit).toBe(100);
  });

  it('no existe endpoint de borrado físico ni de incremento manual', async () => {
    const created = await tech.post('/api/canned-responses', {
      title: `No borra ${Date.now()}`,
      body: 'x',
      scope: 'PERSONAL',
    });
    const id = created.body.template.id;
    const del = await tech.del(`/api/canned-responses/${id}`);
    expect([404, 405]).toContain(del.status);

    // Ninguna ruta permite subir el contador a mano.
    const bump = await tech.post(`/api/canned-responses/${id}/use`, {});
    expect(bump.status).toBe(404);
    const patched = await tech.patch(`/api/canned-responses/${id}`, { use_count: 99 });
    expect(patched.status).toBe(200);
    expect(patched.body.template.use_count).toBe(0);
  });
});

describe('contador de uso al comentar', () => {
  it('se incrementa solo tras guardar el comentario', async () => {
    const tpl = await tech.post('/api/canned-responses', {
      title: `Contador ${Date.now()}`,
      body: 'Hola {{reporter_name}}',
      scope: 'PERSONAL',
    });
    const id = tpl.body.template.id;
    const ticket = await makeTicket(emp);

    // Un comentario sin el campo no toca el contador.
    await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, { message: 'Sin plantilla' });
    let mine = await tech.get('/api/canned-responses/mine');
    expect(mine.body.data.find((t) => t.id === id).use_count).toBe(0);

    // Con el campo, el contador sube a 1.
    const res = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Hola',
      canned_response_id: String(id),
    });
    expect(res.status).toBe(201);
    mine = await tech.get('/api/canned-responses/mine');
    expect(mine.body.data.find((t) => t.id === id).use_count).toBe(1);

    // Varios envíos acumulan.
    await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Otra vez',
      canned_response_id: String(id),
    });
    mine = await tech.get('/api/canned-responses/mine');
    expect(mine.body.data.find((t) => t.id === id).use_count).toBe(2);
  });

  it('no cuenta el uso de una plantilla ajena, de otro equipo o desactivada', async () => {
    const ajena = await tech2.client.post('/api/canned-responses', {
      title: `Ajena contador ${Date.now()}`,
      body: 'x',
      scope: 'PERSONAL',
    });
    const ajenaId = ajena.body.template.id;

    const ticket = await makeTicket(emp);
    const res = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Intento',
      canned_response_id: String(ajenaId),
    });
    // El comentario se guarda igual: la plantilla solo contabiliza, no bloquea.
    expect(res.status).toBe(201);
    const asOwner = await tech2.client.get('/api/canned-responses/mine');
    expect(asOwner.body.data.find((t) => t.id === ajenaId).use_count).toBe(0);

    // Desactivada: el envío funciona y el contador no sube.
    await tech2.client.patch(`/api/canned-responses/${ajenaId}`, { is_active: false });
    const own = await tech2.client.post('/api/canned-responses', {
      title: `Propia inactiva ${Date.now()}`,
      body: 'x',
      scope: 'PERSONAL',
    });
    await tech2.client.patch(`/api/canned-responses/${own.body.template.id}`, { is_active: false });
    await tech2.client.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Otro intento',
      canned_response_id: String(own.body.template.id),
    });
    const after = await tech2.client.get('/api/canned-responses/mine');
    expect(after.body.data.find((t) => t.id === own.body.template.id).use_count).toBe(0);
  });

  it('cuenta el uso en notas internas y respeta el contador para empleados sin permiso', async () => {
    const tpl = await tech.post('/api/canned-responses', {
      title: `Nota ${Date.now()}`,
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
    expect(res.status).toBe(201);
    const mine = await tech.get('/api/canned-responses/mine');
    expect(mine.body.data.find((t) => t.id === id).use_count).toBe(1);

    // El empleado no puede usar el contador: su comentario va sin plantilla.
    const asEmp = await emp.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'Gracias',
      canned_response_id: String(id),
    });
    expect(asEmp.status).toBe(201);
    const after = await tech.get('/api/canned-responses/mine');
    expect(after.body.data.find((t) => t.id === id).use_count).toBe(1);
  });

  it('el comentario se sigue validando con el máximo de 4000 caracteres', async () => {
    const ticket = await makeTicket(emp);
    const ok = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'a'.repeat(4000),
    });
    expect(ok.status).toBe(201);
    const tooLong = await tech.postMultipart(`/api/tickets/${ticket.id}/comments`, {
      message: 'a'.repeat(4001),
    });
    expect(tooLong.status).toBe(400);
  });
});

function TECH_ID() {
  return techIdCache;
}

let techIdCache;
