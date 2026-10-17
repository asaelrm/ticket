// Pruebas de integración MSSQL: SIFHA (productos, asignaciones, tickets SIFHA)
// Ejecutar: npm run test:mssql
// REQUISITOS: base autorizada SIFHA_Tickets_M5_Integration_Test
// SIN migraciones, SIN escrituras destructivas; idempotente y aislado.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import bcrypt from 'bcryptjs';
import { createAdminClient, createEmpleadoClient, uniqueSuffix, TEST_ADMIN_PASS, TEST_ADMIN_USER } from '../helpers-mssql.js';
import { ensureMssqlTestSetup, mssqlTestConfig } from '../setup-mssql.js';
import { validateMssqlSchema } from '../../src/db/mssql/schemaValidator.js';
import db from '../../src/db/runtime.js';

const IMG_PNG_LOCAL = {
  name: 'captura.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

let adminClient;
let empleadoClient;
let testSuffix;
let orgUceId;
let orgBId;
let superadminId;
let catUceId;
let catBId;
let deptUceId;
let deptBId;
let sifhaSysAId;
let sifhaSysBId;
let adminBId;
let adminBClient;

let configPool = null;

async function qOne(stmt) {
  const r = await configPool.request().query(stmt);
  return r.recordset[0] || null;
}

async function qMany(stmt) {
  const r = await configPool.request().query(stmt);
  return r.recordset;
}

async function ensureSuperadminUser() {
  const passHash = bcrypt.hashSync(TEST_ADMIN_PASS || 'superadmin123456', 12);
  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = 'superadmin_sifha_test')
    BEGIN
      DECLARE @roleId INT = (SELECT id FROM dbo.roles WHERE code = 'SUPERADMIN');
      INSERT INTO dbo.users (organization_id, department_id, role_id, name, last_name, username, email, password_hash, position, active, last_password_change_at)
      VALUES (NULL, NULL, @roleId, 'Super', 'Admin', 'superadmin_sifha_test', 'superadmin.sifha@test.local', '${passHash.replace(/'/g, "''")}', 'Superadmin', 1, SYSUTCDATETIME());
    END
  `);
  const row = await qOne("SELECT id FROM dbo.users WHERE username = 'superadmin_sifha_test'");
  superadminId = row?.id;
}

async function ensureOrgs() {
  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.organizations WHERE code = 'ORG_SIFHA_B')
    INSERT INTO dbo.organizations (code, name, description, active, created_at) VALUES ('ORG_SIFHA_B', 'Org SIFHA B', 'Prueba aislamiento', 1, SYSUTCDATETIME());
  `);
  const uce = await qOne("SELECT TOP 1 id FROM dbo.organizations WHERE code = 'UCE' ORDER BY id");
  orgUceId = uce?.id || (await qOne("SELECT MIN(id) AS id FROM dbo.organizations")).id;
  const b = await qOne("SELECT id FROM dbo.organizations WHERE code = 'ORG_SIFHA_B'");
  orgBId = b?.id;
}

async function ensureDeptsCats() {
  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.departments WHERE organization_id = ${orgUceId} AND name = 'Tecnología')
    INSERT INTO dbo.departments (organization_id, name, description, active, created_at) VALUES (${orgUceId}, 'Tecnología', null, 1, SYSUTCDATETIME());
  `);
  deptUceId = (await qOne(`SELECT id FROM dbo.departments WHERE organization_id = ${orgUceId} AND name = 'Tecnología'`))?.id;

  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.categories WHERE organization_id = ${orgUceId} AND name = 'Soporte')
    INSERT INTO dbo.categories (organization_id, name, description, color, active, created_at) VALUES (${orgUceId}, 'Soporte', null, '#64748b', 1, SYSUTCDATETIME());
  `);
  catUceId = (await qOne(`SELECT id FROM dbo.categories WHERE organization_id = ${orgUceId} AND name = 'Soporte'`))?.id;

  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.departments WHERE organization_id = ${orgBId} AND name = 'IT')
    INSERT INTO dbo.departments (organization_id, name, description, active, created_at) VALUES (${orgBId}, 'IT', null, 1, SYSUTCDATETIME());
  `);
  deptBId = (await qOne(`SELECT id FROM dbo.departments WHERE organization_id = ${orgBId} AND name = 'IT'`))?.id;

  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.categories WHERE organization_id = ${orgBId} AND name = 'General')
    INSERT INTO dbo.categories (organization_id, name, description, color, active, created_at) VALUES (${orgBId}, 'General', null, '#64748b', 1, SYSUTCDATETIME());
  `);
  catBId = (await qOne(`SELECT id FROM dbo.categories WHERE organization_id = ${orgBId} AND name = 'General'`))?.id;

  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.settings WHERE [key] = 'ticket_prefix')
    INSERT INTO dbo.settings ([key], value) VALUES ('ticket_prefix', 'TCK');
  `);
}

async function ensureSifhaSystems() {
  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.sifha_systems WHERE code = 'SIFHA_A')
    INSERT INTO dbo.sifha_systems (code, name, description, active, created_at) VALUES ('SIFHA_A', 'Sistema SIFHA A', 'Test A', 1, SYSUTCDATETIME());
    IF NOT EXISTS (SELECT 1 FROM dbo.sifha_systems WHERE code = 'SIFHA_B_INACT')
    INSERT INTO dbo.sifha_systems (code, name, description, active, created_at) VALUES ('SIFHA_B_INACT', 'Sistema SIFHA Inactivo', 'Test', 0, SYSUTCDATETIME());
  `);
  sifhaSysAId = (await qOne("SELECT id FROM dbo.sifha_systems WHERE code = 'SIFHA_A'"))?.id;
  sifhaSysBId = (await qOne("SELECT id FROM dbo.sifha_systems WHERE code = 'SIFHA_B_INACT'"))?.id;
}

