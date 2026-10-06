// B13-C · Plan de seed para SQL Server, como DATOS PUROS.
//
// Este módulo no abre conexiones ni ejecuta una sola sentencia. Contiene lo que
// hay que sembrar y las invariantes que tienen que cumplirse ANTES de tocar la
// base. Separarlo del ejecutor permite dos cosas que importan:
//
//   1. Comprobar el plan entero con `npm test`, sin DEV y sin riesgo.
//   2. Que las invariantes ("todo rol apunta a un permiso que existe") se
//      validen antes de abrir una transacción, no a mitad de un INSERT.
//
// LA REGLA DE ORO DE ESTA ESTRATEGIA
// ----------------------------------
// Aquí no hay ni un solo identificador de SQLite. Cada entidad se busca y se
// crea por su CLAVE LÓGICA estable, que es la que tiene UNIQUE en SQL Server:
//
//      departments        -> name
//      permissions        -> code
//      roles              -> code
//      role_permissions   -> (role_code, permission_code)  [FK por id, resuelta aquí]
//      users              -> username
//      categories         -> name            [C2, si existe la tabla]
//      sequences          -> name            [C2, si existe la tabla]
//      settings           -> key             [C2, si existe la tabla]
//
// Los ids los pone SQL Server con su IDENTITY. `role_permissions` es la única
// tabla sin IDENTITY, y sus dos columnas son FK, así que se insertan con los ids
// que el propio seed acaba de leer: los de ESTA base, no los de SQLite.
//
// categories/sequences/settings son C2: se siembran SOLO cuando su tabla ya
// existe (tras el DDL de C1). Si no existe, el ejecutor las reporta como
// pendientes de DDL y sigue, igual que con las demás catálogos.

/**
 * Permisos. Se copian de `src/seed.js` sin cambios: la equivalencia funcional
 * con SQLite se consigue con los mismos `code`, que es la clave lógica, no con
 * los mismos `id`.
 */
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
].map(([code, description]) => ({ code, description }));

/**
 * Roles y sus permisos, por `code`. `ADMIN` se define como "todos los
 * permisos del plan" para que añadir un permiso no obligue a tocar tres sitios
 * ni a acordarse de incluirlo en la lista del administrador.
 */
