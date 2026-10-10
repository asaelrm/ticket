import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import db, { nowIso } from '../src/db.js';
import { hashPassword } from '../src/utils/password.js';
import { runMaintenance } from '../src/utils/jobs.js';
import { setOrgSetting } from '../src/utils/settingsStore.js';
import { notifyAdmins, notifyStaff } from '../src/utils/notifications.js';
import { notifyCreated, sentEmails } from '../src/utils/mailer.js';

// ETAPA 3 / V3: aislamiento por organización de los trabajos programados
// (SLA vencido, escalación, alertas críticas), de las notificaciones in-app y
// de los correos.
//
// Dos organizaciones ficticias A y B con sus propios usuarios, más un ticket
// "legacy" sin organización. Ningún dato de personas o empresas reales.
//
// Comprobaciones cubiertas:
//   V3.1/V3.3  las reglas de A no escalan tickets de B ni al revés
//   V3.2       la configuración SLA/reglas usada es la de la org del ticket
//   V3.4       la notificación de A no llega a usuarios de B
//   V3.5       los correos no mezclan destinatarios entre organizaciones
//   V3.6/V3.7  un ticket legacy organization_id NULL no dispara broadcast global
//   V3.10      los destinatarios de alertas pertenecen a la org del ticket

const ORG_A = 'JOBSISO_A';
const ORG_B = 'JOBSISO_B';
const pass = (who) => `Jobs${who}Clave123!`;

function insertOrg(code, name) {
  db.prepare('INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1)')
    .run(code, name, 'Organización ficticia de pruebas de jobs');
  return db.prepare('SELECT id FROM organizations WHERE code = ?').get(code).id;
}

function insertUser({ orgId, username, roleCode, email }) {
  const roleId = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode).id;
  db.prepare(
    `INSERT INTO users (name, last_name, username, email, password_hash, position, role_id, active, last_password_change_at, organization_id)
     VALUES (?, ?, ?, ?, ?, 'Puesto de prueba', ?, 1, ?, ?)`
  ).run(
    'Nombre',
    'Apellido',
    username,
    email || `${username}@organizacion.test`,
    hashPassword(pass(username)),
    roleId,
    nowIso(),
    orgId
  );
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

