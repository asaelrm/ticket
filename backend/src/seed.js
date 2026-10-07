import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { transaction } from './db.js';
import config from './config.js';
import { unusablePassword } from './utils/password.js';

function boolEnv(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const PERMISSIONS = [
  ['ticket.create', 'Crear tickets'],
  ['ticket.view.own', 'Ver sus propios tickets'],
  ['ticket.view.all', 'Ver todos los tickets'],
  ['ticket.comment', 'Comentar en tickets'],
  ['ticket.assign', 'Asignar tickets'],
  ['ticket.update.any', 'Cambiar estado/prioridad/categoría de cualquier ticket'],
  ['ticket.resolve', 'Resolver tickets con solución, causa y tiempo'],
  ['ticket.close', 'Cerrar tickets'],
  ['ticket.note', 'Agregar notas internas y verlas'],
  ['ticket.reopen', 'Reabrir tickets'],
  ['ticket.export', 'Exportar tickets'],
  ['user.view', 'Ver usuarios'],
  ['user.manage', 'Crear/editar/desactivar usuarios y restablecer contraseñas'],
  ['role.manage', 'Administrar roles'],
  ['category.manage', 'Administrar categorías'],
  ['department.manage', 'Administrar departamentos'],
  ['team.manage', 'Administrar equipos de trabajo'],
  ['dashboard.view', 'Ver dashboard y estadísticas'],
  ['report.view', 'Ver reportes'],
  ['settings.manage', 'Cambiar configuración'],
  ['kb.view', 'Consultar artículos publicados de la base de conocimiento'],
  ['kb.create', 'Crear borradores de artículos de conocimiento'],
  ['kb.publish', 'Publicar y archivar artículos propios'],
  ['kb.manage', 'Administrar artículos de conocimiento de cualquier autor'],
  ['organization.manage', 'Gestionar organizaciones'],
];

const ROLES = {
  EMPLOYEE: {
    name: 'Empleado',
    description: 'Reporta incidencias y consulta sus propios tickets',
    // kb.view solo: el empleado puede LEER artículos ya publicados por un
    // técnico, nunca crear borradores ni publicar. Publicar es siempre un acto
    // consciente de alguien con kb.create + kb.publish.
    permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment', 'kb.view'],
  },
  TECHNICIAN: {
    name: 'Técnico / Soporte',
    description: 'Recibe tickets asignados, trabaja sobre ellos y los resuelve',
    // Sin kb.manage: un técnico no edita ni publica artículos de otro autor.
    permissions: [
      'ticket.create',
      'ticket.view.all',
      'ticket.comment',
      'ticket.assign',
      'ticket.update.any',
      'ticket.resolve',
      'ticket.close',
      'ticket.note',
      'ticket.reopen',
      'dashboard.view',
      'kb.view',
      'kb.create',
      'kb.publish',
    ],
  },
  ADMIN: {
    name: 'Administrador',
    description: 'Control total del sistema',
    // El administrador dirige una organización concreta: NO incluye
    // organization.manage, que queda reservado al SUPERADMIN global.
    permissions: PERMISSIONS.filter(([code]) => code !== 'organization.manage').map(([code]) => code),
  },
  SUPERADMIN: {
    name: 'Superadministrador',
    description: 'Cuenta global sin organización: administra todo el sistema',
    permissions: PERMISSIONS.map(([code]) => code),
  },
};

// Organización inicial (ETAPA 1A). Es la organización a la que se asocian los
// datos existentes sin pérdida de información. Las siguientes organizaciones
// llegarán en etapas posteriores, no en esta.
export const INITIAL_ORGANIZATION = {
  code: 'UCE',
  name: 'Centro Médico UCE',
  description: 'Organización inicial del sistema',
};

/**
 * Taxonomía propia de la base de conocimiento. NO se reutiliza `categories`
 * porque esas clasifican incidencias (`tickets.category_id`) y mezclar ambos
 * dominios obligaría a los técnicos a elegir entre "Red" como incidencia y
 * "Red" como tema de documentación.
 */
const INITIAL_KB_CATEGORIES = [
  ['Hardware y equipos', 'Periféricos, equipos de cómputo y reposición', '#2563eb'],
  ['Redes y conectividad', 'Cableado, switch, wifi, VPN y resolución de nombres', '#0891b2'],
  ['Sistemas y software', 'Instalación, configuración y errores de aplicaciones', '#d97706'],
  ['Cuentas y accesos', 'Alta de usuarios, contraseñas, permisos y credenciales', '#ea580c'],
  ['Correo y comunicación', 'Correo electrónico, telefonía y videoconferencia', '#dc2626'],
  ['Procedimientos', 'Guías de trabajo recurrentes y checklists', '#059669'],
  ['General', 'Sin categoría específica', '#64748b'],
];

const INITIAL_CATEGORIES = [
  ['Computadoras', 'Problemas con equipos de cómputo y hardware', '#2563eb'],
  ['Impresoras', 'Impresoras, escáneres y multifuncionales', '#7c3aed'],
  ['Internet', 'Problemas de conectividad a internet', '#0ea5e9'],
  ['Red', 'Infraestructura de red, switches, cableado', '#0891b2'],
  ['Telefonía', 'Teléfonos fijos, móviles y centrales', '#059669'],
  ['Software', 'Aplicaciones y sistemas de la empresa', '#d97706'],
  ['Correo electrónico', 'Cuentas de correo y sus servicios', '#dc2626'],
  ['Accesos', 'Permisos, credenciales y accesos a sistemas', '#ea580c'],
  ['Equipos', 'Equipos especiales y periféricos', '#64748b'],
  ['Mantenimiento', 'Mantenimiento preventivo y correctivo', '#4f46e5'],
  ['Otros', 'Cualquier otra incidencia', '#525252'],
];

const INITIAL_DEPARTMENTS = [
  'Recursos Humanos',
  'Tecnología',
  'Finanzas',
  'Ventas',
  'Operaciones',
  'Marketing',
  'Administración',
];

function seedPermissionsAndRoles() {
  const insertPerm = db.prepare(
    'INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)'
  );
  for (const [code, desc] of PERMISSIONS) insertPerm.run(code, desc);

  const insertRole = db.prepare(
    'INSERT INTO roles (code, name, description) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description'
  );
  const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const getPerm = db.prepare('SELECT id FROM permissions WHERE code = ?');
  const link = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
  );

  for (const [code, role] of Object.entries(ROLES)) {
    const existingRole = getRole.get(code);
    insertRole.run(code, role.name, role.description);
    const roleId = getRole.get(code).id;
    // Los permisos iniciales solo se asignan al crear el rol; una configuración
    // modificada desde la UI no debe revertirse al reiniciar el servidor.
    if (existingRole && code !== 'ADMIN') continue;
    for (const perm of role.permissions) {
      const permRow = getPerm.get(perm);
      if (permRow) link.run(roleId, permRow.id);
    }
  }
}

