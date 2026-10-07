import db from './db.js';

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

export function roleCodeForUser(userId) {
  const row = db.prepare(`
    SELECT r.code FROM roles r JOIN users u ON u.role_id = r.id WHERE u.id = ?
  `).get(userId);
  return row ? row.code : null;
}

export function getOrg(id) {
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT id, code, name, active FROM organizations WHERE id = ?').get(id) || null;
}

// Comprueba el estado { roleCode, organizationId } contra la regla de
// consistencia. Devuelve un mensaje legible si es inválido, o null si es válido.
export function orgStateError({ roleCode, organizationId }) {
  if (isSuperadminRoleCode(roleCode)) {
    if (organizationId !== null) {
      return `Un SUPERADMIN debe tener organization_id NULL (recibió ${organizationId})`;
    }
    return null;
  }
  if (!Number.isInteger(organizationId)) {
    return 'Un usuario normal debe pertenecer a una organización';
  }
  const org = getOrg(organizationId);
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
export function auditOrganizationConsistency() {
  const issues = [];
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.username, u.organization_id, u.active AS user_active,
           r.code AS role_code, o.code AS org_code, o.active AS org_active
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN organizations o ON o.id = u.organization_id
  `).all();

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
  return issues;
}