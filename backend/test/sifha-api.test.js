// Pruebas de la API del catálogo SIFHA SIN base de datos.
//
// El catálogo y la validación de tickets con alcance SIFHA viven en rutas que
// hablan con el runtime SQL. Para poder ejecutarlas en la suite unitaria segura
// (sin SQL Server), este archivo sustituye el módulo del runtime
// (src/db/runtime.js) por un doble en memoria.
//
// El doble replica EXACTAMENTE la superficie pública de la fachada real
// (queryOne, queryMany, execute, insertAndGetId, transaction, close). No añade
// transactionAsync: si la fachada real no lo expone, el doble tampoco, de modo
// que la suite detecta el mismo desajuste que sufriría producción.

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

// La configuración debe estar fijada ANTES de importar la app (imports
// dinámicos al final del archivo).
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'mssql';
const UPLOAD_DIR = path.join(os.tmpdir(), 'sifha-api-unit', String(process.pid));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
process.env.UPLOAD_DIR = UPLOAD_DIR;

// ---------------------------------------------------------------------------
// Doble en memoria
// ---------------------------------------------------------------------------

const ORG_A = 10;
const ORG_B = 20;

const USERS = {
  1: { id: 1, name: 'Super', last_name: 'Global', username: 'super', email: 'super@test', department_id: null, position: null, role_id: 1, active: 1, created_at: '2026-01-01T00:00:00', last_login_at: null, organization_id: null, role_code: 'SUPERADMIN', role_name: 'Superadministrador', department_name: null, organization_name: null, organization_active: null },
  2: { id: 2, name: 'Admin', last_name: 'A', username: 'admin_a', email: 'admin_a@test', department_id: null, position: null, role_id: 2, active: 1, created_at: '2026-01-01T00:00:00', last_login_at: null, organization_id: ORG_A, role_code: 'ADMIN', role_name: 'Administrador', department_name: null, organization_name: 'Empresa A', organization_active: 1 },
  3: { id: 3, name: 'Admin', last_name: 'B', username: 'admin_b', email: 'admin_b@test', department_id: null, position: null, role_id: 2, active: 1, created_at: '2026-01-01T00:00:00', last_login_at: null, organization_id: ORG_B, role_code: 'ADMIN', role_name: 'Administrador', department_name: null, organization_name: 'Empresa B', organization_active: 1 },
  4: { id: 4, name: 'Emp', last_name: 'A', username: 'emp_a', email: 'emp_a@test', department_id: null, position: null, role_id: 3, active: 1, created_at: '2026-01-01T00:00:00', last_login_at: null, organization_id: ORG_A, role_code: 'EMPLOYEE', role_name: 'Empleado', department_name: null, organization_name: 'Empresa A', organization_active: 1 },
};

const ROLE_PERMS = {
  1: ['organization.manage'],
  2: ['organization.manage', 'ticket.create'],
  3: ['ticket.create'],
};

const BASE_ASSIGNMENTS = [
  { organization_id: ORG_A, sifha_system_id: 101, active: 1 },
  { organization_id: ORG_A, sifha_system_id: 103, active: 0 },
  { organization_id: ORG_A, sifha_system_id: 104, active: 0 },
  { organization_id: ORG_B, sifha_system_id: 102, active: 1 },
];

function resetAssignments() {
  db.assignments = BASE_ASSIGNMENTS.map((a) => ({ ...a }));
}

const db = {
  systems: [
    { id: 101, code: 'SAP', name: 'SAP', description: null, active: 1, created_at: '2026-01-01T00:00:00' },
    { id: 102, code: 'CRM', name: 'CRM', description: null, active: 1, created_at: '2026-01-01T00:00:00' },
    { id: 103, code: 'LEGACY', name: 'Producto obsoleto', description: null, active: 0, created_at: '2026-01-01T00:00:00' },
    { id: 104, code: 'NOPE', name: 'Activo pero sin asignación vigente', description: null, active: 1, created_at: '2026-01-01T00:00:00' },
  ],
  assignments: [],
  categories: [],
};
resetAssignments();

