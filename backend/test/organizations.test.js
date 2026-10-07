import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db, { runMigrations, nowIso } from '../src/db.js';
import { seed } from '../src/seed.js';
import { hashPassword } from '../src/utils/password.js';

const UCE = { code: 'UCE', name: 'Centro Médico UCE' };

function orgRow() {
  return db.prepare('SELECT * FROM organizations WHERE code = ?').get(UCE.code);
}

function superRole() {
  return db.prepare('SELECT id, code FROM roles WHERE code = ?').get('SUPERADMIN');
}

describe('Organizaciones (ETAPA 1A)', () => {
  it('existe la organización inicial UCE', () => {
    const uce = orgRow();
    assert.ok(uce, 'debe existir la organización UCE');
    assert.equal(uce.name, UCE.name);
    assert.equal(uce.active, 1);
    assert.ok(uce.id);
  });

  it('el administrador sembrado pertenece a UCE', async () => {
    const uce = orgRow();
    const admin = db.prepare('SELECT organization_id FROM users WHERE username = ?').get('admin');
    assert.equal(admin.organization_id, uce.id, 'el admin debe estar asociado a UCE sin perder su cuenta');

    const c = createClient();
    const login = await c.login('admin', '123456');
    assert.equal(login.status, 200);
  });

  it('/api/auth/me expone organization_id y organization_name desde la sesión', async () => {
    const uce = orgRow();
    const c = createClient();
    await c.login('admin', '123456');
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.ok(me.body.user.organization_id, 'organization_id debe estar presente');
    assert.ok(me.body.user.organization_name, 'organization_name debe estar presente');
    assert.equal(me.body.user.organization_id, uce.id);
    assert.equal(me.body.user.organization_name, 'Centro Médico UCE');
  });

  it('un usuario normal (empleado) pertenece a UCE y es_superadmin=false', async () => {
    const uce = orgRow();
    const emp = db.prepare('SELECT organization_id FROM users WHERE username = ?').get('empleado');
    assert.equal(emp.organization_id, uce.id);

    const c = createClient();
    const login = await c.login('empleado', 'Empleado1234!');
    assert.equal(login.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.organization_id, uce.id);
    assert.equal(me.body.user.organization_name, 'Centro Médico UCE');
    assert.equal(me.body.user.is_superadmin, false);
  });

  it('un SUPERADMIN tiene is_superadmin=true, organization_id null y organization.manage', async () => {
    const role = superRole();
    assert.ok(role, 'el rol SUPERADMIN debe existir');
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`
    ).run('Super', 'Admin', 'superadmin_test', 'superadmin_test@empresa.com', hashPassword('SuperClave123!'), role.id, nowIso());

    const c = createClient();
    const login = await c.login('superadmin_test', 'SuperClave123!');
    assert.equal(login.status, 200);
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.is_superadmin, true);
    assert.equal(me.body.user.organization_id, null);
    assert.equal(me.body.user.organization_name, '');
    assert.ok(me.body.user.permissions.includes('organization.manage'), 'SUPERADMIN debe tener organization.manage');
  });

  it('la creación por API asigna la organización de la sesión y rechaza organization_id del cliente', async () => {
    const uce = orgRow();
    const techRole = db.prepare('SELECT id FROM roles WHERE code = ?').get('TECHNICIAN');

    const admin = createClient();
    await admin.login('admin', '123456');

    const ok = await admin.post('/api/users', {
      name: 'Nace',
      last_name: 'EnUCE',
      username: `nace.uce.${Date.now()}`,
      email: `nace.uce.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: techRole.id,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.user.organization_id, uce.id, 'la organización sale de la sesión');

    const forged = await admin.post('/api/users', {
      name: 'Falso',
      last_name: 'Org',
      username: `forja.org.${Date.now()}`,
      email: `forja.org.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: techRole.id,
      organization_id: 9999,
    });
    assert.equal(forged.status, 400, 'el cliente no puede decidir la organización');
  });

  it('un admin normal no puede autoconvertirse ni ascender a nadie a SUPERADMIN', async () => {
    const superR = superRole();
    const techRole = db.prepare('SELECT id FROM roles WHERE code = ?').get('TECHNICIAN');

    const admin = createClient();
    await admin.login('admin', '123456');
    const me = await admin.get('/api/auth/me');
    const adminId = me.body.user.id;

    // a) Autoconversión vía PATCH sobre sí mismo -> 400 (guardia preexistente).
    const self = await admin.patch(`/api/users/${adminId}`, { role_id: superR.id });
    assert.equal(self.status, 400);

    // b) Crear a un tercero con rol SUPERADMIN -> 403.
    const post = await admin.post('/api/users', {
      name: 'Intruso',
      last_name: 'Super',
      username: `intruso.super.${Date.now()}`,
      email: `intruso.super.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: superR.id,
    });
    assert.equal(post.status, 403);

    // c) Ascender a un tercero vía PATCH -> 403.
    const victim = await admin.post('/api/users', {
      name: 'Victima',
      last_name: 'Usuario',
      username: `victima.super.${Date.now()}`,
      email: `victima.super.${Date.now()}@empresa.com`,
      password: 'Temporal1234!',
      role_id: techRole.id,
    });
    assert.equal(victim.status, 201, JSON.stringify(victim.body));
    const promote = await admin.patch(`/api/users/${victim.body.user.id}`, { role_id: superR.id });
    assert.equal(promote.status, 403);

    // d) Ni siquiera puede gestionar a un SUPERADMIN existente.
    const global = db.prepare('SELECT id FROM users WHERE username = ?').get('superadmin_test');
    const touch = await admin.patch(`/api/users/${global.id}/status`, { active: false });
    assert.equal(touch.status, 403);

    // e) Nadie resultó ascendido.
    const superCount = db.prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = 'SUPERADMIN' AND (u.username LIKE 'intruso.super.%' OR u.username LIKE 'victima.super.%')`
    ).get().n;
    assert.equal(superCount, 0);
  });

  it('la migración y el seed son idempotentes y no arrastran al SUPERADMIN global', () => {
    const count = (sql) => db.prepare(sql).get().n;
    const before = {
      users: count('SELECT COUNT(*) AS n FROM users'),
      organizations: count('SELECT COUNT(*) AS n FROM organizations'),
      uce: count("SELECT COUNT(*) AS n FROM organizations WHERE code = 'UCE'"),
      superadmins: count("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'SUPERADMIN'"),
      adminOrg: db.prepare('SELECT organization_id FROM users WHERE username = ?').get('admin').organization_id,
      superOrg: db.prepare('SELECT organization_id FROM users WHERE username = ?').get('superadmin_test').organization_id,
    };

    assert.doesNotThrow(() => runMigrations());
    assert.doesNotThrow(() => seed());
    assert.doesNotThrow(() => seed());

    const after = {
      users: count('SELECT COUNT(*) AS n FROM users'),
      organizations: count('SELECT COUNT(*) AS n FROM organizations'),
      uce: count("SELECT COUNT(*) AS n FROM organizations WHERE code = 'UCE'"),
      superadmins: count("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'SUPERADMIN'"),
      adminOrg: db.prepare('SELECT organization_id FROM users WHERE username = ?').get('admin').organization_id,
      superOrg: db.prepare('SELECT organization_id FROM users WHERE username = ?').get('superadmin_test').organization_id,
    };
    assert.deepEqual(after, before, 'reejecutar migración y seed no debe cambiar datos ni asignar org al global');
    assert.equal(after.superOrg, null, 'el SUPERADMIN global conserva organization_id null');
  });

  it('usuarios y tickets existentes siguen funcionando', async () => {
    const emp = createClient();
    const login = await emp.login('empleado', 'Empleado1234!');
    assert.equal(login.status, 200);

    const cat = db.prepare("SELECT id FROM categories WHERE name = 'Computadoras'").get();
    const created = await emp.post('/api/tickets', {
      title: 'Continuidad tras multiempresa',
      description: 'Los tickets existentes siguen funcionando',
      category_id: cat.id,
      priority: 'MEDIUM',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.ticket.ticket_number);

    const admin = createClient();
    await admin.login('admin', '123456');
    const list = await admin.get('/api/tickets');
    assert.equal(list.status, 200);
    const ids = list.body.data.map((t) => t.id);
    assert.ok(ids.includes(created.body.ticket.id), 'el ticket nuevo se ve en el listado');
  });
});