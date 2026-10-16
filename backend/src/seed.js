import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from './db/runtime.js';
import config from './config.js';
import { unusablePassword } from './utils/password.js';
import { INITIAL_ORGANIZATION } from './orgConstants.js';

// El seed se ejecuta sobre SQL Server a través de la fachada de runtime (async).
// Las sentencias se escriben en dialecto SQLite y src/db/dialect.js las traduce
// a T-SQL. En MSSQL el arranque NO ejecuta el seed automáticamente: el esquema y
// los datos base ya existen (migrados o aprovisionados). Este script queda
// disponible para el aprovisionamiento explícito (`npm run db:seed`).

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
  ['ticket.sifha.view', 'Atender tickets de soporte central SIFHA'],
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

// Organización inicial (ETAPA 1A). Se conserva como reexport por compatibilidad;
// su definición vive en orgConstants.js, que no depende de ningún motor.
export { INITIAL_ORGANIZATION };

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

async function seedPermissionsAndRoles(db) {
  for (const [code, desc] of PERMISSIONS) {
    await db.execute('INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)', code, desc);
  }

  for (const [code, role] of Object.entries(ROLES)) {
    const existingRole = await db.queryOne('SELECT id FROM roles WHERE code = ?', code);
    await db.execute(
      'INSERT INTO roles (code, name, description) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description',
      code,
      role.name,
      role.description,
    );
    const roleRow = await db.queryOne('SELECT id FROM roles WHERE code = ?', code);
    // Los permisos iniciales solo se asignan al crear el rol; una configuración
    // modificada desde la UI no debe revertirse al reiniciar el servidor.
    if (existingRole) continue;
    for (const perm of role.permissions) {
      const permRow = await db.queryOne('SELECT id FROM permissions WHERE code = ?', perm);
      if (permRow) {
        await db.execute(
          'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          roleRow.id,
          permRow.id,
        );
      }
    }
  }
}

async function seedBaseData(db, organizationId) {
  for (const [name, desc, color] of INITIAL_CATEGORIES) {
    await db.execute(
      'INSERT INTO categories (name, description, color, organization_id) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color',
      name,
      desc,
      color,
      organizationId,
    );
  }

  // ETAPA 2: los departamentos iniciales nacen ya asociados a la organización
  // inicial (UCE). Mismo criterio que las cuentas demo.
  for (const name of INITIAL_DEPARTMENTS) {
    await db.execute(
      'INSERT INTO departments (name, organization_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
      name,
      organizationId,
    );
  }

  // ETAPA 3: la taxonomía de la base de conocimiento también nace asociada a la
  // organización inicial (mismo criterio que categories).
  for (const [name, desc, color] of INITIAL_KB_CATEGORIES) {
    await db.execute(
      'INSERT INTO kb_categories (name, description, color, organization_id) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color',
      name,
      desc,
      color,
      organizationId,
    );
  }
}

// Organización inicial (ETAPA 1A): crea UCE si no existe y asocia a UCE los
// usuarios existentes que aún no tienen organización, SIN tocar a quienes ya
// tengan una. El UPDATE excluye explícitamente al rol SUPERADMIN: una cuenta
// global (organization_id NULL) nunca debe ser arrastrada a una organización
// por una reejecución del seed.
// ETAPA 2: el mismo backfill alcanza a los departamentos huérfanos: los
// registros pre-multiempresa pertenecen a la organización inicial.
async function ensureOrganizations(db) {
  await db.execute(
    'INSERT INTO organizations (code, name, description, active) VALUES (?, ?, ?, 1) ON CONFLICT(code) DO NOTHING',
    INITIAL_ORGANIZATION.code,
    INITIAL_ORGANIZATION.name,
    INITIAL_ORGANIZATION.description,
  );

  const uce = await db.queryOne('SELECT id FROM organizations WHERE code = ?', INITIAL_ORGANIZATION.code);
  if (!uce) throw new Error('No se pudo resolver la organización inicial');

  await db.execute(`
    UPDATE users SET organization_id = ?
    WHERE organization_id IS NULL
      AND role_id NOT IN (SELECT id FROM roles WHERE code = 'SUPERADMIN')
  `, uce.id);

  await db.execute('UPDATE departments SET organization_id = ? WHERE organization_id IS NULL', uce.id);

  // ETAPA 3: mismo criterio que departments/users.
  await db.execute('UPDATE tickets SET organization_id = ? WHERE organization_id IS NULL', uce.id);
  await db.execute('UPDATE categories SET organization_id = ? WHERE organization_id IS NULL', uce.id);
  await db.execute('UPDATE teams SET organization_id = ? WHERE organization_id IS NULL', uce.id);
  await db.execute('UPDATE canned_responses SET organization_id = ? WHERE organization_id IS NULL', uce.id);
  await db.execute('UPDATE kb_categories SET organization_id = ? WHERE organization_id IS NULL', uce.id);
  await db.execute('UPDATE kb_articles SET organization_id = ? WHERE organization_id IS NULL', uce.id);

  // Continuidad de numeración tras la migración: si existía la secuencia global
  // legacy `ticket_number` y la clave por organización de UCE aún no, la clave
  // por organización "hereda" el valor convergente a lo alto de ambos.
  await db.execute(`
    INSERT INTO sequences (name, value)
    SELECT ?, value FROM sequences WHERE name = 'ticket_number'
    ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)
  `, `ticket_number:${uce.id}`);

  return uce.id;
}

