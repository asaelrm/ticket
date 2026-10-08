import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import {
  getSetting,
  getAllSettings,
  getGlobalSettings,
  setGlobalSetting,
  setOrgSetting,
  hasOrgOverride,
} from '../src/utils/settingsStore.js';
import { ORG_KEYS, GLOBAL_KEYS } from '../src/utils/settings.js';
import { DEFAULT_SLA } from '../src/utils/sla.js';

// V1: el repositorio de configuración es la pieza que decide qué ve y qué puede
// escribir cada organización. Estas pruebas usan DOS organizaciones para
// comprobar que una sobrescritura de A no aparece jamás en B.

const ORG_A = 'CFGA';
const ORG_B = 'CFGB';

let orgA;
let orgB;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de configuración');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

before(() => {
  orgA = insertOrg(ORG_A, 'Configuración A');
  orgB = insertOrg(ORG_B, 'Configuración B');
});

describe('settingsStore: dos organizaciones, dos configuraciones', () => {
  it('una clave global la ven igual las dos organizaciones', async () => {
    await setGlobalSetting('sla_medium_hours', '12', null);

    assert.equal(await getSetting('sla_medium_hours', orgA), '12');
    assert.equal(await getSetting('sla_medium_hours', orgB), '12');
    assert.equal((await getGlobalSettings()).sla_medium_hours, '12');
  });

  it('la sobrescritura de A no cambia el valor de B', async () => {
    await setOrgSetting(orgA, 'sla_medium_hours', '3', null);

    assert.equal(await getSetting('sla_medium_hours', orgA), '3');
    // B no tiene sobrescritura: sigue en el valor global de la plataforma.
    assert.equal(await getSetting('sla_medium_hours', orgB), '12');
    assert.equal(await hasOrgOverride(orgA, 'sla_medium_hours'), true);
    assert.equal(await hasOrgOverride(orgB, 'sla_medium_hours'), false);
  });

  it('la sobrescritura de B tampoco afecta a A (aislamiento cruzado)', async () => {
    await setOrgSetting(orgB, 'sla_medium_hours', '48', null);

    assert.equal(await getSetting('sla_medium_hours', orgA), '3');
    assert.equal(await getSetting('sla_medium_hours', orgB), '48');

    const rowsA = db.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE organization_id = ?').get(orgA).n;
    const rowsB = db.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE organization_id = ?').get(orgB).n;
    assert.equal(rowsA, rowsB, 'cada organización debe tener exactamente su sobrescritura');
  });

  it('sin sobrescritura hereda el global; sin global, el valor por defecto', async () => {
    // orgA tiene sobrescritura de sla_medium_hours, orgC no: crea una tercera
    // organización para comprobar los dos tramos del fallback.
    db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
      .run('CFGC', 'Configuración C', 'Sin sobrescritura');
    const orgC = db.prepare("SELECT id FROM organizations WHERE code = 'CFGC'").get().id;

    db.prepare("DELETE FROM settings WHERE key = 'sla_high_hours'").run();
    assert.equal(await getSetting('sla_high_hours', orgC), String(DEFAULT_SLA.HIGH));
    assert.equal(await getSetting('sla_high_hours', orgA), String(DEFAULT_SLA.HIGH));

    await setGlobalSetting('sla_high_hours', '6', null);
    assert.equal(await getSetting('sla_high_hours', orgC), '6');
    assert.equal(await getSetting('sla_high_hours', orgA), '6', 'A no ha tocado esta clave');
  });

  it('las claves globales ignoran cualquier sobrescritura de organización', async () => {
    await setGlobalSetting('app_name', 'SIFHA', null);

    await assert.rejects(
      () => setOrgSetting(orgA, 'app_name', 'OTRO', null),
      /no es configurable por organización/
    );

    // Aunque existiera una fila huérfana en org_settings, resolveSetting no la
    // miraría: la clave global se resuelve siempre contra la capa global.
    db.prepare('INSERT INTO org_settings (organization_id, key, value) VALUES (?, ?, ?)')
      .run(orgA, 'ticket_prefix', 'AAAA');
    await setGlobalSetting('ticket_prefix', 'TCK', null);
    assert.equal(await getSetting('ticket_prefix', orgA), 'TCK');
    assert.equal(await getSetting('ticket_prefix', orgB), 'TCK');
    assert.equal(await getSetting('app_name', orgA), 'SIFHA');
    assert.equal(await getSetting('app_name', orgB), 'SIFHA');
    db.prepare('DELETE FROM org_settings WHERE organization_id = ? AND key = ?').run(orgA, 'ticket_prefix');
  });

  it('no admite escrituras por organización sin contexto ni claves desconocidas', async () => {
    await assert.rejects(() => setOrgSetting(null, 'sla_high_hours', '1', null), /requiere una organización/);
    await assert.rejects(
      () => setOrgSetting(orgA, 'no_existe', '1', null),
      /no es configurable por organización/
    );
    assert.equal(await getSetting('no_existe', orgA), null);
    assert.equal(await setGlobalSetting('no_existe', '1', null), false);
  });

  it('getAllSettings devuelve las 22 claves resueltas para cada organización', async () => {
    const a = await getAllSettings(orgA);
    const b = await getAllSettings(orgB);
    const expected = ORG_KEYS.length + GLOBAL_KEYS.length;

    assert.equal(Object.keys(a).length, expected);
    assert.equal(Object.keys(b).length, expected);
    // Las claves que A ha tocado son las únicas que deben diferir.
    assert.notEqual(a.sla_medium_hours, b.sla_medium_hours);
    for (const key of GLOBAL_KEYS) assert.equal(a[key], b[key], `${key} debe ser idéntica`);
    // Ninguna clave puede quedar sin resolver: todas tienen defecto en
    // DEFAULT_SETTINGS, así que nunca devuelven undefined ni null.
    for (const [key, value] of Object.entries(a)) {
      assert.notEqual(value, undefined, `${key} no puede quedar sin resolver`);
      assert.notEqual(value, null, `${key} no puede quedar en null`);
    }
  });

  it('getAllSettings sin organización (SUPERADMIN global) no lee sobrescrituras', async () => {
    const globalView = await getAllSettings(null);
    assert.equal(globalView.sla_medium_hours, (await getGlobalSettings()).sla_medium_hours);
    assert.equal(await getSetting('sla_medium_hours', null), (await getGlobalSettings()).sla_medium_hours);
  });
});
