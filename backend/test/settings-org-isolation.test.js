import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createSuperadminClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';
import { DEFAULT_SLA } from '../src/utils/settings.js';

// ETAPA 3 / TAREA B (V1): configuraciones POR ORGANIZACIÓN.
// Dos organizaciones con su propio administrador escriben y leen por separado:
// lo que guarda A no se ve en B, el cliente jamás elige la organización y las
// claves globales siguen siendo patrimonio del SUPERADMIN. Al final se comprueba
// que los consumidores reales (opciones de flujo, SLA, CSAT, reglas) usan la
// configuración de la organización y no la de otra.

const ORGA = 'SETG_A';
const ORGB = 'SETG_B';
const pass = (code) => `Org${code}Clave123!`;

const ADMIN_A = 'admin_setg_a';
const ADMIN_B = 'admin_setg_b';

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de configuración');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser(orgId, username, roleCode) {
  const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode).id;
  db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, NULL, 'Puesto de prueba', ?, 1, ?, ?)`
  ).run(
    `Nombre ${username}`,
    `Apellido ${username}`,
    username,
    `${username}@organizacion.test`,
    hashPassword(pass(username)),
    roleId,
    nowIso(),
    orgId
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

let orgA;
let orgB;
let clientA;
let clientB;
let superadmin;

before(async () => {
  orgA = insertOrg(ORGA, 'Organización A de configuración');
  orgB = insertOrg(ORGB, 'Organización B de configuración');
  insertUser(orgA, ADMIN_A, 'ADMIN');
  insertUser(orgB, ADMIN_B, 'ADMIN');

  clientA = createClient();
  clientB = createClient();
  assert.equal((await clientA.login(ADMIN_A, pass(ADMIN_A))).status, 200);
  assert.equal((await clientB.login(ADMIN_B, pass(ADMIN_B))).status, 200);
  superadmin = await createSuperadminClient();
});

describe('Configuración aislada por organización (V1)', () => {
  it('A guarda valores que B no ve', async () => {
    const before = await clientA.get('/api/settings');
    assert.equal(before.status, 200);

    const patch = await clientA.patch('/api/settings', {
      company_name: 'Empresa A Config',
      sla_high_hours: '2',
      enable_csat: '0',
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const a = await clientA.get('/api/settings');
    assert.equal(a.body.data.company_name, 'Empresa A Config');
    assert.equal(a.body.data.sla_high_hours, '2');
    assert.equal(a.body.data.enable_csat, '0');

    const b = await clientB.get('/api/settings');
    assert.equal(b.status, 200);
    assert.notEqual(b.body.data.company_name, 'Empresa A Config');
    assert.notEqual(b.body.data.sla_high_hours, '2');
    // El CSAT de A quedó apagado: el de B sigue encendido por defecto.
    assert.equal(b.body.data.enable_csat, '1');
  });

  it('B guarda lo suyo sin pisar los valores de A', async () => {
    const patch = await clientB.patch('/api/settings', {
      company_name: 'Empresa B Config',
      sla_high_hours: '6',
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const a = await clientA.get('/api/settings');
    assert.equal(a.body.data.company_name, 'Empresa A Config');
    assert.equal(a.body.data.sla_high_hours, '2');

    const b = await clientB.get('/api/settings');
    assert.equal(b.body.data.company_name, 'Empresa B Config');
    assert.equal(b.body.data.sla_high_hours, '6');
  });

  it('el cliente no puede elegir la organización (ni para leer ni para escribir)', async () => {
    const write = await clientA.patch('/api/settings', {
      organization_id: orgB,
      company_name: 'Intento cruzado',
    });
    assert.equal(write.status, 400, JSON.stringify(write.body));

    const b = await clientB.get('/api/settings');
    assert.equal(b.body.data.company_name, 'Empresa B Config');

    // Tampoco una cabecera decide el contexto: sigue mandando la sesión.
    const spoofed = await clientA.get('/api/settings', {
      headers: { 'x-organization-id': String(orgB) },
    });
    assert.equal(spoofed.status, 200);
    assert.equal(spoofed.body.data.company_name, 'Empresa A Config');
  });

  it('las listas configurables también viven por organización', async () => {
    const cats = 'Alpha, Beta, Gamma';
    const patch = await clientA.patch('/api/settings', { resolution_categories: cats });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const a = await clientA.get('/api/settings');
    assert.equal(a.body.data.resolution_categories, cats);
    const b = await clientB.get('/api/settings');
    assert.notEqual(b.body.data.resolution_categories, cats);

    const optsA = await clientA.get('/api/tickets/options');
    const optsB = await clientB.get('/api/tickets/options');
    assert.deepEqual(optsA.body.resolution_categories, ['Alpha', 'Beta', 'Gamma']);
    assert.notDeepEqual(optsB.body.resolution_categories, ['Alpha', 'Beta', 'Gamma']);
  });

  it('un administrador no puede cambiar las claves globales', async () => {
    const current = await clientA.get('/api/settings');
    assert.equal(current.status, 200);
    const appName = current.body.data.app_name;
    assert.ok(current.body.global_keys.includes('app_name'));
    assert.ok(current.body.global_keys.includes('ticket_prefix'));

    // Cambiar la global -> 403 y nada cambia.
    const denied = await clientA.patch('/api/settings', { app_name: `${appName} Hack` });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const after = await clientA.get('/api/settings');
    assert.equal(after.body.data.app_name, appName);

    // Reenviar el valor vigente no es un intento: el formulario lo manda todo.
    const noop = await clientA.patch('/api/settings', {
      app_name: appName,
      company_name: 'Empresa A Config',
    });
    assert.equal(noop.status, 200, JSON.stringify(noop.body));
    assert.equal(noop.body.data.app_name, appName);
  });

  it('el SUPERADMIN sí cambia la global y ambas organizaciones la ven', async () => {
    const current = await clientA.get('/api/settings');
    const original = current.body.data.app_name;
    const nuevo = 'Sistema Unico Global';

    const change = await superadmin.patch('/api/settings', { app_name: nuevo });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    assert.equal(change.body.data.app_name, nuevo);

    const a = await clientA.get('/api/settings');
    const b = await clientB.get('/api/settings');
    assert.equal(a.body.data.app_name, nuevo);
    assert.equal(b.body.data.app_name, nuevo);

    const restore = await superadmin.patch('/api/settings', { app_name: original });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
  });

  it('las claves que siguen globales no se disfrazan de por organización', async () => {
    // ticket_prefix es global: lo que ve B es lo que vería cualquier otra org.
    const prefix = 'GLO';
    const change = await superadmin.patch('/api/settings', { ticket_prefix: prefix });
    assert.equal(change.status, 200, JSON.stringify(change.body));

    const a = await clientA.get('/api/settings');
    const b = await clientB.get('/api/settings');
    assert.equal(a.body.data.ticket_prefix, prefix);
    assert.equal(b.body.data.ticket_prefix, prefix);

    // Y una org no puede sobrescribirlo con la suya propia.
    const denied = await clientA.patch('/api/settings', { ticket_prefix: 'AAA' });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const still = await clientA.get('/api/settings');
    assert.equal(still.body.data.ticket_prefix, prefix);
  });

  it('los consumidores usan la configuración de SU organización', async () => {
    // A: escalación a 1 hora y CRÍTICO; B deja la regla global intacta.
    const patch = await clientA.patch('/api/settings', {
      rule_unassigned_hours: '1',
      rule_unassigned_priority: 'CRITICAL',
      sla_medium_hours: '7',
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const optsA = await clientA.get('/api/tickets/options');
    const optsB = await clientB.get('/api/tickets/options');

    assert.equal(optsA.body.sla_hours.MEDIUM, 7);
    assert.equal(optsA.body.rules.rule_unassigned_hours, 1);
    assert.equal(optsA.body.rules.rule_unassigned_priority, 'CRITICAL');

    assert.equal(optsB.body.sla_hours.MEDIUM, DEFAULT_SLA.MEDIUM);
    assert.notEqual(optsB.body.rules.rule_unassigned_hours, 1);
    assert.equal(optsB.body.rules.rule_unassigned_priority, 'HIGH');
  });

  it('una petición del SUPERADMIN global lee la capa por defecto, no la de A', async () => {
    const opts = await superadmin.get('/api/tickets/options');
    assert.equal(opts.status, 200);
    // Sin contexto de organización: sin sobrescrituras, los valores por defecto.
    assert.equal(opts.body.sla_hours.MEDIUM, DEFAULT_SLA.MEDIUM);
    assert.equal(opts.body.rules.rule_unassigned_priority, 'HIGH');
  });

  it('la tabla de sobrescrituras queda con una fila por organización escrita', async () => {
    const rows = db
      .prepare('SELECT organization_id, key, value FROM org_settings ORDER BY organization_id, key')
      .all();
    const byOrg = new Map();
    for (const r of rows) {
      if (!byOrg.has(r.organization_id)) byOrg.set(r.organization_id, []);
      byOrg.get(r.organization_id).push(r.key);
    }
    assert.ok(byOrg.has(orgA), 'A debe tener sobrescrituras');
    assert.ok(byOrg.has(orgB), 'B debe tener sobrescrituras');
    assert.ok(!byOrg.has(null), 'no puede existir una sobrescritura sin organización');
    assert.ok(byOrg.get(orgA).includes('sla_high_hours'));
    assert.ok(byOrg.get(orgB).includes('sla_high_hours'));
    // Y cada fila guarda la SUYA: misma clave, valor distinto.
    const valueOf = (org, key) =>
      db.prepare('SELECT value FROM org_settings WHERE organization_id = ? AND key = ?').get(org, key)?.value;
    assert.equal(valueOf(orgA, 'sla_high_hours'), '2');
    assert.equal(valueOf(orgB, 'sla_high_hours'), '6');
    assert.equal(valueOf(orgA, 'company_name'), 'Empresa A Config');
    assert.equal(valueOf(orgB, 'company_name'), 'Empresa B Config');
  });
});
