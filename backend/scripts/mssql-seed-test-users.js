// Script de inicialización idempotente de usuarios de prueba para MSSQL
// Ejecuta SOLO contra SIFHA_Tickets_M5_Integration_Test
// NO crea, borra ni altera bases de datos. NO ejecuta migraciones.
// Requiere variables de entorno privadas para contraseñas.

import sql from 'mssql';
import bcrypt from 'bcryptjs';

const AUTHORIZED_DATABASE = 'SIFHA_Tickets_M5_Integration_Test';

const REQUIRED_ENV = [
  'MSSQL_TEST_SERVER',
  'MSSQL_TEST_DATABASE',
  'MSSQL_TEST_USER',
  'MSSQL_TEST_PASSWORD',
  // Contraseñas (obligatorias, sin valores por defecto en código)
  'MSSQL_TEST_ADMIN_PASS',
  'MSSQL_TEST_EMPLEADO_PASS',
  'MSSQL_TEST_TECNICO_PASS',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Variable de entorno requerida no definida: ${key}`);
  }
}

const configuredDb = process.env.MSSQL_TEST_DATABASE;
if (configuredDb !== AUTHORIZED_DATABASE) {
  throw new Error(
    `MSSQL_TEST_DATABASE="${configuredDb}" no es la base autorizada. ` +
    `Debe ser exactamente "${AUTHORIZED_DATABASE}".`
  );
}

const config = {
  server: process.env.MSSQL_TEST_SERVER,
  port: process.env.MSSQL_TEST_PORT ? parseInt(process.env.MSSQL_TEST_PORT, 10) : 1433,
  database: AUTHORIZED_DATABASE,
  user: process.env.MSSQL_TEST_USER,
  password: process.env.MSSQL_TEST_PASSWORD,
  options: {
    encrypt: process.env.MSSQL_TEST_ENCRYPT !== 'false',
    trustServerCertificate: process.env.MSSQL_TEST_TRUST_SERVER_CERTIFICATE === 'true',
    useUTC: true,
    instanceName: process.env.MSSQL_TEST_INSTANCE || undefined,
  },
};

// Permisos definidos en backend/src/seed.js (idénticos)
const PERMISSIONS = [
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

// Roles definidos en backend/src/seed.js (idénticos)
const ROLES = {
  EMPLOYEE: {
    name: 'Empleado',
    description: 'Reporta incidencias y consulta sus propios tickets',
    permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment', 'kb.view'],
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
      'kb.view',
      'kb.create',
      'kb.publish',
    ],
  },
  ADMIN: {
    name: 'Administrador',
    description: 'Control total del sistema',
    permissions: PERMISSIONS.filter(([code]) => code !== 'organization.manage').map(([code]) => code),
  },
  SUPERADMIN: {
    name: 'Superadministrador',
    description: 'Cuenta global sin organización: administra todo el sistema',
    permissions: PERMISSIONS.map(([code]) => code),
  },
};

const USERS_TO_CREATE = [
  {
    username: process.env.MSSQL_TEST_ADMIN_USER || 'admin',
    email: process.env.MSSQL_TEST_ADMIN_EMAIL || 'admin@empresa.com',
    name: process.env.MSSQL_TEST_ADMIN_NAME || 'Administrador',
    lastName: process.env.MSSQL_TEST_ADMIN_LAST_NAME || 'Sistema',
    roleCode: 'ADMIN',
    departmentName: 'Tecnología',
    passwordEnv: 'MSSQL_TEST_ADMIN_PASS',
    position: 'Administrador del sistema',
  },
  {
    username: process.env.MSSQL_TEST_EMPLEADO_USER || 'empleado',
    email: process.env.MSSQL_TEST_EMPLEADO_EMAIL || 'empleado@empresa.com',
    name: 'Empleado',
    lastName: 'Demo',
    roleCode: 'EMPLOYEE',
    departmentName: 'Recursos Humanos',
    passwordEnv: 'MSSQL_TEST_EMPLEADO_PASS',
    position: 'Analista',
  },
  {
    username: process.env.MSSQL_TEST_TECNICO_USER || 'tecnico',
    email: process.env.MSSQL_TEST_TECNICO_EMAIL || 'tecnico@empresa.com',
    name: 'Técnico',
    lastName: 'Soporte',
    roleCode: 'TECHNICIAN',
    departmentName: 'Tecnología',
    passwordEnv: 'MSSQL_TEST_TECNICO_PASS',
    position: 'Soporte Técnico',
  },
];

async function validateTargetDatabase(pool) {
  const result = await pool.request().query('SELECT DB_NAME() AS current_db');
  const currentDb = result.recordset[0]?.current_db;
  if (currentDb !== AUTHORIZED_DATABASE) {
    throw new Error(
      `Conexión a base incorrecta: DB_NAME()="${currentDb}", ` +
      `se esperaba "${AUTHORIZED_DATABASE}". Abortando antes de cualquier escritura.`
    );
  }
  console.log(`[MSSQL Seed] Validado: conectado a "${currentDb}" en ${config.server}`);
}

async function validateSchema(pool) {
  const result = await pool.request().query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'dbo' AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  const tables = result.recordset.map(r => r.TABLE_NAME);
  const expectedTables = [
    'departments', 'categories', 'users', 'teams', 'team_members',
    'tickets', 'canned_responses', 'ticket_comments', 'ticket_attachments',
    'ticket_history', 'sessions', 'sequences', 'settings', 'org_settings',
    'email_logs', 'notifications', 'kb_categories', 'kb_articles',
    'kb_ticket_articles', 'kb_article_history', 'organizations',
    'roles', 'permissions', 'role_permissions'
  ];

  const missing = expectedTables.filter(t => !tables.includes(t));
  if (missing.length > 0) {
    throw new Error(`Faltan tablas en el esquema: ${missing.join(', ')}`);
  }
  console.log(`[MSSQL Seed] Esquema validado: ${tables.length} tablas presentes`);
}

async function getOrCreateOrganization(pool, transaction) {
  // Buscar organización UCE
  let result = await transaction.request()
    .input('code', sql.NVarChar(50), 'UCE')
    .query('SELECT id FROM dbo.organizations WHERE code = @code');

  if (result.recordset.length > 0) {
    const orgId = result.recordset[0].id;
    console.log(`[MSSQL Seed] Organización UCE encontrada (id=${orgId})`);
    return orgId;
  }

  // Crear organización UCE
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
  result = await transaction.request()
    .input('code', sql.NVarChar(50), 'UCE')
    .input('name', sql.NVarChar(200), 'Centro Médico UCE')
    .input('description', sql.NVarChar(sql.MAX), 'Organización inicial del sistema')
    .input('active', sql.Bit, 1)
    .input('created_at', sql.DateTime2(3), now)
    .query(`
      INSERT INTO dbo.organizations (code, name, description, active, created_at)
      OUTPUT INSERTED.id
      VALUES (@code, @name, @description, @active, @created_at)
    `);

  const orgId = result.recordset[0].id;
  console.log(`[MSSQL Seed] Organización UCE creada (id=${orgId})`);
  return orgId;
}

async function getOrCreateDepartments(pool, transaction, organizationId) {
  const departments = ['Tecnología', 'Recursos Humanos'];
  const deptIds = {};
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);

  for (const name of departments) {
    let result = await transaction.request()
      .input('organization_id', sql.Int, organizationId)
      .input('name', sql.NVarChar(150), name)
      .query('SELECT id FROM dbo.departments WHERE organization_id = @organization_id AND name = @name');

    if (result.recordset.length > 0) {
      deptIds[name] = result.recordset[0].id;
      console.log(`[MSSQL Seed] Departamento "${name}" encontrado (id=${deptIds[name]})`);
    } else {
      result = await transaction.request()
        .input('organization_id', sql.Int, organizationId)
        .input('name', sql.NVarChar(150), name)
        .input('description', sql.NVarChar(sql.MAX), null)
        .input('active', sql.Bit, 1)
        .input('created_at', sql.DateTime2(3), now)
        .query(`
          INSERT INTO dbo.departments (organization_id, name, description, active, created_at)
          OUTPUT INSERTED.id
          VALUES (@organization_id, @name, @description, @active, @created_at)
        `);
      deptIds[name] = result.recordset[0].id;
      console.log(`[MSSQL Seed] Departamento "${name}" creado (id=${deptIds[name]})`);
    }
  }
  return deptIds;
}

async function seedPermissionsAndRoles(pool, transaction) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);

  // 1. Insertar permisos (idempotente: solo si no existen)
  console.log('[MSSQL Seed] Insertando permisos...');
  for (const [code, description] of PERMISSIONS) {
    await transaction.request()
      .input('code', sql.NVarChar(100), code)
      .input('description', sql.NVarChar(sql.MAX), description)
      .input('created_at', sql.DateTime2(3), now)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = @code)
        INSERT INTO dbo.permissions (code, description, created_at)
        VALUES (@code, @description, @created_at)
      `);
  }
  console.log(`[MSSQL Seed] ${PERMISSIONS.length} permisos procesados`);

  // 2. Insertar roles (idempotente: upsert por code)
  console.log('[MSSQL Seed] Insertando roles...');
  const roleIds = {};
  for (const [code, role] of Object.entries(ROLES)) {
    // Verificar si el rol ya existe
    const existing = await transaction.request()
      .input('code', sql.NVarChar(100), code)
      .query('SELECT id FROM dbo.roles WHERE code = @code');

    let roleId;
    if (existing.recordset.length > 0) {
      roleId = existing.recordset[0].id;
      // Actualizar name y description si cambió
      await transaction.request()
        .input('code', sql.NVarChar(100), code)
        .input('name', sql.NVarChar(150), role.name)
        .input('description', sql.NVarChar(sql.MAX), role.description)
        .query(`
          UPDATE dbo.roles
          SET name = @name, description = @description
          WHERE code = @code
        `);
      console.log(`[MSSQL Seed] Rol "${code}" ya existe (id=${roleId})`);
    } else {
      const result = await transaction.request()
        .input('code', sql.NVarChar(100), code)
        .input('name', sql.NVarChar(150), role.name)
        .input('description', sql.NVarChar(sql.MAX), role.description)
        .input('active', sql.Bit, 1)
        .input('created_at', sql.DateTime2(3), now)
        .query(`
          INSERT INTO dbo.roles (code, name, description, active, created_at)
          OUTPUT INSERTED.id
          VALUES (@code, @name, @description, @active, @created_at)
        `);
      roleId = result.recordset[0].id;
      console.log(`[MSSQL Seed] Rol "${code}" creado (id=${roleId})`);
    }
    roleIds[code] = roleId;
  }

  // 3. Vincular permisos a roles (solo si el vínculo no existe)
  // Según seed.js: los permisos iniciales solo se asignan al crear el rol;
  // una configuración modificada desde la UI no debe revertirse al reiniciar.
  console.log('[MSSQL Seed] Vinculando permisos a roles...');

  // Obtener todos los permission_ids
  const permResult = await transaction.request()
    .query('SELECT id, code FROM dbo.permissions');
  const permMap = {};
  for (const row of permResult.recordset) {
    permMap[row.code] = row.id;
  }

  for (const [roleCode, role] of Object.entries(ROLES)) {
    const roleId = roleIds[roleCode];
    for (const permCode of role.permissions) {
      const permId = permMap[permCode];
      if (!permId) {
        console.warn(`[MSSQL Seed] ADVERTENCIA: Permiso "${permCode}" no encontrado para rol "${roleCode}"`);
        continue;
      }
      await transaction.request()
        .input('role_id', sql.Int, roleId)
        .input('permission_id', sql.Int, permId)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM dbo.role_permissions WHERE role_id = @role_id AND permission_id = @permission_id)
          INSERT INTO dbo.role_permissions (role_id, permission_id)
          VALUES (@role_id, @permission_id)
        `);
    }
    console.log(`[MSSQL Seed] Rol "${roleCode}" vinculado a ${role.permissions.length} permisos`);
  }

  return roleIds;
}

async function getRoles(pool, transaction) {
  const result = await transaction.request()
    .query('SELECT id, code FROM dbo.roles WHERE code IN (\'ADMIN\', \'EMPLOYEE\', \'TECHNICIAN\', \'SUPERADMIN\')');

  const roles = {};
  for (const row of result.recordset) {
    roles[row.code] = row.id;
  }

  const missing = ['ADMIN', 'EMPLOYEE', 'TECHNICIAN', 'SUPERADMIN'].filter(r => !roles[r]);
  if (missing.length > 0) {
    throw new Error(`Roles faltantes en la base de datos: ${missing.join(', ')}`);
  }

  console.log(`[MSSQL Seed] Roles disponibles: ${Object.keys(roles).join(', ')}`);
  return roles;
}

async function upsertUser(pool, transaction, userData, organizationId, departmentIds, roleIds) {
  const { username, email, name, lastName, roleCode, departmentName, passwordEnv, position } = userData;
  const password = process.env[passwordEnv];

  if (!password) {
    throw new Error(`Contraseña no definida en variable de entorno: ${passwordEnv}`);
  }

  if (password.length < 12) {
    throw new Error(`La contraseña para ${username} debe tener al menos 12 caracteres (política de seguridad)`);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const departmentId = departmentIds[departmentName] ?? null;
  const roleId = roleIds[roleCode];

  // Verificar si el usuario ya existe
  const existing = await transaction.request()
    .input('username', sql.NVarChar(150), username)
    .input('email', sql.NVarChar(320), email)
    .query('SELECT id, password_hash FROM dbo.users WHERE username = @username OR email = @email');

  if (existing.recordset.length > 0) {
    const existingUser = existing.recordset[0];
    console.log(`[MSSQL Seed] Usuario "${username}" ya existe (id=${existingUser.id})`);

    // Verificar si la contraseña coincide (opcional: solo loguear)
    const matches = bcrypt.compareSync(password, existingUser.password_hash);
    if (!matches) {
      console.warn(`[MSSQL Seed] ADVERTENCIA: La contraseña para "${username}" en la BD no coincide con la variable de entorno. No se actualiza automáticamente.`);
    }
    return { created: false, id: existingUser.id };
  }

  // Crear usuario
  const result = await transaction.request()
    .input('organization_id', sql.Int, organizationId)
    .input('department_id', sql.Int, departmentId)
    .input('role_id', sql.Int, roleId)
    .input('name', sql.NVarChar(150), name)
    .input('last_name', sql.NVarChar(150), lastName)
    .input('username', sql.NVarChar(150), username)
    .input('email', sql.NVarChar(320), email)
    .input('password_hash', sql.NVarChar(500), passwordHash)
    .input('position', sql.NVarChar(200), position)
    .input('active', sql.Bit, 1)
    .input('last_password_change_at', sql.DateTime2(3), now)
    .query(`
      INSERT INTO dbo.users (organization_id, department_id, role_id, name, last_name, username, email, password_hash, position, active, last_password_change_at)
      OUTPUT INSERTED.id
      VALUES (@organization_id, @department_id, @role_id, @name, @last_name, @username, @email, @password_hash, @position, @active, @last_password_change_at)
    `);

  const userId = result.recordset[0].id;
  console.log(`[MSSQL Seed] Usuario "${username}" creado (id=${userId}, rol=${roleCode})`);
  return { created: true, id: userId };
}

async function main() {
  console.log('[MSSQL Seed] Iniciando inicialización de usuarios de prueba...');
  console.log(`[MSSQL Seed] Base de datos objetivo: ${AUTHORIZED_DATABASE}`);
  console.log(`[MSSQL Seed] Servidor: ${config.server}`);

  const pool = await sql.connect(config);
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    await validateTargetDatabase(pool);
    await validateSchema(pool);

    const organizationId = await getOrCreateOrganization(pool, transaction);
    const departmentIds = await getOrCreateDepartments(pool, transaction, organizationId);
    const roleIds = await seedPermissionsAndRoles(pool, transaction);
    await getRoles(pool, transaction); // Validar que todos existan

    console.log('[MSSQL Seed] Procesando usuarios...');
    const results = [];
    for (const userData of USERS_TO_CREATE) {
      const result = await upsertUser(pool, transaction, userData, organizationId, departmentIds, roleIds);
      results.push({ username: userData.username, ...result });
    }

    await transaction.commit();

    console.log('\n[MSSQL Seed] Resumen:');
    console.log(`  - Permisos: ${PERMISSIONS.length}`);
    console.log(`  - Roles: ${Object.keys(ROLES).length} (EMPLOYEE, TECHNICIAN, ADMIN, SUPERADMIN)`);
    for (const r of results) {
      console.log(`  - ${r.username}: ${r.created ? 'CREADO' : 'EXISTÍA'} (id=${r.id})`);
    }
    console.log('\n[MSSQL Seed] Inicialización completada exitosamente.');

  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      // Ignorar error de rollback
    }
    throw err;
  } finally {
    await pool.close();
  }
}

main().catch(err => {
  console.error('[MSSQL Seed] ERROR:', err.message);
  process.exit(1);
});