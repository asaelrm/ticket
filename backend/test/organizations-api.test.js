import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createSuperadminClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';

// V4: administración de organizaciones. Sólo el SUPERADMIN puede usarla; un
// administrador de empresa, un empleado o un `organization_id` manipulado no
// abren el canal. No hay DELETE: ninguna organización se destruye.
//
// Datos 100% ficticios.

const NEW_CODE = 'ORGSAPI';
const NEW_NAME = 'Organización API de prueba';

let superadmin;
let orgAdmin;
let employee;
let uceSnapshot;

function row(code) {
  return db.prepare('SELECT * FROM organizations WHERE code = ?').get(code);
}

before(async () => {
  superadmin = await createSuperadminClient('super_orgs_api_test');
  orgAdmin = createClient();
  assert.equal((await orgAdmin.login('admin', '123456')).status, 200);
  employee = createClient();
  assert.equal((await employee.login('empleado', 'Empleado1234!')).status, 200);
  uceSnapshot = { ...row('UCE') };
});

describe('API de organizaciones exclusiva del SUPERADMIN (V4)', () => {
  it('el SUPERADMIN lista y consulta organizaciones con sus conteos', async () => {
    const list = await superadmin.get('/api/organizations');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(Array.isArray(list.body.data));
    assert.ok(list.body.data.some((o) => o.code === 'UCE'), 'la organización inicial debe aparecer');
    const first = list.body.data[0];
    for (const field of ['id', 'code', 'name', 'active', 'users_count', 'tickets_count']) {
      assert.ok(field in first, `falta el campo ${field}`);
    }

    const detail = await superadmin.get(`/api/organizations/${first.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.organization.id, first.id);
  });

  it('un administrador de organización NO puede usar el canal', async () => {
    for (const url of ['/api/organizations', '/api/organizations/1']) {
      const res = await orgAdmin.get(url);
      assert.equal(res.status, 403, `${url} debe rechazar al administrador`);
    }
    const create = await orgAdmin.post('/api/organizations', { code: 'NOPEADM', name: 'No debe crearse' });
    assert.equal(create.status, 403);
    assert.ok(!row('NOPEADM'), 'el administrador no creó organizaciones');
  });

  it('un empleado NO puede usar el canal', async () => {
    const res = await employee.get('/api/organizations');
    assert.equal(res.status, 403);
    const patch = await employee.patch('/api/organizations/1', { name: 'Hackeado' });
    assert.equal(patch.status, 403);
    assert.equal(db.prepare('SELECT name FROM organizations WHERE id = 1').get().name !== 'Hackeado', true);
  });

  it('sin sesión no hay acceso (401)', async () => {
    const anon = createClient();
    await anon.get('/api/health');
    const res = await anon.get('/api/organizations');
    assert.equal(res.status, 401);
  });

  it('crear una organización valida sus campos y persiste', async () => {
    const bad = await superadmin.post('/api/organizations', { code: 'x', name: '' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));

    const badCode = await superadmin.post('/api/organizations', { code: ' Código con espacios ', name: 'Otra' });
    assert.equal(badCode.status, 400);

    const res = await superadmin.post('/api/organizations', {
      code: ` ${NEW_CODE.toLowerCase()} `,
      name: NEW_NAME,
      description: 'Creada por la prueba automatizada',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.organization.code, NEW_CODE, 'el código se normaliza a mayúsculas y sin espacios');
    assert.equal(res.body.organization.active, 1);
    assert.equal(row(NEW_CODE).name, NEW_NAME);
  });

  it('rechaza duplicados de código y de nombre', async () => {
    const dupCode = await superadmin.post('/api/organizations', { code: NEW_CODE.toLowerCase(), name: 'Otra' });
    assert.equal(dupCode.status, 409);

    const dupName = await superadmin.post('/api/organizations', { code: 'OTRAORG', name: NEW_NAME.toUpperCase() });
    assert.equal(dupName.status, 409);
    assert.ok(!row('OTRAORG'));
  });

  it('el cliente no puede inyectar organization_id en la petición', async () => {
    const res = await superadmin.post('/api/organizations', {
      code: 'INJECTORG',
      name: 'Intento de inyección',
      organization_id: 999,
    });
    assert.equal(res.status, 400);
    assert.ok(!row('INJECTORG'));

    const org = row(NEW_CODE);
    const patch = await superadmin.patch(`/api/organizations/${org.id}`, { organization_id: 1, name: 'Otro nombre' });
    assert.equal(patch.status, 400);
    assert.equal(row(NEW_CODE).name, NEW_NAME, 'nada cambió tras el intento');
  });

  it('el código es inmutable y la edición persiste', async () => {
    const org = row(NEW_CODE);
    const codeChange = await superadmin.patch(`/api/organizations/${org.id}`, { code: 'CAMBIADO' });
    assert.equal(codeChange.status, 400);
    assert.equal(row(NEW_CODE).name, NEW_NAME);

    const ok = await superadmin.patch(`/api/organizations/${org.id}`, {
      name: `${NEW_NAME} v2`,
      description: 'Descripción actualizada',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(row(NEW_CODE).name, `${NEW_NAME} v2`);
    assert.equal(row(NEW_CODE).description, 'Descripción actualizada');
  });

  it('la desactivación bloquea el acceso de ESA organización y sólo de ella', async () => {
    const org = row(NEW_CODE);

    // Cuenta ficticia DENTRO de la organización que se va a apagar.
    const orgUser = 'admin_orgapi_test';
    const roleId = db.prepare("SELECT id FROM roles WHERE code = 'ADMIN'").get().id;
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, position, role_id, active, last_password_change_at, organization_id)
       VALUES ('Org', 'API', ?, ?, ?, 'Puesto de prueba', ?, 1, ?, ?)`
    ).run(
      orgUser,
      `${orgUser}@organizacion.test`,
      hashPassword('OrgApiClave123!'),
      roleId,
      nowIso(),
      org.id
    );

    // Antes de desactivar la cuenta de esa organización entra sin problemas.
    const tenantClient = createClient();
    assert.equal((await tenantClient.login(orgUser, 'OrgApiClave123!')).status, 200);
    assert.equal((await tenantClient.get('/api/auth/me')).status, 200);
    // ...y las de las demás organizaciones también.
    assert.equal((await orgAdmin.get('/api/auth/me')).status, 200);

    const off = await superadmin.patch(`/api/organizations/${org.id}`, { active: false });
    assert.equal(off.status, 200);
    assert.equal(row(NEW_CODE).active, 0);

    // La organización apagada no admite nuevas sesiones...
    const blockedLogin = createClient();
    const login = await blockedLogin.login(orgUser, 'OrgApiClave123!');
    assert.equal(login.status, 403, 'el login de una organización desactivada se rechaza');

    // ...ni peticiones con sesión existente.
    const me = await tenantClient.get('/api/auth/me');
    assert.equal(me.status, 403, 'la sesión existente queda bloqueada');

    // Otras organizaciones no se ven afectadas.
    assert.equal((await orgAdmin.get('/api/auth/me')).status, 200);
    assert.equal((await employee.get('/api/auth/me')).status, 200);
    assert.equal((await superadmin.get('/api/organizations')).status, 200);

    // Reactivar restaura el acceso.
    const on = await superadmin.patch(`/api/organizations/${org.id}`, { active: true });
    assert.equal(on.status, 200);
    assert.equal(row(NEW_CODE).active, 1);
    const restored = createClient();
    assert.equal((await restored.login(orgUser, 'OrgApiClave123!')).status, 200);
    // La sesión anterior fue destruida al bloquearla (401 en adelante): hay que
    // volver a entrar, que es exactamente lo que ahora vuelve a permitirse.
    assert.equal((await restored.get('/api/auth/me')).status, 200);
  });

  it('no existe endpoint de borrado y ninguna organización se elimina', async () => {
    const org = row(NEW_CODE);
    const before = db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;

    const del = await superadmin.del(`/api/organizations/${org.id}`);
    assert.equal(del.status, 404, 'no hay canal destructivo');
    assert.ok(row(NEW_CODE), 'la organización sigue existiendo');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n, before);
  });

  it('un id inexistente devuelve 404 sin revelar nada', async () => {
    const res = await superadmin.get('/api/organizations/999999');
    assert.equal(res.status, 404);
    const patch = await superadmin.patch('/api/organizations/999999', { name: 'Nada' });
    assert.equal(patch.status, 404);
  });

  it('los datos de otra organización no se alteran por efecto colateral', async () => {
    const uce = db.prepare("SELECT * FROM organizations WHERE code = 'UCE'").get();
    assert.equal(uce.active, uceSnapshot.active);
    assert.equal(uce.name, uceSnapshot.name, 'el nombre de la organización inicial no cambia');
    assert.equal(uce.description, uceSnapshot.description);

    const admin = db.prepare("SELECT organization_id FROM users WHERE username = 'admin'").get();
    assert.equal(Number(admin.organization_id), Number(uce.id), 'las cuentas siguen en su organización');
  });
});