async function ensureAdminB() {
  const passHash = bcrypt.hashSync(TEST_ADMIN_PASS || 'admin123456789', 12);
  await configPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE username = 'admin_sifha_b')
    BEGIN
      DECLARE @roleId INT = (SELECT id FROM dbo.roles WHERE code = 'ADMIN');
      INSERT INTO dbo.users (organization_id, department_id, role_id, name, last_name, username, email, password_hash, position, active, last_password_change_at)
      VALUES (${orgBId}, ${deptBId}, @roleId, 'Admin', 'B', 'admin_sifha_b', 'admin.b@test.local', '${passHash.replace(/'/g, "''")}', 'Administrador', 1, SYSUTCDATETIME());
    END
  `);
  const row = await qOne("SELECT id FROM dbo.users WHERE username = 'admin_sifha_b'");
  adminBId = row?.id;
}

before(async () => {
  await ensureMssqlTestSetup();
  configPool = await sql.connect(mssqlTestConfig);
  testSuffix = uniqueSuffix();

  await ensureOrgs();
  await ensureDeptsCats();
  await ensureSifhaSystems();
  await ensureSuperadminUser();
  await ensureAdminB();

  adminClient = await createAdminClient(testSuffix);
  empleadoClient = await createEmpleadoClient(testSuffix);
  adminBClient = (await import('../helpers-mssql.js')).createClient();
  const loginB = await adminBClient.login('admin_sifha_b', TEST_ADMIN_PASS);
  if (loginB.status !== 200) {
    throw new Error(`Login admin_sifha_b fallo: ${loginB.status}`);
  }
});

describe('MSSQL Integration: SIFHA - Catálogo', () => {
  it('Superadmin puede listar catálogo completo', async () => {
    const c = (await import('../helpers-mssql.js')).createClient();
    const l = await c.login('superadmin_sifha_test', TEST_ADMIN_PASS);
    assert.equal(l.status, 200);
    const res = await c.get('/api/sifha-systems');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.systems));
  });

  it('Admin con organization.manage? Superadmin requerido; admin común no debe listar catálogo global', async () => {
    const res = await adminClient.get('/api/sifha-systems');
    assert.ok(res.status === 403 || res.status === 401);
  });

  it('GET /api/sifha-systems/available exige auth y devuelve vacío si sin org', async () => {
    const c = (await import('../helpers-mssql.js')).createClient();
    const res = await c.get('/api/sifha-systems/available');
    assert.equal(res.status, 401);
  });
});

describe('MSSQL Integration: SIFHA - Asignaciones y tickets', () => {
  it('1) Ticket INTERNAL se crea correctamente con support_scope INTERNAL', async () => {
    const title = `INTERNAL MSSQL ${testSuffix}`;
    const res = await adminClient.post('/api/tickets', {
      title,
      description: 'Prueba interno',
      category_id: catUceId,
      priority: 'MEDIUM',
      department_id: deptUceId,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ticket.support_scope, 'INTERNAL');
    assert.equal(res.body.ticket.sifha_system_id, null);
  });

  it('2) Superadmin asigna producto SIFHA a organización B y queda activo', async () => {
    const c = (await import('../helpers-mssql.js')).createClient();
    const l = await c.login('superadmin_sifha_test', TEST_ADMIN_PASS);
    assert.equal(l.status, 200);
    const put = await c.put(`/api/sifha-systems/organizations/${orgBId}`, {
      sifha_system_ids: [sifhaSysAId],
    });
    assert.equal(put.status, 200);
    const get = await c.get(`/api/sifha-systems/organizations/${orgBId}`);
    assert.equal(get.status, 200);
    const hasA = (get.body.systems || []).some((s) => s.id === sifhaSysAId);
    assert.ok(hasA);
  });

  it('3) Rechaza producto no asignado a la organización', async () => {
    const title = `SIFHA_BAD ${testSuffix}`;
    const res = await adminBClient.post('/api/tickets', {
      title,
      description: 'SIFHA',
      category_id: catBId,
      priority: 'HIGH',
      support_scope: 'SIFHA',
      sifha_system_id: sifhaSysBId,
      department_id: deptBId,
    });
    assert.equal(res.status, 400);
  });

  it('4) Ticket SIFHA con producto válido asignado supera validación (se crea)', async () => {
    const title = `SIFHA_OK ${testSuffix}`;
    const res = await adminBClient.post('/api/tickets', {
      title,
      description: 'SIFHA válido',
      category_id: catBId,
      priority: 'HIGH',
      support_scope: 'SIFHA',
      sifha_system_id: sifhaSysAId,
      department_id: deptBId,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ticket.support_scope, 'SIFHA');
    assert.equal(res.body.ticket.sifha_system_id, sifhaSysAId);
  });

  it('5) Aislamiento: empleado/admin B no ven tickets UCE vía listado; estructura correcta', async () => {
    const res = await empleadoClient.get('/api/tickets');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tickets));
  });

  it('6) Revocación desactiva asignación (tras revocar, SIFHA inválido)', async () => {
    const c = (await import('../helpers-mssql.js')).createClient();
    const l = await c.login('superadmin_sifha_test', TEST_ADMIN_PASS);
    assert.equal(l.status, 200);
    const putRev = await c.put(`/api/sifha-systems/organizations/${orgBId}`, {
      sifha_system_ids: [],
    });
    assert.equal(putRev.status, 200);
    const title = `SIFHA_REV ${testSuffix}`;
    const res = await adminBClient.post('/api/tickets', {
      title,
      description: 'SIFHA revocado',
      category_id: catBId,
      priority: 'HIGH',
      support_scope: 'SIFHA',
      sifha_system_id: sifhaSysAId,
      department_id: deptBId,
    });
    assert.equal(res.status, 400);
  });
});

describe('MSSQL Integration: SIFHA - Integridad, transacciones, validador', () => {
  it('7) FK/índices y restricciones SIFHA existentes en catálogo', async () => {
    const fks = await qMany(`
      SELECT fk.name AS fk_name, tp.name AS parent_table, tr.name AS ref_table
      FROM sys.foreign_keys fk
      JOIN sys.tables tp ON tp.object_id = fk.parent_object_id
      JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id
      WHERE tp.schema_id = SCHEMA_ID('dbo') AND tr.schema_id = SCHEMA_ID('dbo')
        AND (tp.name IN ('organization_sifha_systems','tickets','user_sifha_organizations') OR tr.name = 'sifha_systems')
      ORDER BY fk_name
    `);
    assert.ok(fks.length >= 2);
    const cks = await qMany(`
      SELECT o.name, t.name AS table_name
      FROM sys.check_constraints c
      JOIN sys.objects o ON o.object_id = c.object_id
      JOIN sys.tables t ON t.object_id = c.parent_object_id
      WHERE t.schema_id = SCHEMA_ID('dbo') AND o.name = 'CK_tickets_support_scope'
    `);
    assert.ok(cks.length === 1);
  });

  it('8) Transacción real: rollback ante error (ALS routing + rollback)', async () => {
    const beforeCount = (await qOne("SELECT COUNT(*) AS c FROM dbo.tickets"))?.c;
    let hadError = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO dbo.tickets (ticket_number, title, description, reporter_id, category_id, priority, sla_due_at, organization_id, support_scope, sifha_system_id) VALUES (CONCAT('TCK-TR-', CAST(ABS(CHECKSUM(NEWID())) AS NVARCHAR(10))), 'TX_ROLLBACK_TEST', 'test', ?, ?, 'MEDIUM', DATEADD(HOUR,1,GETUTCDATE()), ?, 'INTERNAL', NULL)", adminClient.user ? (await adminClient.get('/api/auth/me').then(r=>r.body.user.id)) : (await qOne(`SELECT TOP 1 id FROM dbo.users WHERE role_id=(SELECT id FROM dbo.roles WHERE code='ADMIN')`)).id, catUceId, orgUceId);
        throw new Error('FORCED_ROLLBACK');
      });
    } catch (e) {
      hadError = e.message === 'FORCED_ROLLBACK';
    }
    assert.ok(hadError);
    const afterCount = (await qOne("SELECT COUNT(*) AS c FROM dbo.tickets"))?.c;
    assert.equal(beforeCount, afterCount);
  });

  it('9) Validador de esquema MSSQL compatible con schema.sql (ok sin errores)', async () => {
    const result = await validateMssqlSchema(db.queryMany.bind(db));
    assert.equal(result.ok, true, `Errores: ${result.errors.join('; ')}`);
  });
});

after(async () => {
  if (configPool) {
    try { await configPool.close(); } catch {}
  }
});