function insertTicket({ number, reporterId, organizationId, priority = 'MEDIUM', status = 'OPEN', createdAt, slaDueAt }) {
  const info = db
    .prepare(
      `INSERT INTO tickets (ticket_number, title, description, reporter_id, organization_id, priority, status, sla_due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      number,
      `Ticket de prueba ${number}`,
      'Descripción sintética de prueba',
      reporterId,
      organizationId,
      priority,
      status,
      slaDueAt,
      createdAt
    );
  return info.lastInsertRowid;
}

function notificationsFor(ticketId) {
  return db.prepare('SELECT * FROM notifications WHERE ticket_id = ?').all(ticketId);
}

function recipientIds(ticketId, type) {
  return notificationsFor(ticketId)
    .filter((n) => n.type === type)
    .map((n) => n.user_id);
}

let orgA;
let orgB;
let adminA;
let adminB;
let empA;
let empB;
let techA;
let legacyUser;

let ticketA;
let ticketB;
let legacyTicket;

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

before(async () => {
  orgA = insertOrg(ORG_A, 'Organización A de jobs');
  orgB = insertOrg(ORG_B, 'Organización B de jobs');

  adminA = insertUser({ orgId: orgA, username: 'admin_jobs_a', roleCode: 'ADMIN', email: 'admin.jobs.a@organizacion.test' });
  adminB = insertUser({ orgId: orgB, username: 'admin_jobs_b', roleCode: 'ADMIN', email: 'admin.jobs.b@organizacion.test' });
  empA = insertUser({ orgId: orgA, username: 'empleado_jobs_a', roleCode: 'EMPLOYEE', email: 'empleado.jobs.a@organizacion.test' });
  empB = insertUser({ orgId: orgB, username: 'empleado_jobs_b', roleCode: 'EMPLOYEE', email: 'empleado.jobs.b@organizacion.test' });
  techA = insertUser({ orgId: orgA, username: 'tecnico_jobs_a', roleCode: 'TECHNICIAN', email: 'tecnico.jobs.a@organizacion.test' });
  // Usuario "legacy" sin organización: simula una cuenta anterior a ETAPA 1A.
  legacyUser = insertUser({ orgId: null, username: 'legacy_jobs_user', roleCode: 'EMPLOYEE', email: 'legacy.jobs@organizacion.test' });

  // Reglas DISTINTAS por organización: A escala a las 1 h, B lo tiene apagado.
  await setOrgSetting(orgA, 'rule_unassigned_hours', '1');
  await setOrgSetting(orgA, 'rule_unassigned_priority', 'HIGH');
  await setOrgSetting(orgB, 'rule_unassigned_hours', '0');

  ticketA = insertTicket({
    number: 'TCK-JOB-0001',
    reporterId: empA,
    organizationId: orgA,
    createdAt: hoursAgo(3),
    slaDueAt: hoursAgo(1),
  });
  ticketB = insertTicket({
    number: 'TCK-JOB-0001',
    reporterId: empB,
    organizationId: orgB,
    createdAt: hoursAgo(3),
    slaDueAt: hoursAgo(1),
  });
  legacyTicket = insertTicket({
    number: 'TCK-JOB-LEGACY',
    reporterId: legacyUser,
    organizationId: null,
    priority: 'LOW',
    createdAt: hoursAgo(48),
    slaDueAt: hoursAgo(24),
  });
});

describe('Aislamiento por organización en los jobs programados (V3)', () => {
  it('el SLA vencido de A sólo notifica a administradores de A', async () => {
    const result = await runMaintenance();
    assert.ok(result.overdue >= 1, 'debe haber notificaciones de SLA vencido');

    const recipients = recipientIds(ticketA, 'SLA_OVERDUE');
    assert.ok(recipients.includes(adminA), 'el administrador de A debe recibir la alerta de SU ticket');
    assert.ok(!recipients.includes(adminB), 'el administrador de B NO recibe alertas de A');
    assert.ok(!recipients.includes(empB), 'ningún usuario de B recibe alertas de A');

    // El empleado de A no tiene `settings.manage`: no es destinatario del
    // fallback de administradores aunque sea el reportante del ticket.
    assert.ok(!recipients.includes(empA), 'los usuarios sin permisos no reciben alertas protegidas');
    assert.ok(!recipients.includes(techA), 'el técnico de A tampoco recibe el aviso de administradores');
  });

  it('el SLA vencido de B notifica sólo a la organización de B', () => {
    const recipients = recipientIds(ticketB, 'SLA_OVERDUE');
    assert.ok(recipients.includes(adminB), 'el administrador de B recibe la alerta de SU ticket');
    assert.ok(!recipients.includes(adminA), 'el administrador de A NO recibe alertas de B');
    assert.ok(!recipients.includes(empA), 'ningún usuario de A recibe alertas de B');
    assert.ok(!recipients.includes(adminA) && !recipients.includes(empA) && !recipients.includes(techA));
  });

  it('las reglas de escalación de una organización no afectan a la otra', () => {
    const a = db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticketA);
    const b = db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticketB);

    // A tiene la regla a 1 h → su ticket (3 h sin asignar) escala.
    assert.equal(a.priority, 'HIGH', 'el ticket de A debe escalar según las reglas de A');
    // B tiene la regla desactivada (0 h): aunque su ticket también lleva 3 h,
    // la regla de A no puede aplicársele.
    assert.equal(b.priority, 'MEDIUM', 'la regla de A no debe escalar tickets de B');

    const histA = db.prepare("SELECT * FROM ticket_history WHERE ticket_id = ? AND action = 'ESCALATED'").get(ticketA);
    const histB = db.prepare("SELECT * FROM ticket_history WHERE ticket_id = ? AND action = 'ESCALATED'").get(ticketB);
    assert.ok(histA, 'la escalación de A queda auditada');
    assert.ok(!histB, 'B no debe tener escalaciones auditadas');
  });

  it('la alerta de escalación sólo llega a administradores de la organización del ticket', () => {
    const recipients = recipientIds(ticketA, 'ESCALATED');
    assert.ok(recipients.includes(adminA), 'los administradores de A reciben la escalación de A');
    assert.ok(!recipients.includes(adminB), 'los administradores de B no reciben la escalación de A');
    assert.ok(!recipients.includes(empA), 'un empleado sin permisos no recibe la alerta');
  });

  it('el ticket legacy sin organización no genera ninguna notificación', () => {
    const rows = notificationsFor(legacyTicket);
    assert.equal(rows.length, 0, 'un ticket sin organización no puede notificar a nadie');
    // Ni a los administradores de A, ni a los de B, ni al usuario legacy.
    for (const user of [adminA, adminB, empA, empB, techA, legacyUser]) {
      assert.ok(
        !rows.some((n) => n.user_id === user),
        'ninguna organización recibe el broadcast de un ticket sin organización'
      );
    }
  });

  it('una asignación corrupta de otra organización usa el fallback seguro de administradores', async () => {
    const corruptAssignee = insertTicket({
      number: 'TCK-JOB-CROSS-USER',
      reporterId: empA,
      organizationId: orgA,
      createdAt: hoursAgo(3),
      slaDueAt: hoursAgo(1),
    });
    db.prepare('UPDATE tickets SET assigned_to_id = ? WHERE id = ?').run(empB, corruptAssignee);

    const teamB = db.prepare(
      'INSERT INTO teams (name, description, active, organization_id) VALUES (?, ?, 1, ?)'
    ).run('Equipo B corrupto para jobs', 'Fixture cross-org', orgB).lastInsertRowid;
    db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(teamB, empB);
    const corruptTeam = insertTicket({
      number: 'TCK-JOB-CROSS-TEAM',
      reporterId: empA,
      organizationId: orgA,
      createdAt: hoursAgo(3),
      slaDueAt: hoursAgo(1),
    });
    db.prepare('UPDATE tickets SET assigned_team_id = ? WHERE id = ?').run(teamB, corruptTeam);

    await runMaintenance();
    for (const ticketId of [corruptAssignee, corruptTeam]) {
      const recipients = recipientIds(ticketId, 'SLA_OVERDUE');
      assert.deepEqual(recipients, [adminA], 'el dato cross-org no silencia el fallback de la organización A');
      assert.ok(!recipients.includes(adminB) && !recipients.includes(empB), 'ningún destinatario de B recibe la alerta');
    }
  });

  it('notifyAdmins con contexto de ticket nunca cruza organizaciones', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;

    const scoped = await notifyAdmins({
      type: 'TEST_ORG_SCOPE',
      title: 'Prueba de alcance',
      body: 'No debe salirse de la organización',
      ticketId: ticketA,
    });
    assert.equal(scoped.length, 1, 'sólo el administrador de A');
    assert.equal(scoped[0] && db.prepare('SELECT user_id FROM notifications WHERE id = ?').get(scoped[0]).user_id, adminA);

    const legacy = await notifyAdmins({
      type: 'TEST_ORG_SCOPE',
      title: 'Prueba legacy',
      ticketId: legacyTicket,
    });
    assert.equal(legacy.length, 0, 'sin organización no hay destinatarios');

    const missing = await notifyAdmins({ type: 'TEST_ORG_SCOPE', title: 'Ticket inexistente', ticketId: 99999999 });
    assert.equal(missing.length, 0, 'un ticket inexistente no notifica');

    // Sin ticket y sin organización sí es un aviso global del sistema (histórico).
    const global = await notifyAdmins({ type: 'TEST_GLOBAL', title: 'Aviso global' });
    assert.ok(global.length >= 1, 'el aviso global sin contexto sigue funcionando');
    for (const id of global) {
      const u = db.prepare('SELECT active FROM users WHERE id = ?').get(id);
      assert.ok(u && u.active === 1, 'sólo usuarios activos');
    }

    const after = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
    assert.ok(after > before, 'deben crearse notificaciones en la prueba');
  });

  it('notifyStaff con contexto de ticket sólo alcanza técnicos de esa organización', async () => {
    const staffA = await notifyStaff({
      type: 'TEST_STAFF',
      title: 'Prueba de técnicos',
      ticketId: ticketA,
      organizationId: orgA,
    });
    assert.ok(staffA.length >= 1, 'debe haber al menos un técnico en A');
    const recipients = staffA.map((nid) => db.prepare('SELECT user_id FROM notifications WHERE id = ?').get(nid).user_id);
    const users = recipients.map((uid) => db.prepare('SELECT id, organization_id FROM users WHERE id = ?').get(uid));
    for (const u of users) {
      assert.equal(Number(u.organization_id), Number(orgA), 'todos los destinatarios son de A');
    }
    assert.ok(recipients.includes(techA), 'el técnico de A sí recibe el aviso de su organización');

    const staffLegacy = await notifyStaff({ type: 'TEST_STAFF', title: 'Legacy', ticketId: legacyTicket });
    assert.equal(staffLegacy.length, 0, 'sin organización no hay técnicos destinatarios');
  });

  it('los correos no mezclan destinatarios entre organizaciones (datos corruptos)', async () => {
    const before = sentEmails.length;

    // Ticket de la organización A cuyo reportante pertenece REALMENTE a B
    // (situación de datos legacy corrupta). El correo no puede salir.
    const corrupt = {
      id: ticketA,
      ticket_number: 'TCK-JOB-0001',
      title: 'Fuga de correo',
      description: 'No debe enviarse',
      status: 'OPEN',
      priority: 'HIGH',
      organization_id: orgA,
      reporter_id: empB,
      reporter_email: 'empleado.jobs.b@organizacion.test',
      reporter_name: 'Empleado B',
    };
    await notifyCreated(corrupt);

    const leaked = sentEmails.slice(before).filter((e) => e.to === 'empleado.jobs.b@organizacion.test');
    assert.equal(leaked.length, 0, 'un reportante de otra organización no recibe el correo');

    // Mismo ticket con un reportante LEGITIMAMENTE de A: sí se envía.
    await notifyCreated({ ...corrupt, reporter_id: empA, reporter_email: 'empleado.jobs.a@organizacion.test' });
    const ok = sentEmails.slice(before).filter((e) => e.to === 'empleado.jobs.a@organizacion.test');
    assert.equal(ok.length, 1, 'el reportante legítimo de A sí recibe su correo');
  });

  it('la segunda pasada no duplica notificaciones ni reutiliza caché obsoleta', async () => {
    const beforeA = recipientIds(ticketA, 'SLA_OVERDUE').length;
    const beforeB = recipientIds(ticketB, 'SLA_OVERDUE').length;
    await runMaintenance();
    assert.equal(recipientIds(ticketA, 'SLA_OVERDUE').length, beforeA, 'sin duplicados en A');
    assert.equal(recipientIds(ticketB, 'SLA_OVERDUE').length, beforeB, 'sin duplicados en B');
    assert.equal(notificationsFor(legacyTicket).length, 0, 'el ticket legacy sigue sin notificar');

    // La configuración por organización se sigue leyendo tras la caché de la
    // primera pasada: cambiamos la regla de B y debe verse en la siguiente.
    await setOrgSetting(orgB, 'rule_unassigned_hours', '1');
    await setOrgSetting(orgB, 'rule_unassigned_priority', 'CRITICAL');
    const ticketB2 = insertTicket({
      number: 'TCK-JOB-0002',
      reporterId: empB,
      organizationId: orgB,
      createdAt: hoursAgo(3),
      slaDueAt: hoursAgo(1),
    });
    await runMaintenance();
    const b2 = db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticketB2);
    assert.equal(b2.priority, 'CRITICAL', 'la nueva regla de B se aplica a B (sin efecto de la caché)');
    assert.equal(
      db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticketA).priority,
      'HIGH',
      'la regla de B no reescribe el ticket ya escalado de A'
    );

    // Dejamos la regla de B apagada para no condicionar otros casos.
    await setOrgSetting(orgB, 'rule_unassigned_hours', '0');
  });
});
