import bcrypt from 'bcryptjs';
import db, { transaction } from './db.js';
import config from './config.js';

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
];

const ROLES = {
  EMPLOYEE: {
    name: 'Empleado',
    description: 'Reporta incidencias y consulta sus propios tickets',
    permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment'],
  },
  TECHNICIAN: {
    name: 'Técnico / Soporte',
    description: 'Recibe tickets asignados, trabaja sobre ellos y los resuelve',
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
    ],
  },
  ADMIN: {
    name: 'Administrador',
    description: 'Control total del sistema',
    permissions: PERMISSIONS.map(([code]) => code),
  },
};

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
  const clear = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');

  for (const [code, role] of Object.entries(ROLES)) {
    insertRole.run(code, role.name, role.description);
    const roleId = getRole.get(code).id;
    clear.run(roleId);
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
}

function ensureUsers() {
  const getDept = db.prepare('SELECT id FROM departments WHERE name = ?');
  const getRole = db.prepare('SELECT id FROM roles WHERE code = ?');
  const getBy = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)');

  const deptTech = getDept.get('Tecnología');
  const deptRh = getDept.get('Recursos Humanos');
  const roleAdmin = getRole.get('ADMIN').id;
  const roleEmployee = getRole.get('EMPLOYEE').id;
  const roleTechnician = getRole.get('TECHNICIAN').id;

  const isProduction = config.env === 'production';
  const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD || '';
  const adminUsername = process.env.SEED_ADMIN_USERNAME || 'admin';
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@empresa.com';

  // En producción el administrador solo se crea si se define SEED_ADMIN_PASSWORD.
  // En desarrollo se crea con la contraseña demo '123456'.
  const shouldCreateAdmin = !isProduction || Boolean(seedAdminPassword);
  const adminPassword = seedAdminPassword || '123456';
  if (shouldCreateAdmin) {
    const admin = getBy.get(adminUsername, adminEmail);
    if (!admin) {
      db.prepare(
        `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        process.env.SEED_ADMIN_NAME || 'Administrador',
        process.env.SEED_ADMIN_LAST_NAME || 'Sistema',
        adminUsername,
        adminEmail,
        bcrypt.hashSync(adminPassword, 12),
        deptTech?.id ?? null,
        'Administrador del sistema',
        roleAdmin,
        new Date().toISOString()
      );
    } else if (seedAdminPassword) {
      // Si SEED_ADMIN_PASSWORD está definido, se fuerza esa contraseña en el
      // arranque (permite recuperar el acceso). Ver .env.example.
      db.prepare('UPDATE users SET password_hash = ?, last_password_change_at = ? WHERE id = ?').run(
        bcrypt.hashSync(adminPassword, 12),
        new Date().toISOString(),
        admin.id
      );
    }
  }

  // Cuentas demo: nunca en producción.
  if (isProduction) return;

  const emp = getBy.get('empleado', 'empleado@empresa.com');
  if (!emp) {
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      'Empleado',
      'Demo',
      'empleado',
      'empleado@empresa.com',
      bcrypt.hashSync('Empleado1234!', 12),
      deptRh?.id ?? null,
      'Analista',
      roleEmployee,
      new Date().toISOString()
    );
  }

  const tech = getBy.get('tecnico', 'tecnico@empresa.com');
  if (!tech) {
    db.prepare(
      `INSERT INTO users (name, last_name, username, email, password_hash, department_id, position, role_id, active, last_password_change_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      'Técnico',
      'Soporte',
      'tecnico',
      'tecnico@empresa.com',
      bcrypt.hashSync('Tecnico1234!', 12),
      deptTech?.id ?? null,
      'Soporte Técnico',
      roleTechnician,
      new Date().toISOString()
    );
  }
}

export function seed() {
  return transaction(() => {
    seedPermissionsAndRoles();
    seedBaseData();
    // ensureUsers decide internamente qué cuentas crear según el entorno.
    ensureUsers();
    return { ok: true, roles: Object.keys(ROLES).length, categories: INITIAL_CATEGORIES.length, departments: INITIAL_DEPARTMENTS.length };
  });
}

// Ejecución directa (npm run db:seed)
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed();
  console.log('Seed completado.');
}