async function ensureUsers(db, options = {}, organizationId = null) {
  const {
    env = config.env,
    seedAdminPassword = process.env.SEED_ADMIN_PASSWORD || '',
    forceAdminPassword = boolEnv(process.env.SEED_ADMIN_FORCE_PASSWORD),
    seedDemoAccounts = boolEnv(process.env.SEED_DEMO_ACCOUNTS),
    demoPassword = process.env.SEED_DEMO_PASSWORD || '',
    techPassword = process.env.SEED_TECH_PASSWORD || '',
  } = options;

  const deptTech = await db.queryOne('SELECT id FROM departments WHERE name = ?', 'Tecnología');
  const deptRh = await db.queryOne('SELECT id FROM departments WHERE name = ?', 'Recursos Humanos');
  const roleAdmin = (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'ADMIN')).id;
  const roleEmployee = (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'EMPLOYEE')).id;
  const roleTechnician = (await db.queryOne('SELECT id FROM roles WHERE code = ?', 'TECHNICIAN')).id;

  const getBy = (username, email) =>
    db.queryOne('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)', username, email);

  const isProduction = env === 'production';
  const adminUsername = process.env.SEED_ADMIN_USERNAME || 'admin';
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@empresa.com';

  // El administrador SOLO nace si alguien define su contraseña.
  if (seedAdminPassword) {
    const admin = await getBy(adminUsername, adminEmail);
    if (!admin) {
      await db.execute(
        `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        process.env.SEED_ADMIN_NAME || 'Administrador',
        process.env.SEED_ADMIN_LAST_NAME || 'Sistema',
        adminUsername,
        adminEmail,
        bcrypt.hashSync(seedAdminPassword, 12),
        deptTech?.id ?? null,
        'Administrador del sistema',
        roleAdmin,
        new Date().toISOString(),
        organizationId,
      );
    } else if (forceAdminPassword) {
      // Única vía para recuperar el acceso: hay que pedirla explícitamente.
      await db.execute('UPDATE users SET password_hash = ?, last_password_change_at = ? WHERE id = ?',
        bcrypt.hashSync(seedAdminPassword, 12),
        new Date().toISOString(),
        admin.id,
      );
      console.warn(
        '[seed] SEED_ADMIN_FORCE_PASSWORD=true: se ha cambiado la contraseña del administrador ' +
          `("${adminUsername}"). Desactive las dos variables en cuanto pueda.`,
      );
    } else {
      console.warn(
        `[seed] SEED_ADMIN_PASSWORD está definido y el administrador "${adminUsername}" ya existe: ` +
          'NO se ha aplicado. Para restablecerla de verdad, defina además ' +
          'SEED_ADMIN_FORCE_PASSWORD=true (una sola vez) o use el restablecimiento con token. ' +
          'En cuanto el acceso esté comprobado, quite SEED_ADMIN_PASSWORD del entorno.',
      );
    }
  }

  // Cuentas de demostración: exigen SEED_DEMO_ACCOUNTS=true y nunca en
  // producción.
  if (seedDemoAccounts && isProduction) {
    console.error(
      '[seed] SEED_DEMO_ACCOUNTS=true se ha ignorado: las cuentas de demostración no se '
      + 'crean en producción. Si las necesita, levante ese entorno con NODE_ENV=development.',
    );
    return;
  }
  if (!seedDemoAccounts) return;

  const sinContrasenaConocida = [];

  const emp = await getBy('empleado', 'empleado@empresa.com');
  if (!emp) {
    const password = demoPassword || unusablePassword();
    if (!demoPassword) sinContrasenaConocida.push('empleado');
    await db.execute(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      'Empleado',
      'Demo',
      'empleado',
      'empleado@empresa.com',
      bcrypt.hashSync(password, 12),
      deptRh?.id ?? null,
      'Analista',
      roleEmployee,
      new Date().toISOString(),
      organizationId,
    );
  }

  const tech = await getBy('tecnico', 'tecnico@empresa.com');
  if (!tech) {
    const password = techPassword || unusablePassword();
    if (!techPassword) sinContrasenaConocida.push('tecnico');
    await db.execute(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      'Técnico',
      'Soporte',
      'tecnico',
      'tecnico@empresa.com',
      bcrypt.hashSync(password, 12),
      deptTech?.id ?? null,
      'Soporte Técnico',
      roleTechnician,
      new Date().toISOString(),
      organizationId,
    );
  }

  if (sinContrasenaConocida.length) {
    console.warn(
      `[seed] Cuentas demo creadas SIN contraseña conocida: ${sinContrasenaConocida.join(', ')}. `
      + 'Para poder entrar con ellas, defina SEED_DEMO_PASSWORD y SEED_TECH_PASSWORD antes del '
      + 'primer arranque, o haga que un administrador las restablezca.',
    );
  }
}

export async function seed(options = {}) {
  return runtime.transaction(async (tx) => {
    await seedPermissionsAndRoles(tx);
    // La organización inicial debe existir ANTES que categorías, departamentos
    // y cuentas para que los registros nuevos nazcan ya asociados a UCE.
    const organizationId = await ensureOrganizations(tx);
    await seedBaseData(tx, organizationId);
    // ensureUsers decide internamente qué cuentas crear según el entorno.
    await ensureUsers(tx, options, organizationId);
    const orgs = await tx.queryOne('SELECT COUNT(*) AS n FROM organizations');
    return {
      ok: true,
      roles: Object.keys(ROLES).length,
      categories: INITIAL_CATEGORIES.length,
      departments: INITIAL_DEPARTMENTS.length,
      kb_categories: INITIAL_KB_CATEGORIES.length,
      organizations: orgs.n,
    };
  });
}

// Solo se ejecuta directamente como `node src/seed.js`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then(() => console.log('Seed completado.'))
    .catch((error) => {
      console.error(`[seed] ${error.message}`);
      process.exitCode = 1;
    });
}
