import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';

// ETAPA 4A: aislamiento real del Dashboard por organización.
// Cada admin (ORG_A/ORG_B) solo debe ver sus propios totales, ventanas,
// técnicos y tickets; el SUPERADMIN (org NULL) obtiene ceros/lista vacía —nunca
// un agregado global—; el cliente jamás elige la organización (query y cabecera
// se ignoran); y las referencias legacy cross-org no filtran identidad ajena.

const ORGA = 'AISL_D_A';
const ORGB = 'AISL_D_B';
const pass = (code) => `Org${code}Clave123!`;

let ids = {};
let deptA;
let deptB;
let catA;
let catB;
let techA;
let techB;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de aislamiento');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser(orgId, username, roleCode) {
  const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode).id;
  db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `Nombre ${username}`,
    `Apellido ${username}`,
    username,
    `${username}@organizacion.test`,
    hashPassword(pass(username)),
    null,
    'Puesto de prueba',
    roleId,
    1,
    nowIso(),
    orgId
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

const isoFromNow = (ms) => new Date(Date.now() + ms).toISOString();

async function newTicket(c, over = {}) {
  const res = await c.post('/api/tickets', {
    title: over.title || `Dash ${Math.random().toString(36).slice(2, 8)}`,
    description: 'Descripción de aislamiento de dashboard',
    category_id: over.category_id ?? catA,
    department_id: over.department_id,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.ticket;
}

const rowById = (data, id) => data.find((r) => Number(r.id) === Number(id));
const byLabel = (data) => Object.fromEntries(data.map((x) => [x.label, x]));

describe('Dashboard aislado por organización (ETAPA 4A)', () => {
  before(async () => {
    ids.orgA = insertOrg(ORGA, 'Organización A de dashboard');
    ids.orgB = insertOrg(ORGB, 'Organización B de dashboard');
    const adminA = insertUser(ids.orgA, 'admin_aisl_a', 'ADMIN');
    const adminB = insertUser(ids.orgB, 'admin_aisl_b', 'ADMIN');
    const superId = insertUser(null, 'super_aisl', 'SUPERADMIN');
    ids.adminA = adminA;
    ids.adminB = adminB;
    ids.super = superId;

    ids.cA = createClient();
    ids.cB = createClient();
    ids.cS = createClient();
    assert.equal((await ids.cA.login('admin_aisl_a', pass('admin_aisl_a'))).status, 200);
    assert.equal((await ids.cB.login('admin_aisl_b', pass('admin_aisl_b'))).status, 200);
    assert.equal((await ids.cS.login('super_aisl', pass('super_aisl'))).status, 200);

    const da = await ids.cA.post('/api/departments', { name: 'Depto Dash A', description: 'A' });
    assert.equal(da.status, 201, JSON.stringify(da.body));
    deptA = da.body.department.id;
    const db_ = await ids.cB.post('/api/departments', { name: 'Depto Dash B', description: 'B' });
    assert.equal(db_.status, 201, JSON.stringify(db_.body));
    deptB = db_.body.department.id;

    const ca = await ids.cA.post('/api/categories', { name: 'Cat Dash A', description: 'A', color: '#2563eb' });
    assert.equal(ca.status, 201, JSON.stringify(ca.body));
    catA = ca.body.category.id;
    const cb = await ids.cB.post('/api/categories', { name: 'Cat Dash B', description: 'B', color: '#dc2626' });
    assert.equal(cb.status, 201, JSON.stringify(cb.body));
    catB = cb.body.category.id;

    techA = insertUser(ids.orgA, 'tecnico_dash_a', 'TECHNICIAN');
    techB = insertUser(ids.orgB, 'tecnico_dash_b', 'TECHNICIAN');
  });

  it('/summary: las cifras de A no cambian cuando B agrega tickets; SUPERADMIN ve ceros', async () => {
    const baseA = (await ids.cA.get('/api/dashboard/summary')).body;
    const baseB = (await ids.cB.get('/api/dashboard/summary')).body;

    await newTicket(ids.cA, { priority: 'MEDIUM' });
    await newTicket(ids.cA, { priority: 'CRITICAL' });

    const afterA = (await ids.cA.get('/api/dashboard/summary')).body;
    assert.equal(afterA.total, baseA.total + 2);
    assert.equal(afterA.openTotal, baseA.openTotal + 2);
    assert.equal(afterA.critical, baseA.critical + 1);
    assert.ok(afterA.createdMonth >= baseA.createdMonth, 'createdMonth no debe retroceder');

    const afterB = (await ids.cB.get('/api/dashboard/summary')).body;
    assert.equal(afterB.total, baseB.total, 'A creó tickets; B no debe verlos');
    assert.equal(afterB.openTotal, baseB.openTotal);
    assert.equal(afterB.critical, baseB.critical);

    await newTicket(ids.cB, { priority: 'HIGH', category_id: catB });
    const afterA2 = (await ids.cA.get('/api/dashboard/summary')).body;
    assert.equal(afterA2.total, afterA.total, 'el ticket de B no debe alterar los totales de A');
    assert.equal(afterA2.critical, afterA.critical);

    const sup = (await ids.cS.get('/api/dashboard/summary')).body;
    assert.equal(sup.total, 0);
    assert.equal(sup.openTotal, 0);
    assert.equal(sup.critical, 0);
    assert.equal(sup.createdMonth, 0);
    assert.equal(sup.resolvedMonth, 0);
    assert.equal(Object.values(sup.counts).every((n) => n === 0), true, 'counts debe venir en cero');
  });

  it('/by-status: cada org ve solo sus estados', async () => {
    const beforeA = (await ids.cA.get('/api/dashboard/by-status')).body.data;
    const beforeB = (await ids.cB.get('/api/dashboard/by-status')).body.data;
    const openB = beforeB.find((r) => r.status === 'OPEN')?.n || 0;

    await newTicket(ids.cB, { category_id: catB });

    const afterA = (await ids.cA.get('/api/dashboard/by-status')).body.data;
    assert.deepEqual(afterA, beforeA, 'B creó un ticket; el reparto de A no debe cambiar');
    const afterB = (await ids.cB.get('/api/dashboard/by-status')).body.data;
    assert.equal(afterB.find((r) => r.status === 'OPEN')?.n, openB + 1);

    assert.deepEqual((await ids.cS.get('/api/dashboard/by-status')).body.data, []);
  });

  it('/sla: los vencidos y el "top" aíslan la organización', async () => {
    const baseA = (await ids.cA.get('/api/dashboard/sla')).body;
    const baseB = (await ids.cB.get('/api/dashboard/sla')).body;

    const tA = await newTicket(ids.cA, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-2 * 3600_000), tA.id);

    const aAfter = (await ids.cA.get('/api/dashboard/sla')).body;
    assert.equal(aAfter.overdue, baseA.overdue + 1, 'A debe ver su vencido propio');
    assert.ok(rowById(aAfter.top, tA.id), 'A debe ver su propio id en el top');
    const bAfter1 = (await ids.cB.get('/api/dashboard/sla')).body;
    assert.equal(bAfter1.overdue, baseB.overdue, 'el vencido de A no debe contar para B');
    assert.equal(rowById(bAfter1.top, tA.id), undefined, 'B no debe ver el id del ticket de A');

    const tB = await newTicket(ids.cB, { priority: 'LOW', category_id: catB });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-3600_000), tB.id);

    const aAfter2 = (await ids.cA.get('/api/dashboard/sla')).body;
    assert.equal(rowById(aAfter2.top, tB.id), undefined, 'A no debe ver el id del vencido de B');
    const bAfter2 = (await ids.cB.get('/api/dashboard/sla')).body;
    assert.equal(bAfter2.overdue, bAfter1.overdue + 1);
    assert.ok(rowById(bAfter2.top, tB.id), 'B debe ver su propio id en el top');

    const sup = (await ids.cS.get('/api/dashboard/sla')).body;
    assert.equal(sup.overdue, 0);
    assert.equal(sup.atRisk, 0);
    assert.equal(sup.healthy, 0);
    assert.deepEqual(sup.top, []);
  });

  it('/by-priority: las prioridades se cuentan por org', async () => {
    const beforeA = (await ids.cA.get('/api/dashboard/by-priority')).body;
    const beforeB = (await ids.cB.get('/api/dashboard/by-priority')).body;

    await newTicket(ids.cB, { priority: 'HIGH', category_id: catB });

    const afterA = (await ids.cA.get('/api/dashboard/by-priority')).body;
    assert.deepEqual(afterA.data, beforeA.data, 'B creó un HIGH; A no debe cambiar');
    assert.equal(afterA.open, beforeA.open);

    const afterB = (await ids.cB.get('/api/dashboard/by-priority')).body;
    const highB = afterB.data.find((r) => r.priority === 'HIGH')?.n || 0;
    assert.equal(highB, (beforeB.data.find((r) => r.priority === 'HIGH')?.n || 0) + 1);
    assert.equal(afterB.open, beforeB.open + 1);

    const sup = (await ids.cS.get('/api/dashboard/by-priority')).body;
    assert.deepEqual(sup.data, []);
    assert.equal(sup.open, 0);
  });

  it('/by-category: cada org solo ve sus categorías y los tickets propios', async () => {
    const dataA = (await ids.cA.get('/api/dashboard/by-category')).body.data;
    assert.ok(rowById(dataA, catA), 'A debe ver su propia categoría');
    assert.equal(rowById(dataA, catB), undefined, 'A no debe ver la categoría de B');
    const nCatA = rowById(dataA, catA).n;
    const expectedCatA = db.prepare(
      'SELECT COUNT(*) AS n FROM tickets WHERE category_id = ? AND organization_id = ?'
    ).get(catA, ids.orgA).n;
    assert.equal(nCatA, expectedCatA, 'el conteo de A debe ser sobre tickets de A');

    await newTicket(ids.cB, { category_id: catB });
    const dataA2 = (await ids.cA.get('/api/dashboard/by-category')).body.data;
    assert.equal(rowById(dataA2, catA).n, nCatA, 'el ticket de B en catB no debe inflar catA');
    assert.equal(rowById(dataA2, catB), undefined);
    const dataB = (await ids.cB.get('/api/dashboard/by-category')).body.data;
    assert.ok(rowById(dataB, catB), 'B debe ver su propia categoría');
    assert.equal(rowById(dataB, catA), undefined, 'B no debe ver la categoría de A');

    assert.deepEqual((await ids.cS.get('/api/dashboard/by-category')).body.data, []);
  });

  it('/by-department: cada org solo ve sus departamentos', async () => {
    const beforeA = (await ids.cA.get('/api/dashboard/by-department')).body.data;
    assert.ok(rowById(beforeA, deptA), 'A debe ver su departamento');
    assert.equal(rowById(beforeA, deptB), undefined);

    await newTicket(ids.cA, { priority: 'MEDIUM', department_id: deptA });
    const afterA = (await ids.cA.get('/api/dashboard/by-department')).body.data;
    assert.ok(rowById(afterA, deptA).n >= rowById(beforeA, deptA).n, 'A debe contar su ticket');
    assert.equal(rowById(afterA, deptB), undefined);

    await newTicket(ids.cB, { category_id: catB, department_id: deptB });
    const dataB = (await ids.cB.get('/api/dashboard/by-department')).body.data;
    assert.ok(rowById(dataB, deptB), 'B debe ver su departamento');
    assert.equal(rowById(dataB, deptA), undefined, 'B no debe ver el departamento de A');

    assert.deepEqual((await ids.cS.get('/api/dashboard/by-department')).body.data, []);
  });

  it('/by-technician: la carga se atribuye solo a técnicos de la misma org', async () => {
    const tA = await newTicket(ids.cA);
    const patchA = await ids.cA.patch(`/api/tickets/${tA.id}`, { assigned_to_id: techA });
    assert.equal(patchA.status, 200, JSON.stringify(patchA.body));

    const tB2 = await newTicket(ids.cB, { category_id: catB });
    const patchB = await ids.cB.patch(`/api/tickets/${tB2.id}`, { assigned_to_id: techB });
    assert.equal(patchB.status, 200, JSON.stringify(patchB.body));

    const dataA = (await ids.cA.get('/api/dashboard/by-technician')).body.data;
    assert.ok(rowById(dataA, techA), 'A debe tener la fila de su técnico');
    assert.equal(rowById(dataA, techB), undefined, 'A no debe ver al técnico de B');
    const dataB = (await ids.cB.get('/api/dashboard/by-technician')).body.data;
    assert.ok(rowById(dataB, techB), 'B debe tener la fila de su técnico');
    assert.equal(rowById(dataB, techA), undefined, 'B no debe ver al técnico de A');

    const unassignedA = (await ids.cA.get('/api/dashboard/by-technician')).body.unassigned;
    const unassignedB = (await ids.cB.get('/api/dashboard/by-technician')).body.unassigned;
    await newTicket(ids.cB, { category_id: catB });
    assert.equal((await ids.cB.get('/api/dashboard/by-technician')).body.unassigned, unassignedB + 1);
    assert.equal((await ids.cA.get('/api/dashboard/by-technician')).body.unassigned, unassignedA, 'el ticket de B no altera "sin técnico" de A');

    const totalsA = (await ids.cA.get('/api/dashboard/by-technician')).body.totals;
    assert.ok(totalsA.technicians >= 1, 'A debe contabilizar al menos a su técnico');
    assert.equal(totalsA.overdue, 0, 'A no debe arrastrar vencidos ajenos en totales');

    const sup = (await ids.cS.get('/api/dashboard/by-technician')).body;
    assert.deepEqual(sup.data, []);
    assert.equal(sup.unassigned, 0);
    assert.deepEqual(sup.totals, { technicians: 0, active: 0, overdue: 0 });
  });

  it('/needs-attention: el triaje no mezcla orgs ni expone ids ajenos', async () => {
    const baseA = (await ids.cA.get('/api/dashboard/needs-attention')).body;
    const baseB = (await ids.cB.get('/api/dashboard/needs-attention')).body;

    const tA = await newTicket(ids.cA, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-4 * 3600_000), tA.id);
    const aAfter = (await ids.cA.get('/api/dashboard/needs-attention')).body;
    assert.equal(aAfter.totals.overdue, baseA.totals.overdue + 1);
    assert.ok(rowById(aAfter.data, tA.id), 'A debe ver su propio ticket en el triaje');
    assert.ok(aAfter.data.find((r) => r.id === tA.id).reasons.includes('SLA_OVERDUE'));
    const bAfter1 = (await ids.cB.get('/api/dashboard/needs-attention')).body;
    assert.equal(bAfter1.totals.overdue, baseB.totals.overdue, 'el vencido de A no debe contar para B');
    assert.equal(rowById(bAfter1.data, tA.id), undefined, 'B no debe ver el id del ticket de A');

    const tB = await newTicket(ids.cB, { priority: 'LOW', category_id: catB });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-2 * 3600_000), tB.id);
    const aAfter2 = (await ids.cA.get('/api/dashboard/needs-attention')).body;
    assert.equal(rowById(aAfter2.data, tB.id), undefined, 'A no debe ver el id del vencido de B');
    const bAfter2 = (await ids.cB.get('/api/dashboard/needs-attention')).body;
    assert.ok(rowById(bAfter2.data, tB.id), 'B debe ver su propio ticket en el triaje');

    const sup = (await ids.cS.get('/api/dashboard/needs-attention')).body;
    assert.deepEqual(sup.data, []);
    assert.equal(sup.totals.total, 0);
    assert.equal(sup.totals.overdue, 0);
    assert.equal(sup.totals.critical, 0);
    assert.equal(sup.totals.dueSoon, 0);
    assert.equal(sup.totals.unassigned, 0);
  });

  it('/trend: las ventanas cuentan solo lo propio', async () => {
    const beforeA = (await ids.cA.get('/api/dashboard/trend')).body.data;
    const beforeB = byLabel((await ids.cB.get('/api/dashboard/trend')).body.data);

    await newTicket(ids.cB, { category_id: catB });

    const afterA = (await ids.cA.get('/api/dashboard/trend')).body.data;
    assert.deepEqual(afterA, beforeA, 'B creó un ticket hoy; la tendencia de A no debe cambiar');
    const afterB = byLabel((await ids.cB.get('/api/dashboard/trend')).body.data);
    const today = new Date().toISOString().slice(0, 10);
    if (beforeB[today]) {
      assert.equal(afterB[today].created, beforeB[today].created + 1, 'B debe sumar su creación de hoy');
    }

    const sup = (await ids.cS.get('/api/dashboard/trend')).body.data;
    assert.equal(sup.length, 14, 'el SUPERADMIN recibe la ventana con ceros');
    assert.equal(sup.every((x) => x.created === 0 && x.resolved === 0), true);
  });

  it('/recent: expone solo tickets propios', async () => {
    const tA = await newTicket(ids.cA, { title: 'SoloA Reciente Dashboard' });
    await newTicket(ids.cB, { title: 'SoloB Reciente Dashboard', category_id: catB });

    const dataA = (await ids.cA.get('/api/dashboard/recent')).body.data;
    assert.ok(rowById(dataA, tA.id), 'A debe ver su propio ticket reciente');
    assert.equal(dataA.some((r) => r.title === 'SoloB Reciente Dashboard'), false, 'A no debe ver el reciente de B');
    const dataB = (await ids.cB.get('/api/dashboard/recent')).body.data;
    assert.equal(dataB.some((r) => r.title === 'SoloA Reciente Dashboard'), false, 'B no debe ver el reciente de A');
    assert.equal((await ids.cS.get('/api/dashboard/recent')).body.data.length, 0);
  });

  it('la organización nunca se elige desde la query ni la cabecera', async () => {
    const baseA = (await ids.cA.get('/api/dashboard/summary')).body;

    const spoofQuery = (await ids.cA.get(`/api/dashboard/summary?organization_id=${ids.orgB}`)).body;
    assert.deepEqual(spoofQuery, baseA, '?organization_id= no debe cambiar el contexto de A');

    const spoofHeader = (await ids.cA.get('/api/dashboard/summary', {
      headers: { 'x-organization-id': String(ids.orgB) },
    })).body;
    assert.deepEqual(spoofHeader, baseA, 'x-organization-id no debe cambiar el contexto de A');

    const recentB = (await ids.cB.get(`/api/dashboard/recent?organization_id=${ids.orgA}`)).body.data;
    assert.equal(recentB.some((r) => r.title === 'SoloA Reciente Dashboard'), false, 'B no debe colarse en datos de A');

    const supSpoof = (await ids.cS.get(`/api/dashboard/summary?organization_id=${ids.orgA}`)).body;
    assert.equal(supSpoof.total, 0, 'el SUPERADMIN sigue viendo ceros aunque forje una org');
  });

  it('las referencias legacy cross-org no filtran identidad ajena al dashboard', async () => {
    // Dato legacy típico de la migración: un ticket de A que apunta a un
    // usuario y a un rol de B. No pertenece a ninguna organización de datos
    // vivos, pero su org es A y el JOIN reforzado no debe sacar identidad de B.
    const legacy = db.prepare(
      `INSERT INTO tickets (ticket_number, title, description, reporter_id, category_id, priority, status, sla_due_at, organization_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'MEDIUM', 'OPEN', ?, ?, ?)`
    ).run(
      'LEGACY-CROSS-ORG-A',
      'Legacy cross-org dashboard',
      'Ticket histórico de A con reporter y asignado de B',
      ids.adminB,
      null,
      isoFromNow(-3 * 3600_000),
      ids.orgA,
      nowIso()
    );
    const legacyId = legacy.lastInsertRowid;
    db.prepare('UPDATE tickets SET assigned_to_id = ? WHERE id = ?').run(techB, legacyId);

    const recentA = (await ids.cA.get('/api/dashboard/recent')).body.data;
    const rowRecent = rowById(recentA, legacyId);
    assert.ok(rowRecent, 'A debe ver su ticket legacy');
    assert.equal(rowRecent.reporter_name, null, 'no debe filtrarse el nombre del reporter de B');
    assert.equal(rowRecent.assigned_name, null, 'no debe filtrarse el nombre del asignado de B');

    const techArows = (await ids.cA.get('/api/dashboard/by-technician')).body.data;
    assert.equal(rowById(techArows, techB), undefined, 'la carga del ticket de A no debe atribuirse al técnico de B');

    const slaA = (await ids.cA.get('/api/dashboard/sla')).body;
    const rowSla = rowById(slaA.top, legacyId);
    assert.ok(rowSla, 'el vencido legacy sí aparece en el top de A');
    assert.equal(rowSla.reporter_name, null, 'el top de A no debe filtrar al reporter de B');
    const slaB = (await ids.cB.get('/api/dashboard/sla')).body;
    assert.equal(rowById(slaB.top, legacyId), undefined, 'el ticket de A no aparece en el top de B');
  });

  it('/needs-attention: una asignación cross-org se neutraliza sin ocultar el ticket', async () => {
    const t = await newTicket(ids.cA, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-2 * 3600_000), t.id);
    db.prepare('UPDATE tickets SET assigned_to_id = ? WHERE id = ?').run(techB, t.id);

    const aRes = (await ids.cA.get('/api/dashboard/needs-attention')).body;
    const row = rowById(aRes.data, t.id);
    assert.ok(row, 'Admin A debe recibir su propio ticket (no se oculta)');
    assert.equal(row.assigned_to_id, null, 'no debe exponer el id del usuario B');
    assert.equal(row.technician_name, null, 'no debe exponer el nombre del usuario B');
    assert.equal(row.reasons.includes('UNASSIGNED'), true, 'la asignación inválida cuenta como sin dueño');
    assert.equal(row.reasons.includes('SLA_OVERDUE'), true, 'y sigue en el triaje por vencido');
    assert.ok(!JSON.stringify(aRes).includes('tecnico_dash_b'), 'ningún dato de B en la respuesta');

    const bRes = (await ids.cB.get('/api/dashboard/needs-attention')).body;
    assert.equal(rowById(bRes.data, t.id), undefined, 'Admin B no debe recibir el ticket de A');

    const sup = (await ids.cS.get('/api/dashboard/needs-attention')).body;
    assert.equal(rowById(sup.data, t.id), undefined, 'SUPERADMIN no debe recibirlo');
  });

  it('/by-technician: los totales no cuentan una asignación cross-org como técnico válido', async () => {
    const before = (await ids.cA.get('/api/dashboard/by-technician')).body;

    const legacyA = await newTicket(ids.cA, { priority: 'LOW' });
    db.prepare('UPDATE tickets SET assigned_to_id = ? WHERE id = ?').run(techB, legacyA.id);
    db.prepare('UPDATE tickets SET sla_due_at = ? WHERE id = ?').run(isoFromNow(-2 * 3600_000), legacyA.id);

    const validA = await newTicket(ids.cA, { priority: 'MEDIUM' });
    const patch = await ids.cA.patch(`/api/tickets/${validA.id}`, { assigned_to_id: techA });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const after = (await ids.cA.get('/api/dashboard/by-technician')).body;
    assert.equal(rowById(after.data, techB), undefined, 'USER_B no aparece como técnico de A');
    assert.ok(rowById(after.data, techA), 'el técnico válido de A sí aparece');
    assert.ok(rowById(after.data, techA).active >= 1, 'y suma su carga');

    assert.equal(after.totals.technicians, before.totals.technicians, 'technicians no crece por la referencia cross-org');
    assert.equal(after.totals.active, before.totals.active + 1, 'active crece solo por el técnico válido');
    assert.equal(after.totals.overdue, before.totals.overdue, 'overdue no cuenta como carga del técnico B');
    assert.equal(after.unassigned, before.unassigned + 1, 'la asignación inválida se trata como sin dueño');

    const summary = (await ids.cA.get('/api/dashboard/summary')).body;
    assert.equal(after.totals.active + after.unassigned, summary.openTotal, 'activos + sin dueño = abiertos del resumen');

    const bRes = (await ids.cB.get('/api/dashboard/by-technician')).body;
    assert.equal(bRes.totals.active, bRes.data.reduce((a, b) => a + b.active, 0), 'B solo agrega su propia carga');

    const sup = (await ids.cS.get('/api/dashboard/by-technician')).body;
    assert.deepEqual(sup.data, []);
    assert.equal(sup.unassigned, 0);
    assert.deepEqual(sup.totals, { technicians: 0, active: 0, overdue: 0 });
  });
});