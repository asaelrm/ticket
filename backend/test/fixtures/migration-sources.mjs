import { LEGACY_SEQUENCE_NAME, TABLES } from '../../scripts/migration/sqlite-to-mssql.js';

export const STAMP = '2026-01-05T10:00:00.000Z';
export const emptySource = () => Object.fromEntries(TABLES.map((table) => [table, []]));

// Origen legacy ficticio: sin organization_id en ninguna tabla tenant, con el
// contador global atrasado (5) frente al máximo real de tickets (14).
export function legacySource() {
  const source = emptySource();
  source.roles = [{ id: 1, code: 'ADMIN', name: 'Administrador', active: 1, created_at: STAMP }];
  source.departments = [{ id: 1, name: 'Dirección', active: 1, created_at: STAMP }];
  source.users = [{ id: 1, role_id: 1, department_id: 1, email: 'admin@legacy.test', active: 1, created_at: STAMP }];
  source.tickets = [
    { id: 1, ticket_number: 'TCK-000014', reporter_id: 1, created_at: STAMP },
    { id: 2, ticket_number: 'TCK-000005', reporter_id: 1, created_at: STAMP },
  ];
  source.sequences = [{ name: LEGACY_SEQUENCE_NAME, value: 5 }];
  return source;
}

// Snapshot mixto: organizaciones existentes con IDs que deben conservarse y una
// tabla entera sin etiquetar que exige el tenant legacy.
export function mixedSource() {
  const source = emptySource();
  source.organizations = [
    { id: 1, code: 'ALFA', name: 'Alfa', active: 1, created_at: STAMP },
    { id: 5, code: 'BETA', name: 'Beta', active: 1, created_at: STAMP },
  ];
  source.roles = [{ id: 1, code: 'ADMIN', name: 'Administrador', active: 1, created_at: STAMP }];
  source.departments = [{ id: 1, organization_id: 1, name: 'Operaciones', active: 1, created_at: STAMP }];
  source.users = [{ id: 1, organization_id: 1, department_id: 1, role_id: 1, email: 'alfa@legacy.test', active: 1, created_at: STAMP }];
  source.teams = [{ id: 1, name: 'Mesa de ayuda', active: 1, created_at: STAMP }];
  source.tickets = [{ id: 1, organization_id: 1, ticket_number: 'TCK-000003', reporter_id: 1, created_at: STAMP }];
  return source;
}
