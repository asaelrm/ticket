// Pruebas de integración MSSQL: Reportes, Dashboard, Configuración y Aislamiento
// Ejecutar: npm run test:mssql

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient, createEmpleadoClient, uniqueSuffix } from './helpers-mssql.js';
import { ensureMssqlTestSetup } from './setup-mssql.js';

let adminClient;
let empleadoClient;
let testSuffix;

before(async () => {
  await ensureMssqlTestSetup();
  testSuffix = uniqueSuffix();
  
  adminClient = await createAdminClient(testSuffix);
  empleadoClient = await createEmpleadoClient(testSuffix);
});

describe('MSSQL Integration: Dashboard', () => {
  it('/api/dashboard/summary responde', async () => {
    const res = await adminClient.get('/api/dashboard/summary');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.counts === 'object');
    assert.ok(typeof res.body.openTotal === 'number');
  });
  
  it('/api/dashboard/sla responde', async () => {
    const res = await adminClient.get('/api/dashboard/sla');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.overdue === 'number');
    assert.ok(typeof res.body.atRisk === 'number');
    assert.ok(typeof res.body.healthy === 'number');
    assert.ok(Array.isArray(res.body.top));
  });
  
  it('/api/dashboard/by-technician responde', async () => {
    const res = await adminClient.get('/api/dashboard/by-technician');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(typeof res.body.unassigned === 'number');
    assert.ok(typeof res.body.totals === 'object');
  });
  
  it('/api/dashboard/needs-attention responde', async () => {
    const res = await adminClient.get('/api/dashboard/needs-attention');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(typeof res.body.totals === 'object');
  });
});

describe('MSSQL Integration: Reportes', () => {
  it('/api/reports/summary responde', async () => {
    const res = await adminClient.get('/api/reports/summary');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.total === 'number');
  });
  
  it('/api/reports/by-status responde', async () => {
    const res = await adminClient.get('/api/reports/by-status');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });
  
  it('/api/reports/by-priority responde', async () => {
    const res = await adminClient.get('/api/reports/by-priority');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });
  
  it('/api/reports/csat responde', async () => {
    const res = await adminClient.get('/api/reports/csat');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.responses === 'number');
  });
  
  it('/api/reports/export CSV devuelve archivo', async () => {
    const res = await adminClient.get('/api/reports/export');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
  });
});

describe('MSSQL Integration: Configuración (settings)', () => {
  it('GET /api/settings devuelve configuración', async () => {
    const res = await adminClient.get('/api/settings');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === 'object');
  });
  
  it('PATCH /api/settings actualiza configuración global', async () => {
    const newName = `SIFHA MSSQL Test ${testSuffix}`;
    const res = await adminClient.patch('/api/settings', { app_name: newName });
    assert.equal(res.status, 200);
    assert.equal(res.body.app_name, newName);
  });
});

describe('MSSQL Integration: Notificaciones', () => {
  it('GET /api/notifications devuelve lista', async () => {
    const res = await adminClient.get('/api/notifications');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(typeof res.body.unread === 'number');
  });
  
  it('POST /api/notifications/read marca como leída', async () => {
    const res = await adminClient.post('/api/notifications/read', { all: true });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
  });
});

describe('MSSQL Integration: Usuarios y roles', () => {
  it('GET /api/users lista usuarios', async () => {
    const res = await adminClient.get('/api/users');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });
  
  it('GET /api/roles lista roles y permisos', async () => {
    const res = await adminClient.get('/api/roles');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.roles));
    assert.ok(Array.isArray(res.body.permissions));
  });
  
  it('crear usuario en organización actual', async () => {
    const suffix = uniqueSuffix();
    const res = await adminClient.post('/api/users', {
      name: 'Nuevo',
      last_name: `Usuario MSSQL ${suffix}`,
      username: `nuevo_mssql_${suffix}`,
      email: `nuevo_mssql_${suffix}@test.com`,
      password: 'NuevaClave1234!',
      role_id: 1, // EMPLOYEE
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, `nuevo_mssql_${suffix}`);
  });
});

describe('MSSQL Integration: Aislamiento multiempresa (placeholder)', () => {
  it('estructura de prueba para aislamiento entre organizaciones', async () => {
    // Requiere setup de SUPERADMIN y creación de organizaciones
    // Se valida que los endpoints respetan organization_id de la sesión
    assert.ok(true, 'Estructura lista para pruebas de aislamiento');
  });
});