function seedBaseData() {
  const insertCat = db.prepare(
    'INSERT INTO categories (name, description, color) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color'
  );
  for (const [name, desc, color] of INITIAL_CATEGORIES) insertCat.run(name, desc, color);

  const insertDept = db.prepare(
    'INSERT INTO departments (name) VALUES (?) ON CONFLICT(name) DO NOTHING'
  );
  for (const name of INITIAL_DEPARTMENTS) insertDept.run(name);

  // Mismo criterio que `categories`: el nombre no se sobrescribe al reiniciar
  // para no revertir lo que un administrador haya renombrado desde la UI.
  const insertKbCat = db.prepare(
    'INSERT INTO kb_categories (name, description, color) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color'
  );
  for (const [name, desc, color] of INITIAL_KB_CATEGORIES) insertKbCat.run(name, desc, color);
}

// Organización inicial (ETAPA 1A): crea UCE si no existe y asocia a UCE los
// usuarios existentes que aún no tienen organización, SIN tocar a quienes ya
// tengan una. El UPDATE excluye explícitamente al rol SUPERADMIN: una cuenta
// global (organization_id NULL) nunca debe ser arrastrada a una organización
// por una reejecución del seed.
function ensureOrganizations() {
  db.prepare(
    'INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1) ON CONFLICT(code) DO NOTHING'
  ).run(INITIAL_ORGANIZATION.code, INITIAL_ORGANIZATION.name, INITIAL_ORGANIZATION.description);

  const uce = db.prepare('SELECT id FROM organizations WHERE code = ?').get(INITIAL_ORGANIZATION.code);
  if (!uce) throw new Error('No se pudo resolver la organización inicial');

  db.prepare(`
    UPDATE users SET organization_id = ?
    WHERE organization_id IS NULL
      AND role_id NOT IN (SELECT id FROM roles WHERE code = 'SUPERADMIN')
  `).run(uce.id);

  return uce.id;
}