function normalize(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

function systemRow(system) {
  return { ...system, enabled: system.active ? 1 : 0 };
}

function activeAssignedSystems(orgId) {
  return db.systems
    .filter((s) => s.active && db.assignments.some((a) => a.organization_id === Number(orgId) && a.sifha_system_id === s.id && a.active))
    .map(systemRow)
    .sort(byName);
}

function unsupported(kind, sql) {
  throw new Error(`El doble de runtime no soporta esta consulta (${kind}): ${normalize(sql)}`);
}

const runtimeStub = {
  async queryOne(sql, ...args) {
    const s = normalize(sql);
    if (/FROM users u JOIN roles r/.test(s)) return USERS[args[0]] ? { ...USERS[args[0]] } : null;
    if (/SELECT id FROM sifha_systems WHERE code = \?/i.test(s)) {
      const found = db.systems.find((x) => x.code === String(args[0]).toUpperCase());
      return found ? { id: found.id } : null;
    }
    if (/SELECT \* FROM sifha_systems WHERE id = \?/i.test(s)) {
      const found = db.systems.find((x) => x.id === Number(args[0]));
      return found ? { ...found } : null;
    }
    if (/SELECT id FROM sifha_systems WHERE id = \?/i.test(s)) {
      const found = db.systems.find((x) => x.id === Number(args[0]));
      return found ? { id: found.id } : null;
    }
    if (/SELECT s\.id FROM sifha_systems s JOIN organization_sifha_systems os/i.test(s)) {
      const [systemId, orgId] = args.map(Number);
      const allowed = db.systems.some((x) => x.id === systemId && x.active)
        && db.assignments.some((a) => a.sifha_system_id === systemId && a.organization_id === orgId && a.active);
      return allowed ? { id: systemId } : null;
    }
    if (/FROM sifha_systems s WHERE s\.id = \?/i.test(s)) {
      const found = db.systems.find((x) => x.id === Number(args[0]));
      return found ? systemRow(found) : null;
    }
    if (/SELECT id FROM categories WHERE id = \? AND organization_id = \?/i.test(s)) {
      const found = db.categories.find((x) => x.id === Number(args[0]) && x.organization_id === Number(args[1]));
      return found ? { id: found.id } : null;
    }
    if (/SELECT id FROM departments WHERE id = \? AND organization_id = \?/i.test(s)) return null;
    return unsupported('queryOne', sql);
  },

  async queryMany(sql, ...args) {
    const s = normalize(sql);
    if (/FROM user_organizations uo/i.test(s)) return [];
    if (/FROM role_permissions rp/i.test(s)) return (ROLE_PERMS[args[0]] || []).map((code) => ({ code }));
    if (/FROM user_support_permissions/i.test(s)) return [];
    if (/FROM user_sifha_organizations/i.test(s)) return [];
    if (/JOIN organization_sifha_systems os ON os\.sifha_system_id = s\.id\s+WHERE os\.organization_id = \? AND os\.active = 1/i.test(s)) {
      return activeAssignedSystems(args[0]);
    }
    if (/LEFT JOIN organization_sifha_systems os ON os\.sifha_system_id = s\.id AND os\.organization_id = \?/i.test(s)) {
      return activeAssignedSystems(args[0]);
    }
    if (/FROM sifha_systems s ORDER BY s\.name/i.test(s)) return db.systems.map(systemRow).sort(byName);
    return unsupported('queryMany', sql);
  },

  async execute(sql, ...args) {
    const s = normalize(sql);
    if (/UPDATE sifha_systems SET name = \?/i.test(s)) {
      const [name, description, active, updatedAt, id] = args;
      const found = db.systems.find((x) => x.id === Number(id));
      if (!found) return { rowsAffected: 0 };
      found.name = name;
      found.description = description;
      found.active = Number(active);
      found.updated_at = updatedAt;
      return { rowsAffected: 1 };
    }
    if (/MERGE organization_sifha_systems/i.test(s)) {
      const [org, systemId] = args.map(Number);
      const found = db.assignments.find((a) => a.organization_id === org && a.sifha_system_id === systemId);
      if (found) found.active = 1;
      else db.assignments.push({ organization_id: org, sifha_system_id: systemId, active: 1 });
      return { rowsAffected: 1 };
    }
    if (/UPDATE organization_sifha_systems SET active = 0/i.test(s)) {
      const org = Number(args[0]);
      const keep = args.slice(1).map(Number);
      let rowsAffected = 0;
      for (const assignment of db.assignments) {
        if (assignment.organization_id !== org) continue;
        if (keep.includes(assignment.sifha_system_id)) continue;
        if (assignment.active) {
          assignment.active = 0;
          rowsAffected += 1;
        }
      }
      return { rowsAffected };
    }
    return unsupported('execute', sql);
  },

  async insertAndGetId(sql, ...args) {
    const s = normalize(sql);
    if (/INSERT INTO sifha_systems/i.test(s)) {
      const [code, name, description, createdAt] = args;
      const id = Math.max(0, ...db.systems.map((x) => x.id)) + 1;
      db.systems.push({ id, code, name, description, active: 1, created_at: createdAt });
      return { id, rowsAffected: 1 };
    }
    return unsupported('insertAndGetId', sql);
  },

  async transaction(callback) {
    return callback(runtimeStub);
  },

  async close() {},
};

mock.module('../src/db/runtime.js', {
  defaultExport: runtimeStub,
  namedExports: { currentEngine: () => 'mssql' },
});

const { default: sifhaSystemsRoutes } = await import('../src/routes/sifhaSystems.js');
const { default: ticketsRoutes } = await import('../src/routes/tickets.js');
const { wrapAsyncRouter } = await import('../src/middleware/asyncHandler.js');
const { errorHandler } = await import('../src/middleware/errors.js');

const app = express();
app.use(express.json());
// Sesión de prueba: el usuario se identifica con la cabecera x-test-user, que
// en producción no existe (la sesión siempre la decide el servidor).
app.use((req, res, next) => {
  const raw = req.get('x-test-user');
  req.session = raw ? { userId: Number(raw), destroy(cb) { if (cb) cb(); } } : {};
  next();
});
app.use('/api/sifha-systems', wrapAsyncRouter(sifhaSystemsRoutes));
app.use('/api/tickets', wrapAsyncRouter(ticketsRoutes));
app.use(errorHandler);

function send(method, url, userId, body) {
  let req = request(app)[method](url);
  if (userId) req = req.set('x-test-user', String(userId));
  if (body !== undefined) req = req.send(body);
  return req;
}
const get = (url, userId) => send('get', url, userId);
const post = (url, userId, body) => send('post', url, userId, body);
const patch = (url, userId, body) => send('patch', url, userId, body);
const put = (url, userId, body) => send('put', url, userId, body);

const SUPERADMIN = 1;
const ADMIN_A = 2;
const ADMIN_B = 3;
const EMPLEADO_A = 4;

before(() => {
  db.categories.length = 0;
});

describe('SIFHA: catálogo disponible para la empresa (GET /available)', () => {
  it('sin sesión no enumera nada (401)', async () => {
    const res = await get('/api/sifha-systems/available');
    assert.equal(res.status, 401);
  });

  it('la empresa A solo ve sus productos activos y vigentes', async () => {
    const res = await get('/api/sifha-systems/available', ADMIN_A);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.systems.map((s) => s.code), ['SAP']);
  });

  it('no cruza productos entre empresas', async () => {
    const res = await get('/api/sifha-systems/available', ADMIN_B);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.systems.map((s) => s.code), ['CRM']);
  });

  it('un SUPERADMIN global sin contexto de empresa no enumera catálogo', async () => {
    const res = await get('/api/sifha-systems/available', SUPERADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.systems, []);
  });
});

