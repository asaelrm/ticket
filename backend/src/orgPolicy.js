import db from './db/runtime.js';

// Política de organización (ETAPA 1B).
//
// Regla de consistencia:
//   - Un usuario normal SIEMPRE pertenece a una organización (organization_id
//     obligatorio).
//   - Un SUPERADMIN es global: organization_id DEBE ser NULL.
//
// La restricción fuerte se diseñará en la base definitiva (MSSQL). Mientras
// tanto, SQLite no puede imponer NOT NULL condicional: la regla se aplica aquí
// (entrada de datos) y la auditoría detecta cualquier estado residual.

export const SUPERADMIN_ROLE_CODE = 'SUPERADMIN';

export function isSuperadminRoleCode(code) {
  return code === SUPERADMIN_ROLE_CODE;
}

export async function roleCodeForUser(userId) {
  const row = await db.queryOne(`
    SELECT r.code FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?
  `, userId);
  return row ? row.code : null;
}

export async function getOrg(id) {
  if (!Number.isInteger(id)) return null;
  return await db.queryOne('SELECT id, code, name, active FROM organizations WHERE id = ?', id) || null;
}

// Comprueba el estado { roleCode, organizationId } contra la regla de
// consistencia. Devuelve un mensaje legible si es inválido, o null si es válido.
export async function orgStateError({ roleCode, organizationId }) {
  if (isSuperadminRoleCode(roleCode)) {
    if (organizationId !== null) {
      return `Un SUPERADMIN debe tener organization_id NULL (recibió ${organizationId})`;
    }
    return null;
  }
  if (!Number.isInteger(organizationId)) {
    return 'Un usuario normal debe pertenecer a una organización';
  }
  const org = await getOrg(organizationId);
  if (!org) {
    return `La organización ${organizationId} no existe`;
  }
  if (!org.active) {
    return `La organización "${org.code}" no está activa`;
  }
  return null;
}

// Auditoría de solo lectura: detecta estados inconsistentes sin modificar nada.
// Reporta (nunca corrige): los datos ambiguos deben revisarse manualmente.
export async function auditOrganizationConsistency() {
  const issues = [];
  const rows = await db.queryMany(`
    SELECT u.id AS user_id, u.username, u.organization_id, u.active AS user_active,
           r.code AS role_code, o.code AS org_code, o.active AS org_active
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN organizations o ON o.id = u.organization_id
  `);

  for (const row of rows) {
    if (isSuperadminRoleCode(row.role_code)) {
      if (row.organization_id !== null) {
        issues.push({
          type: 'SUPERADMIN_CON_ORGANIZACION',
          user_id: row.user_id,
          username: row.username,
          detail: `El SUPERADMIN "${row.username}" tiene organization_id=${row.organization_id} (debe ser NULL).`,
        });
      }
    } else if (row.organization_id === null) {
      issues.push({
        type: 'USUARIO_SIN_ORGANIZACION',
        user_id: row.user_id,
        username: row.username,
        detail: `El usuario normal "${row.username}" no tiene organización (organization_id NULL).`,
      });
    } else if (row.org_code === null) {
      issues.push({
        type: 'ORGANIZACION_INEXISTENTE',
        user_id: row.user_id,
        username: row.username,
        detail: `El usuario "${row.username}" referencia una organización inexistente (id ${row.organization_id}).`,
      });
    } else if (!row.org_active) {
      issues.push({
        type: 'ORGANIZACION_INACTIVA',
        user_id: row.user_id,
        username: row.username,
        detail: `El usuario "${row.username}" referencia una organización inactiva ("${row.org_code}").`,
      });
    }
  }

  // ETAPA 3: auditoría de TICKETS con los mismos criterios. Un ticket debe
  // compartir organización con su reportante y, cuando los tenga, con su
  // asignado, departamento, categoría y equipo. Un ticket sin organización es
  // un huérfano (el backfill no corrió o llegó corrupto); una referencia con
  // organization_id NULL es un campo sin backfillear.
  const ticketRows = await db.queryMany(
    `SELECT t.id AS ticket_id, t.ticket_number, t.organization_id AS ticket_org,
            t.reporter_id, t.assigned_to_id, t.department_id, t.category_id, t.assigned_team_id,
            r.organization_id AS reporter_org,
            a.organization_id AS assignee_org,
            d.organization_id AS dept_org,
            c.organization_id AS cat_org,
            te.organization_id AS team_org
     FROM tickets t
     JOIN users r ON r.id = t.reporter_id
     LEFT JOIN users a ON a.id = t.assigned_to_id
     LEFT JOIN departments d ON d.id = t.department_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN teams te ON te.id = t.assigned_team_id`,
  );

  for (const t of ticketRows) {
    if (t.ticket_org == null) {
      issues.push({
        type: 'TICKET_SIN_ORGANIZACION',
        ticket_id: t.ticket_id,
        detail: `El ticket "${t.ticket_number}" no tiene organización (organization_id NULL).`,
      });
      continue;
    }
    const ticketOrg = Number(t.ticket_org);
    const relationship = (type, label, refOrg, refId) => {
      if (refId == null) return;
      if (refOrg == null) {
        issues.push({
          type: 'TICKET_CAMPO_SIN_ORGANIZACION',
          ticket_id: t.ticket_id,
          detail: `El ${label} (id ${refId}) del ticket "${t.ticket_number}" no tiene organización (organization_id NULL).`,
        });
      } else if (Number(refOrg) !== ticketOrg) {
        issues.push({
          type,
          ticket_id: t.ticket_id,
          detail: `El ${label} (id ${refId}) del ticket "${t.ticket_number}" pertenece a la organización ${refOrg}, no a ${ticketOrg}.`,
        });
      }
    };
    relationship('TICKET_REPORTANTE_OTRA_ORG', 'reportante', t.reporter_org, t.reporter_id);
    relationship('TICKET_ASIGNADO_OTRA_ORG', 'asignado', t.assignee_org, t.assigned_to_id);
    relationship('TICKET_DEPARTAMENTO_OTRA_ORG', 'departamento', t.dept_org, t.department_id);
    relationship('TICKET_CATEGORIA_OTRA_ORG', 'categoría', t.cat_org, t.category_id);
    relationship('TICKET_EQUIPO_OTRA_ORG', 'equipo', t.team_org, t.assigned_team_id);
  }

  return issues;
}