export const ROLES = [
  {
    code: 'EMPLOYEE',
    name: 'Empleado',
    description: 'Reporta incidencias y consulta sus propios tickets',
    permissionCodes: ['ticket.create', 'ticket.view.own', 'ticket.comment', 'kb.view'],
  },
  {
    code: 'TECHNICIAN',
    name: 'Técnico / Soporte',
    description: 'Recibe tickets asignados, trabaja sobre ellos y los resuelve',
    permissionCodes: [
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
  {
    code: 'ADMIN',
    name: 'Administrador',
    description: 'Control total del sistema',
    // Se resuelve abajo contra PERMISSIONS, no se escribe la lista a mano.
    permissionCodes: null,
  },
].map((role) => (role.permissionCodes === null
  ? { ...role, permissionCodes: PERMISSIONS.map((p) => p.code) }
  : role));

/**
 * Los 25 departamentos de SQLite, por NOMBRE. Sus ids (1..30, con huecos) y su
 * `description` no se copian: en SQLite los 25 tienen `description` NULL, así que
 * perderla no pierde nada, y dejar que SQL Server asigne el id es justamente lo
 * que cambia de estrategia.
 */
export const DEPARTMENTS = [
  'Administración',
  'Admision Y Facturacion',
  'Almacen',
  'Auditoria Administrativa',
  'Auditoria Medica',
  'Cardiologia',
  'Compras',
  'Direccion Medica',
  'Emergencias',
  'Finanzas',
  'Hemodinamia',
  'Imagenes Medicas',
  'Laboratorio',
  'Mantenimiento',
  'Marketing',
  'Negocios Y Contrataciones',
  'Operaciones',
  'Patologia',
  'Recepcion',
  'Recursos Humanos',
  'Sombrilla',
  'Suministro',
  'Suministro cirugia',
  'Tecnología',
  'Ventas',
].map((name) => ({ name }));

/**
 * Catálogos que hoy NO tienen tabla en SIFHA_Tickets_DEV. Los datos se declaran
 * igual, listos para cuando haya DDL, pero el ejecutor los marca `pending-ddl` y
 * NO intenta crearlos: el seed no hace DDL.
 */
export const CATEGORIES = [
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
].map(([name, description, color]) => ({ name, description, color }));

export const KB_CATEGORIES = [
  ['Hardware y equipos', 'Periféricos, equipos de cómputo y reposición', '#2563eb'],
  ['Redes y conectividad', 'Cableado, switch, wifi, VPN y resolución de nombres', '#0891b2'],
  ['Sistemas y software', 'Instalación, configuración y errores de aplicaciones', '#d97706'],
  ['Cuentas y accesos', 'Alta de usuarios, contraseñas, permisos y credenciales', '#ea580c'],
  ['Correo y comunicación', 'Correo electrónico, telefonía y videoconferencia', '#dc2626'],
  ['Procedimientos', 'Guías de trabajo recurrentes y checklists', '#059669'],
  ['General', 'Sin categoría específica', '#64748b'],
].map(([name, description, color]) => ({ name, description, color }));

/**
 * Secuencias funcionales. La única requerida por el código es `ticket_number`,
 * que C3 consume de forma atómica: `UPDATE ... WITH (UPDLOCK, HOLDLOCK)
 * SET value = value + 1 OUTPUT INSERTED.value`. Empezar en 0 hace que el primer
 * ticket sea TCK-000001, igual que SQLite. Si una secuencia YA existe, el seed
 * nunca la reinicia: la numeración en curso no debe retroceder.
 */
export const SEQUENCES = [
  { name: 'ticket_number', value: 0 },
];

/**
 * Configuración mínima. Se copian los valores por defecto que `src/routes/settings.js`
 * y `src/utils/sla.js` ya asumen en código: sin estas filas el sistema funciona
 * (hay fallbacks), pero la pantalla de Configuración mostraría vacíos los campos
 * de SLA y numeración. Nada se sobrescribe: si una clave ya existe, se deja como
 * la haya dejado un administrador.
 */
export const SETTINGS = [
  { key: 'ticket_prefix', value: 'TCK' },
];

/**
 * Orden de resolución por FK. Cada paso solo depende de los anteriores, y el
 * ejecutor los recorre en este orden exacto.
 *
 * `permissions`, `roles` y `departments` no tienen FK de entrada: son raíces.
 * `role_permissions` cuelga de roles y permissions. `users` cuelga de roles
 * (obligatorio) y departments (opcional).
 */
export const RESOLUTION_ORDER = [
  'permissions',
  'roles',
  'departments',
  'role_permissions',
  'users',
];

/** Índice único que cada tabla necesita para que el seed sea idempotente. */
export const REQUIRED_UNIQUE_KEYS = {
  permissions: { table: 'permissions', column: 'code' },
  roles: { table: 'roles', column: 'code' },
  departments: { table: 'departments', column: 'name' },
  // role_permissions tiene PK compuesta: la unicidad la da la propia PK, y por
  // eso un segundo seed no puede duplicar filas ni aunque quiera.
  role_permissions: { table: 'role_permissions', columns: ['role_id', 'permission_id'] },
  users: { table: 'users', column: 'username' },
  // Tablas C2. La comprobación solo se aplica cuando la tabla YA existe: si
  // todavía no hay DDL, es la lista de pendientes la que lo dice, no un error
  // de seed.
  categories: { table: 'categories', column: 'name' },
  sequences: { table: 'sequences', column: 'name' },
  settings: { table: 'settings', column: 'key' },
};

/** Tablas que el seed necesita pero que hoy no existen en DEV. */
export const TABLES_REQUIRING_DDL = {
  categories: 'categorías de tickets (las usa POST /api/tickets para validar)',
  kb_categories: 'categorías de la base de conocimiento',
  sequences: 'contador de numeración de tickets (TCK-000001)',
  settings: 'configuración (ticket_prefix y sla_*_hours)',
  teams: 'equipos de trabajo',
};

/**
 * El administrador NO se migra desde SQLite. Se crea por el mismo mecanismo
 * seguro que ya usa `src/seed.js`: solo nace si alguien define su contraseña,
 * nunca con una contraseña escrita en el repositorio.
 */
export const ADMIN_DEFAULTS = {
  roleCode: 'ADMIN',
  // 'Tecnología' es el departamento que ya usa `src/seed.js` para el admin, y
  // está en la lista de 25, así que la relación se resuelve por nombre.
  departmentName: 'Tecnología',
  name: 'Administrador',
  lastName: 'Sistema',
  position: 'Administrador del sistema',
  usernameEnv: 'SEED_ADMIN_USERNAME',
  emailEnv: 'SEED_ADMIN_EMAIL',
  passwordEnv: 'SEED_ADMIN_PASSWORD',
  forceEnv: 'SEED_ADMIN_FORCE_PASSWORD',
};

/**
 * Busca problemas en un plan, sin lanzarlos. Se separa de `assertPlanIsConsistent`
 * para que las pruebas puedan pasar planes ROTOS a propósito y comprobar que se
 * detectan, en vez de tener que confiar en que el plan real está bien.
 *
 * @returns {string[]} Lista de problemas; vacía significa plan sano.
 */
export function findPlanProblems({
  permissions = PERMISSIONS,
  roles = ROLES,
  departments = DEPARTMENTS,
  categories = CATEGORIES,
  kbCategories = KB_CATEGORIES,
  settings = SETTINGS,
  sequences = SEQUENCES,
  admin = ADMIN_DEFAULTS,
} = {}) {
  const problems = [];
  const dup = (label, values) => {
    const seen = new Set();
    for (const v of values) {
      if (seen.has(v)) problems.push(`${label}: clave lógica duplicada "${v}"`);
      seen.add(v);
    }
  };

  dup('permissions.code', permissions.map((p) => p.code));
  dup('roles.code', roles.map((r) => r.code));
  dup('departments.name', departments.map((d) => d.name));
  dup('categories.name', categories.map((c) => c.name));
  dup('kb_categories.name', kbCategories.map((c) => c.name));
  dup('settings.key', settings.map((s) => s.key));
  dup('sequences.name', sequences.map((s) => s.name));

  const permissionCodes = new Set(permissions.map((p) => p.code));
  for (const role of roles) {
    dup(`roles[${role.code}].permissions`, role.permissionCodes);
    for (const code of role.permissionCodes) {
      if (!permissionCodes.has(code)) {
        problems.push(`roles[${role.code}] usa el permiso "${code}", que no está en el plan`);
      }
    }
  }

  // El admin tiene que existir, o el seed no puede dejar el sistema accesible.
  if (!roles.some((r) => r.code === admin.roleCode)) {
    problems.push(`no hay ningún rol ${admin.roleCode} para el administrador`);
  }
  if (!departments.some((d) => d.name === admin.departmentName)) {
    problems.push(`no está el departamento "${admin.departmentName}" del administrador`);
  }

  // C3 consume la secuencia ticket_number de forma atómica: sin ella la
  // numeración no puede arrancar aunque el resto del seed esté completo.
  if (!sequences.some((s) => s.name === 'ticket_number')) {
    problems.push(`falta la secuencia "ticket_number" que C3 necesita para numerar`);
  }
  // El prefijo por defecto vive en settings. Sin la clave el código usa 'TCK'
  // como fallback (ticketNumber.js y settings.js), pero un plan que la pida
  // explícitamente no debería dejar el sistema sin la fila esencial.
  if (!settings.some((s) => s.key === 'ticket_prefix')) {
    problems.push(`falta la clave de settings "ticket_prefix" que la numeración espera`);
  }

  return problems;
}

/** Contrapruebas del plan. Se ejecutan antes de abrir la transacción. */
export function assertPlanIsConsistent(plan) {
  const problems = findPlanProblems(plan);
  if (problems.length) {
    const error = new Error('El plan de seed es inconsistente:\n  - ' + problems.join('\n  - '));
    error.code = 'SEED_PLAN_INCONSISTENT';
    error.problems = problems;
    throw error;
  }
  return true;
}

/** Resumen para logs y para el informe. */
export function describePlan() {
  return {
    permissions: PERMISSIONS.length,
    roles: ROLES.length,
    rolePermissions: ROLES.reduce((n, r) => n + r.permissionCodes.length, 0),
    departments: DEPARTMENTS.length,
    categories: CATEGORIES.length,
    kbCategories: KB_CATEGORIES.length,
    settings: SETTINGS.length,
    sequences: SEQUENCES.length,
    pendingDdl: Object.keys(TABLES_REQUIRING_DDL),
    order: RESOLUTION_ORDER.slice(),
  };
}