describe('SIFHA: administración del catálogo (solo SUPERADMIN)', () => {
  it('el catálogo completo exige ser SUPERADMIN (403 para admin y empleado)', async () => {
    assert.equal((await get('/api/sifha-systems', ADMIN_A)).status, 403);
    assert.equal((await get('/api/sifha-systems', EMPLEADO_A)).status, 403);
  });

  it('el SUPERADMIN ve todo el catálogo, incluidos los inactivos', async () => {
    const res = await get('/api/sifha-systems', SUPERADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.systems.map((s) => s.code).sort(), ['CRM', 'LEGACY', 'NOPE', 'SAP']);
  });

  it('crea un producto y lo devuelve activo', async () => {
    const res = await post('/api/sifha-systems', SUPERADMIN, { code: 'new', name: 'Producto nuevo' });
    assert.equal(res.status, 201);
    assert.equal(res.body.system.code, 'NEW');
    assert.equal(res.body.system.active, 1);
    const list = await get('/api/sifha-systems', SUPERADMIN);
    assert.ok(list.body.systems.some((s) => s.code === 'NEW'));
  });

  it('rechaza crear sin código', async () => {
    const res = await post('/api/sifha-systems', SUPERADMIN, { name: 'Sin código' });
    assert.equal(res.status, 400);
  });

  it('rechaza un código duplicado (409)', async () => {
    const res = await post('/api/sifha-systems', SUPERADMIN, { code: 'SAP', name: 'Duplicado' });
    assert.equal(res.status, 409);
  });

  it('activa y desactiva un producto existente', async () => {
    const off = await patch('/api/sifha-systems/101', SUPERADMIN, { active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.system.active, 0);
    const on = await patch('/api/sifha-systems/101', SUPERADMIN, { active: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.system.active, 1);
  });

  it('devuelve 404 al editar un producto inexistente', async () => {
    const res = await patch('/api/sifha-systems/999999', SUPERADMIN, { name: 'X' });
    assert.equal(res.status, 404);
  });

  it('lista para una empresa solo los productos con asignación vigente', async () => {
    const res = await get(`/api/sifha-systems/organizations/${ORG_A}`, SUPERADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.systems.map((s) => s.code), ['SAP']);
  });
});

describe('SIFHA: asignación de productos a empresas (PUT)', () => {
  // Guarda de regresión: la ruta usaba runtime.transactionAsync, que la fachada
  // real no expone (solo transaction): el endpoint devolvía 500. Este caso fija
  // que asignar y revocar productos funcione con la superficie real del runtime.
  before(resetAssignments);

  it('asigna y revoca productos de una empresa', async () => {
    const assign = await put(`/api/sifha-systems/organizations/${ORG_A}`, SUPERADMIN, { sifha_system_ids: [102] });
    assert.equal(assign.status, 200);
    assert.deepEqual(assign.body.systems.map((s) => s.code), ['CRM']);
    const revoke = await put(`/api/sifha-systems/organizations/${ORG_A}`, SUPERADMIN, { sifha_system_ids: [] });
    assert.equal(revoke.status, 200);
    assert.deepEqual(revoke.body.systems, []);
  });
});

describe('SIFHA: validación del alcance en la creación de tickets', () => {
  const base = { title: 'Ticket', description: 'Descripción', category_id: 1, priority: 'LOW' };

  before(resetAssignments);

  it('el alcance SIFHA exige producto', async () => {
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'SIFHA' });
    assert.equal(res.status, 400);
  });

  it('rechaza un producto inexistente o manipulado', async () => {
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'SIFHA', sifha_system_id: 999999 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Producto SIFHA inválido o no habilitado para la empresa');
  });

  it('rechaza un producto no asignado a la empresa', async () => {
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'SIFHA', sifha_system_id: 102 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Producto SIFHA inválido o no habilitado para la empresa');
  });

  it('rechaza un producto activo cuya asignación está revocada', async () => {
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'SIFHA', sifha_system_id: 104 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Producto SIFHA inválido o no habilitado para la empresa');
  });

  it('un producto válido supera la puerta SIFHA y continúa el alta', async () => {
    // El doble no tiene categorías, así que el alta se detiene en la validación
    // siguiente: eso demuestra que el filtro SIFHA ya se superó.
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'SIFHA', sifha_system_id: 101 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Categoría inválida');
  });

  it('el alcance INTERNAL ignora sifha_system_id y no exige asignación', async () => {
    const res = await post('/api/tickets', ADMIN_A, { ...base, support_scope: 'INTERNAL', sifha_system_id: 102 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Categoría inválida');
  });
});