function ensureUsers(options = {}, organizationId = null) {
  const {
    env = config.env,
    seedAdminPassword = process.env.SEED_ADMIN_PASSWORD || '',
    forceAdminPassword = boolEnv(process.env.SEED_ADMIN_FORCE_PASSWORD),
    seedDemoAccounts = boolEnv(process.env.SEED_DEMO_ACCOUNTS),
    demoPassword = process.env.SEED_DEMO_PASSWORD || '',
    techPassword = process.env.SEED_TECH_PASSWORD || '',
  } = options;

  const getDept = db.prepare('SELECT id FROM departments WHERE name = ?');
  const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const getBy = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)');

  const deptTech = getDept.get('Tecnología');
  const deptRh = getDept.get('Recursos Humanos');
  const roleAdmin = getRole.get('ADMIN').id;
  const roleEmployee = getRole.get('EMPLOYEE').id;
  const roleTechnician = getRole.get('TECHNICIAN').id;

  const isProduction = env === 'production';
  const adminUsername = process.env.SEED_ADMIN_USERNAME || 'admin';
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@empresa.com';

  // El administrador SOLO nace si alguien define su contraseña. Antes se creaba
  // con una contraseña de ejemplo de seis dígitos en cualquier entorno que no
  // fuese exactamente 'production', así que un despliegue con NODE_ENV sin
  // definir o mal escrito salía con una cuenta pública. Aquí no queda ninguna
  // contraseña en el código: o la define quien instala, o el administrador no
  // se crea.
  if (seedAdminPassword) {
    const admin = getBy.get(adminUsername, adminEmail);
    if (!admin) {
      db.prepare(
        `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        process.env.SEED_ADMIN_NAME || 'Administrador',
        process.env.SEED_ADMIN_LAST_NAME || 'Sistema',
        adminUsername,
        adminEmail,
        bcrypt.hashSync(seedAdminPassword, 12),
        deptTech?.id ?? null,
        'Administrador del sistema',
        roleAdmin,
        new Date().toISOString(),
        organizationId
      );
    } else if (forceAdminPassword) {
      // Única vía para recuperar el acceso: hay que pedirla explícitamente con
      // SEED_ADMIN_FORCE_PASSWORD=true. Sin ella, una variable que se quedó en
      // el entorno no vuelve a imponer una contraseña conocida en cada arranque.
      db.prepare('UPDATE users SET password_hash = ?, last_password_change_at = ? WHERE id = ?').run(
        bcrypt.hashSync(seedAdminPassword, 12),
        new Date().toISOString(),
        admin.id
      );
      console.warn(
        '[seed] SEED_ADMIN_FORCE_PASSWORD=true: se ha cambiado la contraseña del administrador ' +
          `("${adminUsername}"). Desactive las dos variables en cuanto pueda.`
      );
    } else if (seedAdminPassword) {
      console.warn(
        `[seed] SEED_ADMIN_PASSWORD está definido y el administrador "${adminUsername}" ya existe: ` +
          'NO se ha aplicado. Para restablecerla de verdad, defina además ' +
          'SEED_ADMIN_FORCE_PASSWORD=true (una sola vez) o use el restablecimiento con token. ' +
          'En cuanto el acceso esté comprobado, quite SEED_ADMIN_PASSWORD del entorno.'
      );
    }
  }

  // Cuentas de demostración: exigen SEED_DEMO_ACCOUNTS=true y nunca en
  // producción. Que NODE_ENV no sea 'production' ya NO basta: un despliegue con
  // NODE_ENV=staging, o sin definir, también es una instalación real y no debe
  // nacer con cuentas de contraseña conocida.
  if (seedDemoAccounts && isProduction) {
    console.error(
      '[seed] SEED_DEMO_ACCOUNTS=true se ha ignorado: las cuentas de demostración no se '
      + 'crean en producción. Si las necesita, levante ese entorno con NODE_ENV=development.'
    );
    return;
  }
  if (!seedDemoAccounts) return;

  // Sin contraseña definida, la cuenta se crea con una aleatoria e
  // inutilizable: es preferible a darle una contraseña que está escrita en el
  // repositorio. Mismo criterio que el directorio de usuarios.
  const sinContrasenaConocida = [];

  const emp = getBy.get('empleado', 'empleado@empresa.com');
  if (!emp) {
    const password = demoPassword || unusablePassword();
    if (!demoPassword) sinContrasenaConocida.push('empleado');
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      'Empleado',
      'Demo',
      'empleado',
      'empleado@empresa.com',
      bcrypt.hashSync(password, 12),
      deptRh?.id ?? null,
      'Analista',
      roleEmployee,
      new Date().toISOString(),
      organizationId
    );
  }

  const tech = getBy.get('tecnico', 'tecnico@empresa.com');
  if (!tech) {
    const password = techPassword || unusablePassword();
    if (!techPassword) sinContrasenaConocida.push('tecnico');
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      'Técnico',
      'Soporte',
      'tecnico',
      'tecnico@empresa.com',
      bcrypt.hashSync(password, 12),
      deptTech?.id ?? null,
      'Soporte Técnico',
      roleTechnician,
      new Date().toISOString(),
      organizationId
    );
  }

  if (sinContrasenaConocida.length) {
    console.warn(
      `[seed] Cuentas demo creadas SIN contraseña conocida: ${sinContrasenaConocida.join(', ')}. `
      + 'Para poder entrar con ellas, defina SEED_DEMO_PASSWORD y SEED_TECH_PASSWORD antes del '
      + 'primer arranque, o haga que un administrador las restablezca.'
    );
  }
}

export function seed(options = {}) {
  return transaction(() => {
    seedPermissionsAndRoles();
    seedBaseData();
    // La organización inicial debe existir ANTES que las cuentas para que las
    // cuentas nuevas nazcan ya asociadas a UCE.
    const organizationId = ensureOrganizations();
    // ensureUsers decide internamente qué cuentas crear según el entorno.
    ensureUsers(options, organizationId);
    return {
      ok: true,
      roles: Object.keys(ROLES).length,
      categories: INITIAL_CATEGORIES.length,
      departments: INITIAL_DEPARTMENTS.length,
      kb_categories: INITIAL_KB_CATEGORIES.length,
      organizations: db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n,
    };
  });
}

// Solo se ejecuta directamente como `node src/seed.js`, no al importarlo desde
// `src/scripts/seed.js`, que primero aplica las migraciones.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed();
  console.log('Seed completado.');
}
