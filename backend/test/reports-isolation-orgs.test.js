import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './helpers.js';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';

// ETAPA 4B: aislamiento real de los reportes por organización.
// Los 9 endpoints de /api/reports solo deben medir tickets de la organización
// de la sesión; las categorías y departamentos visibles pertenecen a la misma
// org; el cliente jamás elige la organización (query y cabecera se ignoran);
// el SUPERADMIN (org NULL) obtiene ceros/lista vacía, nunca un agregado global;
// y una referencia legacy cross-org no filtra identidad ajena (left join
// reforzado → etiqueta segura 'Sin...'), coherente con ETAPA 4A.

const ORGA = 'AISL_R_A';
const ORGB = 'AISL_R_B';
const pass = (code) => `Org${code}Clave123!`;
const repName = (u) => `Nombre ${u} Apellido ${u}`;

let ids = {};
let deptA;
let deptB;
let catA;
let catB;
let catInactiveA;
let teamA;
let teamB;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización de prueba de aislamiento de reportes');
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

const rowById = (data, id) => data.find((r) => Number(r.id) === Number(id));
const byLabel = (data) => Object.fromEntries(data.map((x) => [x.label, x]));
const byName = (data) => Object.fromEntries(data.map((x) => [x.name, x]));

async function newTicket(client, over = {}) {
  const res = await client.post('/api/tickets', {
    title: over.title || `ReporteAislamiento ${Math.random().toString(36).slice(2, 8)}`,
    description: 'Descripción de aislamiento de reportes',
    category_id: over.category_id ?? catA,
    department_id: over.department_id,
    priority: over.priority || 'MEDIUM',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.ticket;
}

// Fija la resolución con fechas conocidas para poder medir CSAT/rendimiento
// sin esperar al reloj, igual que reports-csat-performance.test.js.
function registrarResolucion(ticketId, { tecnico, csat }) {
  const creado = '2026-03-15T09:00:00.000Z';
  const ahora = '2026-03-15T12:00:00.000Z';
  db.prepare(
    `UPDATE tickets
        SET status = 'CLOSED', created_at = ?, resolved_at = ?, closed_at = ?,
            resolved_by = ?, closed_by = ?, time_spent_minutes = 45,
            sla_due_at = '2026-03-15T18:00:00.000Z',
            csat_rating = ?, csat_comment = ?, csat_answered_at = ?
      WHERE id = ?`
  ).run(creado, ahora, ahora, tecnico, tecnico, csat ?? null, csat ? 'Comentario de prueba' : null, csat ? ahora : null, ticketId);
}

describe('Reportes aislados por organización (ETAPA 4B)', () => {
  before(async () => {
    ids.orgA = insertOrg(ORGA, 'Organización A de reportes');
    ids.orgB = insertOrg(ORGB, 'Organización B de reportes');

    ids.adminA = insertUser(ids.orgA, 'admin_rep_a', 'ADMIN');
    ids.adminB = insertUser(ids.orgB, 'admin_rep_b', 'ADMIN');
    ids.super = insertUser(null, 'super_rep', 'SUPERADMIN');
    ids.tecA = insertUser(ids.orgA, 'tec_rep_a', 'TECHNICIAN');
    ids.tecB = insertUser(ids.orgB, 'tec_rep_b', 'TECHNICIAN');
    ids.repA = insertUser(ids.orgA, 'rep_user_a', 'EMPLOYEE');
    ids.repB = insertUser(ids.orgB, 'rep_user_b', 'EMPLOYEE');

    ids.cA = createClient();
    ids.cB = createClient();
    ids.cS = createClient();
    ids.repAC = createClient();
    ids.repBC = createClient();
    assert.equal((await ids.cA.login('admin_rep_a', pass('admin_rep_a'))).status, 200);
    assert.equal((await ids.cB.login('admin_rep_b', pass('admin_rep_b'))).status, 200);
    assert.equal((await ids.cS.login('super_rep', pass('super_rep'))).status, 200);
    assert.equal((await ids.repAC.login('rep_user_a', pass('rep_user_a'))).status, 200);
    assert.equal((await ids.repBC.login('rep_user_b', pass('rep_user_b'))).status, 200);

    const da = await ids.cA.post('/api/departments', { name: 'Depto Report A', description: 'A' });
    assert.equal(da.status, 201, JSON.stringify(da.body));
    deptA = da.body.department.id;
    const db_ = await ids.cB.post('/api/departments', { name: 'Depto Report B', description: 'B' });
    assert.equal(db_.status, 201, JSON.stringify(db_.body));
    deptB = db_.body.department.id;

    const ca = await ids.cA.post('/api/categories', { name: 'Cat Report A', description: 'A', color: '#2563eb' });
    assert.equal(ca.status, 201, JSON.stringify(ca.body));
    catA = ca.body.category.id;
    const cb = await ids.cB.post('/api/categories', { name: 'Cat Report B', description: 'B', color: '#dc2626' });
    assert.equal(cb.status, 201, JSON.stringify(cb.body));
    catB = cb.body.category.id;

    const ci = await ids.cA.post('/api/categories', { name: 'Cat Report A Inactiva', description: 'A', color: '#64748b' });
    assert.equal(ci.status, 201, JSON.stringify(ci.body));
    catInactiveA = ci.body.category.id;
    db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(catInactiveA);

    const ta = await ids.cA.post('/api/teams', { name: 'Equipo Report A', description: 'A' });
    assert.equal(ta.status, 201, JSON.stringify(ta.body));
    teamA = ta.body.team.id;
    const tb = await ids.cB.post('/api/teams', { name: 'Equipo Report B', description: 'B' });
    assert.equal(tb.status, 201, JSON.stringify(tb.body));
    teamB = tb.body.team.id;
  });

  it('/summary: las cifras de A no cambian cuando B agrega tickets; SUPERADMIN ve ceros', async () => {
    const baseA = (await ids.cA.get('/api/reports/summary')).body;
    const baseB = (await ids.cB.get('/api/reports/summary')).body;

    const t1 = await newTicket(ids.cA, { title: 'SoloA Resumen' });
    db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * 86400_000).toISOString(), t1.id);
    await newTicket(ids.cA, { priority: 'CRITICAL' });

    const afterA = (await ids.cA.get('/api/reports/summary')).body;
    assert.equal(afterA.total, baseA.total + 2);

    const afterB = (await ids.cB.get('/api/reports/summary')).body;
    assert.equal(afterB.total, baseB.total, 'A creó tickets; B no debe verlos');
    assert.equal(afterB.open, baseB.open);

    await newTicket(ids.repBC, { category_id: catB, title: 'SoloB Resumen' });

    const afterA2 = (await ids.cA.get('/api/reports/summary')).body;
    assert.equal(afterA2.total, afterA.total, 'el ticket de B no debe alterar los totales de A');

    const sup = (await ids.cS.get('/api/reports/summary')).body;
    assert.equal(sup.total, 0);
    assert.equal(sup.open, 0);
    assert.equal(sup.resolved, 0);
    assert.equal(sup.unresolved_week, 0);
    assert.equal(sup.avg_resolution_hours, 0);
  });

  it('/by-status: cada org ve solo sus estados; SUPERADMIN no tiene estados', async () => {
    const beforeA = (await ids.cA.get('/api/reports/by-status')).body.data;
    const beforeB = (await ids.cB.get('/api/reports/by-status')).body.data;
    const openB = beforeB.find((r) => r.status === 'OPEN')?.n || 0;

    await newTicket(ids.cB, { category_id: catB, title: 'SoloB Estado' });

    const afterA = (await ids.cA.get('/api/reports/by-status')).body.data;
    assert.deepEqual(afterA, beforeA, 'B creó un ticket; el reparto de A no debe cambiar');
    const afterB = (await ids.cB.get('/api/reports/by-status')).body.data;
    assert.equal(afterB.find((r) => r.status === 'OPEN')?.n, openB + 1, 'B debe sumar su propio abierto');

    assert.deepEqual((await ids.cS.get('/api/reports/by-status')).body.data, []);
  });

  it('/by-priority: las prioridades se cuentan por org', async () => {
    const beforeA = (await ids.cA.get('/api/reports/by-priority')).body.data;

    await newTicket(ids.cB, { priority: 'HIGH', category_id: catB, title: 'SoloB Prioridad' });

    const afterA = (await ids.cA.get('/api/reports/by-priority')).body.data;
    assert.deepEqual(afterA, beforeA, 'B creó un HIGH; A no debe cambiar');
    const highA = afterA.find((r) => r.priority === 'CRITICAL');
    const highA2 = (await ids.cA.get('/api/reports/by-priority')).body.data.find((r) => r.priority === 'CRITICAL');
    assert.equal(highA?.n, highA2?.n, 'el total de A se mantiene estable');

    assert.deepEqual((await ids.cS.get('/api/reports/by-priority')).body.data, []);
  });

  it('/by-category: A ve su categoría, no la de B, ni las categorías inactivas', async () => {
    await newTicket(ids.cA, { category_id: catA, title: 'Categoria de A' });

    const dataA = (await ids.cA.get('/api/reports/by-category')).body.data;
    assert.ok(byName(dataA)['Cat Report A'], 'A debe ver su propia categoría');
    assert.equal(byName(dataA)['Cat Report B'], undefined, 'A no debe ver la categoría de B');
    assert.equal(byName(dataA)['Cat Report A Inactiva'], undefined, 'las categorías inactivas no salen en reportes');
    assert.ok(byName(dataA)['Cat Report A'].n >= 1, 'el conteo de A es sobre tickets de A');

    await newTicket(ids.cB, { category_id: catB, title: 'Categoria de B' });
    const dataA2 = (await ids.cA.get('/api/reports/by-category')).body.data;
    assert.equal(byName(dataA2)['Cat Report A'].n, byName(dataA)['Cat Report A'].n, 'el ticket de B en catB no infla catA');
    assert.equal(byName(dataA2)['Cat Report B'], undefined);

    const dataB = (await ids.cB.get('/api/reports/by-category')).body.data;
    assert.ok(byName(dataB)['Cat Report B'], 'B debe ver su propia categoría');
    assert.equal(byName(dataB)['Cat Report A'], undefined, 'B no debe ver la categoría de A');

    assert.deepEqual((await ids.cS.get('/api/reports/by-category')).body.data, []);
  });

  it('/by-department: A solo ve su departamento', async () => {
    await newTicket(ids.cA, { department_id: deptA, title: 'Departamento de A' });

    const dataA = (await ids.cA.get('/api/reports/by-department')).body.data;
    assert.ok(byName(dataA)['Depto Report A'], 'A debe ver su departamento');
    assert.equal(byName(dataA)['Depto Report B'], undefined, 'A no debe ver el departamento de B');
    assert.ok(byName(dataA)['Depto Report A'].n >= 1);

    await newTicket(ids.cB, { department_id: deptB, category_id: catB, title: 'Departamento de B' });
    const dataA2 = (await ids.cA.get('/api/reports/by-department')).body.data;
    assert.equal(byName(dataA2)['Depto Report B'], undefined, 'el ticket de B no crea filas ajenas en A');
    const dataB = (await ids.cB.get('/api/reports/by-department')).body.data;
    assert.ok(byName(dataB)['Depto Report B'], 'B debe ver su departamento');

    assert.deepEqual((await ids.cS.get('/api/reports/by-department')).body.data, []);
  });

  it('/performance by_user: los reporteros se agrupan dentro de la org', async () => {
    await newTicket(ids.repAC, { title: 'Reporteo de A' });
    await newTicket(ids.repBC, { category_id: catB, title: 'Reporteo de B' });

    const resA = (await ids.cA.get('/api/reports/performance')).body;
    const labelsA = resA.by_user.map((r) => r.reporter);
    assert.ok(labelsA.includes(repName('rep_user_a')), 'A debe ver a su reportero');
    assert.equal(labelsA.includes(repName('rep_user_b')), false, 'A no debe ver el reportero de B');
    assert.equal(labelsA.includes(repName('admin_rep_b')), false, 'A no debe ver a usuarios de B');

    const resB = (await ids.cB.get('/api/reports/performance')).body;
    const labelsB = resB.by_user.map((r) => r.reporter);
    assert.ok(labelsB.includes(repName('rep_user_b')), 'B debe ver a su reportero');
    assert.equal(labelsB.includes(repName('rep_user_a')), false, 'B no debe ver el reportero de A');

    const sup = (await ids.cS.get('/api/reports/performance')).body;
    assert.deepEqual(sup.by_day, []);
    assert.deepEqual(sup.by_user, []);
    assert.deepEqual(sup.by_technician, []);
    assert.deepEqual(sup.by_team.data, []);
  });

  it('/performance by_technician y by_team solo atribuyen a técnicos/equipos de la misma org', async () => {
    const tA = await newTicket(ids.cA, { title: 'Asignado tecnico A' });
    const patchA = await ids.cA.patch(`/api/tickets/${tA.id}`, { assigned_to_id: ids.tecA, assigned_team_id: teamA });
    assert.equal(patchA.status, 200, JSON.stringify(patchA.body));

    const tB = await newTicket(ids.cB, { category_id: catB, title: 'Asignado tecnico B' });
    const patchB = await ids.cB.patch(`/api/tickets/${tB.id}`, { assigned_to_id: ids.tecB, assigned_team_id: teamB });
    assert.equal(patchB.status, 200, JSON.stringify(patchB.body));

    const perA = (await ids.cA.get('/api/reports/performance')).body;
    assert.ok(rowById(perA.by_technician, ids.tecA), 'A debe tener la fila de su técnico');
    assert.equal(rowById(perA.by_technician, ids.tecB), undefined, 'A no debe ver al técnico de B');
    assert.ok(rowById(perA.by_team.data, teamA), 'A debe tener la fila de su equipo');
    assert.equal(rowById(perA.by_team.data, teamB), undefined, 'A no debe ver el equipo de B');

    const perB = (await ids.cB.get('/api/reports/performance')).body;
    assert.ok(rowById(perB.by_technician, ids.tecB), 'B debe tener la fila de su técnico');
    assert.equal(rowById(perB.by_technician, ids.tecA), undefined, 'B no debe ver al técnico de A');
    assert.ok(rowById(perB.by_team.data, teamB), 'B debe tener la fila de su equipo');
    assert.equal(rowById(perB.by_team.data, teamA), undefined, 'B no debe ver el equipo de A');

    assert.ok(rowById(perA.by_technician, ids.tecA).assigned >= 1, 'A suma su propia carga');
  });

  it('/csat: las encuestas de A no se mezclan con las de B', async () => {
    const aTicket = await newTicket(ids.cA, { title: 'CSAT de A' });
    registrarResolucion(aTicket.id, { tecnico: ids.tecA, csat: 5 });
    const bTicket = await newTicket(ids.cB, { category_id: catB, title: 'CSAT de B' });
    registrarResolucion(bTicket.id, { tecnico: ids.tecB, csat: 1 });

    const baseA = (await ids.cA.get('/api/reports/csat')).body;
    assert.equal(baseA.responses, 1, 'A ve solo su encuesta');
    assert.equal(baseA.average, 5);
    assert.equal(baseA.has_data, true);
    assert.equal(baseA.distribution.filter((d) => d.n > 0).length, 1, 'la distribución de A suma sus 5 estrellas');
    assert.ok(byLabel(baseA.by_technician)[repName('tec_rep_a')], 'el desglose por técnico de A usa su nombre');
    assert.equal(byLabel(baseA.by_technician)[repName('tec_rep_b')], undefined, 'no cuela el técnico de B');

    const baseB = (await ids.cB.get('/api/reports/csat')).body;
    assert.equal(baseB.responses, 1, 'B ve solo su encuesta');
    assert.equal(baseB.average, 1);

    const sup = (await ids.cS.get('/api/reports/csat')).body;
    assert.equal(sup.responses, 0);
    assert.equal(sup.eligible, 0);
    assert.equal(sup.average, null);
    assert.equal(sup.has_data, false);
    assert.ok(sup.distribution.every((d) => d.n === 0));
    assert.deepEqual(sup.by_technician, []);
    assert.deepEqual(sup.by_department, []);
    assert.deepEqual(sup.by_category, []);
    assert.deepEqual(sup.by_month, []);
  });

  it('/full: agregados y detalle expone solo tickets propios', async () => {
    const t = await newTicket(ids.cA, { title: 'SoloA Full Detalle' });
    await newTicket(ids.cB, { category_id: catB, title: 'SoloB Full Detalle' });

    const fullA = (await ids.cA.get('/api/reports/full')).body;
    const numerosA = fullA.details.map((d) => d.ticket_number);
    assert.ok(numerosA.includes(t.ticket_number), 'A ve su propio ticket en el detalle');
    assert.equal(fullA.details.some((d) => d.title === 'SoloB Full Detalle'), false, 'A no ve el ticket de B');
    assert.equal(
      fullA.byCategory.reduce((a, c) => a + c.n, 0),
      fullA.details.length,
      'la suma de categorías coincide con el detalle (todo de A)'
    );

    const fullB = (await ids.cB.get('/api/reports/full')).body;
    assert.equal(fullB.details.some((d) => d.title === 'SoloA Full Detalle'), false, 'B no ve el ticket de A');

    const sup = (await ids.cS.get('/api/reports/full')).body;
    assert.deepEqual(sup.details, []);
    assert.equal(sup.summary.total, 0);
    assert.equal(sup.summary.open, 0);
    assert.deepEqual(sup.byCategory, []);
    assert.deepEqual(sup.byDepartment, []);
    assert.deepEqual(sup.byTechnician, []);
  });

  it('/export: el CSV de A no filtra títulos, nombres ni ids de B; SUPERADMIN exporta vacío', async () => {
    const tA = await newTicket(ids.cA, { title: 'SoloA Csv Reporte' });

    const resA = await ids.cA.get('/api/reports/export');
    assert.equal(resA.status, 200);
    assert.match(String(resA.headers['content-type']), /text\/csv/);
    assert.match(String(resA.headers['content-disposition']), /reporte-tickets-/);
    const csvA = String(resA.text);
    assert.ok(csvA.includes('REPORTE DE TICKETS'));
    assert.ok(csvA.includes(tA.ticket_number), 'el CSV de A incluye sus propios tickets');
    assert.ok(!csvA.includes('SoloB Csv Reporte'), 'no filtra títulos de B');
    assert.ok(!csvA.includes('SoloB Full Detalle'), 'no filtra otros tickets de B');
    assert.ok(!csvA.includes('Cat Report B'), 'no filtra categorías de B');
    assert.ok(!csvA.includes('Depto Report B'), 'no filtra departamentos de B');
    assert.ok(!csvA.includes('Equipo Report B'), 'no filtra equipos de B');
    assert.ok(!csvA.includes(repName('tec_rep_b')), 'no filtra al técnico de B');
    assert.ok(!csvA.includes(repName('rep_user_b')), 'no filtra al reportero de B');

    const resS = await ids.cS.get('/api/reports/export');
    assert.equal(resS.status, 200);
    const csvS = String(resS.text);
    assert.ok(csvS.includes('REPORTE DE TICKETS'), 'el SUPERADMIN exporta la estructura');
    assert.ok(csvS.includes('RESUMEN'));
    assert.ok(!csvS.includes('SoloA Csv Reporte'), 'el SUPERADMIN no filtra tickets de A');
    assert.ok(!csvS.includes('SoloB Full Detalle'), 'ni los de B');
  });

  it('filtros cross-org (?category / ?department de B) no cambian de contexto ni filtran datos de B', async () => {
    const sBdept = (await ids.cA.get(`/api/reports/summary?department=${deptB}`)).body;
    assert.equal(sBdept.total, 0, 'ningún ticket de A apunta al departamento de B');
    const dByDept = (await ids.cA.get(`/api/reports/by-department?department=${deptB}`)).body.data;
    assert.deepEqual(dByDept, []);

    const sBCat = (await ids.cA.get(`/api/reports/summary?category=${catB}`)).body;
    assert.equal(sBCat.total, 0, 'ningún ticket de A usa la categoría de B');
    const dByCat = (await ids.cA.get(`/api/reports/by-category?category=${catB}`)).body.data;
    assert.ok(dByCat.length > 0, 'A sigue enumerando sus categorías visibles');
    assert.ok(dByCat.every((x) => x.n === 0), 'con la categoría de B como filtro los conteos quedan en cero');
    assert.equal(byName(dByCat)['Cat Report B'], undefined, 'no aparece ninguna categoría de B');

    const full = (await ids.cA.get(`/api/reports/full?department=${deptB}&category=${catB}`)).body;
    assert.deepEqual(full.details, []);
    assert.equal(full.details.some((d) => d.title === 'SoloB Full Detalle'), false, 'el filtro no convierte a A en espectador de B');
  });

  it('la organización nunca se elige desde la query ni la cabecera', async () => {
    const baseA = (await ids.cA.get('/api/reports/summary')).body;

    const spoofQuery = (await ids.cA.get(`/api/reports/summary?organization_id=${ids.orgB}`)).body;
    assert.deepEqual(spoofQuery, baseA, '?organization_id= no cambia el contexto de A');

    const spoofHeader = (await ids.cA.get('/api/reports/summary', {
      headers: { 'x-organization-id': String(ids.orgB) },
    })).body;
    assert.deepEqual(spoofHeader, baseA, 'x-organization-id no cambia el contexto de A');

    const fullB = (await ids.cB.get(`/api/reports/full?organization_id=${ids.orgA}`)).body;
    assert.equal(fullB.details.some((d) => d.title === 'SoloA Full Detalle'), false, 'B no se cuela en datos de A');

    const supSpoof = (await ids.cS.get(`/api/reports/summary?organization_id=${ids.orgA}`)).body;
    assert.equal(supSpoof.total, 0, 'el SUPERADMIN sigue viendo ceros aunque forje una org');
  });

  it('las referencias legacy cross-org no filtran identidad ajena a los reportes', async () => {
    const legacy = db.prepare(
      `INSERT INTO tickets (ticket_number, title, description, reporter_id, category_id, department_id,
         assigned_to_id, assigned_team_id, priority, status, sla_due_at, organization_id, created_at,
         resolved_at, closed_at, resolved_by, closed_by, time_spent_minutes, csat_rating, csat_answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MEDIUM', 'CLOSED', ?, ?, ?, ?, ?, ?, ?, 90, 4, ?)`
    ).run(
      'LEGACY-REPORT-CROSS',
      'Legacy cross-org reportes',
      'Ticket histórico de A con reporter, asignado, departamento, categoría y técnico de B',
      ids.repB,
      catB,
      deptB,
      ids.tecB,
      teamB,
      '2026-03-15T18:00:00.000Z',
      ids.orgA,
      '2026-03-15T09:00:00.000Z',
      '2026-03-15T12:00:00.000Z',
      '2026-03-15T12:00:00.000Z',
      ids.tecB,
      ids.tecB,
      '2026-03-15T12:00:00.000Z'
    );
    const legacyId = legacy.lastInsertRowid;

    // Detalle /full: el ticket se conserva pero con etiquetas seguras.
    const fullA = (await ids.cA.get('/api/reports/full')).body;
    const row = fullA.details.find((d) => Number(d.ticket_number) === legacyId || d.title === 'Legacy cross-org reportes');
    assert.ok(row, 'A debe ver su ticket legacy en el detalle');
    assert.equal(row.reporter, 'Sin reportero', 'no se filtra el reporter de B');
    assert.equal(row.assigned_to, 'Sin asignar', 'no se filtra el asignado de B');
    assert.equal(row.department, 'Sin departamento', 'no se filtra el departamento de B');
    assert.equal(row.category, 'Sin categoría', 'no se filtra la categoría de B');

    // Rendimiento: el técnico y el equipo de B no reciben esta atribución.
    const perA = (await ids.cA.get('/api/reports/performance')).body;
    assert.equal(rowById(perA.by_technician, ids.tecB), undefined, 'la resolución cross-org no se atribuye al técnico de B');
    assert.equal(rowById(perA.by_team.data, teamB), undefined, 'ni al equipo de B');
    const reporterBucket = perA.by_user.find((u) => u.reporter === 'Sin reportero');
    assert.ok(reporterBucket, 'el reporter legacy cae en el bucket "Sin reportero"');
    assert.ok(reporterBucket.total >= 1);

    // CSAT: la encuesta entra en la org A con etiquetas seguras.
    const csatA = (await ids.cA.get('/api/reports/csat')).body;
    assert.ok(byLabel(csatA.by_technician)['Sin técnico'], 'el CSAT legacy se agrupa bajo "Sin técnico"');
    assert.equal(byLabel(csatA.by_technician)[repName('tec_rep_b')], undefined, 'no cuela el nombre del técnico de B');
    assert.ok(byLabel(csatA.by_department)['Sin departamento'], 'CSAT por departamento usa etiqueta segura');
    assert.ok(byLabel(csatA.by_category)['Sin categoría'], 'CSAT por categoría usa etiqueta segura');

    // by-category no muestra la categoría de B.
    const catA_ = (await ids.cA.get('/api/reports/by-category')).body.data;
    assert.equal(byName(catA_)['Cat Report B'], undefined, 'la categoría de B no aparece en los reportes de A');

    // Ninguna respuesta de A debe contener identidad de B.
    for (const [client, url] of [
      [ids.cA, '/api/reports/full'],
      [ids.cA, '/api/reports/csat'],
      [ids.cA, '/api/reports/performance'],
    ]) {
      const body = JSON.stringify((await client.get(url)).body);
      assert.ok(!body.includes('tec_rep_b'), `${url} no debe exponer el username del técnico de B`);
      assert.ok(!body.includes(repName('tec_rep_b')), `${url} no debe exponer el nombre del técnico de B`);
      assert.ok(!body.includes(repName('rep_user_b')), `${url} no debe exponer el reportero de B`);
      assert.ok(!body.includes('Depto Report B'), `${url} no debe exponer el departamento de B`);
      assert.ok(!body.includes('Cat Report B'), `${url} no debe exponer la categoría de B`);
      assert.ok(!body.includes('Equipo Report B'), `${url} no debe exponer el equipo de B`);
    }

    // B y el SUPERADMIN no deben ver el ticket legacy.
    const fullB = (await ids.cB.get('/api/reports/full')).body;
    assert.equal(fullB.details.some((d) => d.title === 'Legacy cross-org reportes'), false, 'B no ve el ticket legacy de A');
    const supFull = (await ids.cS.get('/api/reports/full')).body;
    assert.deepEqual(supFull.details, []);
  });

  it('/api/tickets/export (ETAPA 3) tampoco filtra nada al SUPERADMIN global', async () => {
    const res = await ids.cS.get('/api/tickets/export');
    assert.equal(res.status, 200);
    const csv = String(res.text || '');
    assert.ok(!csv.includes('SoloA Full Detalle'), 'el SUPERADMIN no exporta tickets de A');
    assert.ok(!csv.includes('SoloB Full Detalle'), 'ni de B');
    assert.ok(!csv.includes('Legacy cross-org reportes'), 'ni el legacy');
  });
});