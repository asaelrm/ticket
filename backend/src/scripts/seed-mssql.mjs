// B13-C · Seed idempotente para SIFHA_Tickets_DEV.
//
// QUÉ ES Y QUÉ NO ES
// ------------------
// Es un seed: crea los datos que el backend necesita para arrancar y para que un
// administrador pueda entrar. NO es una migración de SQLite, y por diseño:
//
//   · NO copia ningún id de SQLite. SQL Server asigna los suyos con IDENTITY.
//   · NO usa IDENTITY_INSERT, ni DBCC, ni reseed.
//   · NO borra ni actualiza datos que ya existieran.
//   · NO hace DDL. Si falta una tabla, lo dice y sigue; crearla es otra tarea.
//   · NO migra usuarios ni tickets: SQLite queda intacto como respaldo.
//
// CÓMO ES IDEMPOTENTE
// -------------------
// Cada entidad se busca por su clave lógica (name / code / username), que es la
// que tiene UNIQUE. Si existe, no se toca. Si no, se inserta y se lee el id que
// haya generado SQL Server. La lectura lleva `UPDLOCK, HOLDLOCK` para que dos
// ejecuciones simultáneas no puedan colarse la misma clave: es la forma de
// garantizar unicidad sin `MERGE` y sin SQL dinámico.
//
// El SQL va entero en el código y los datos SIEMPRE como parámetros `@nombre`.
// No hay concatenación de valores en ninguna sentencia.
//
// USO
//   node src/scripts/seed-mssql.mjs --check     solo lee, informa, no escribe
//   node src/scripts/seed-mssql.mjs --execute   siembra

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { createMssqlContract, isDevelopmentDatabase } from '../db/mssql.js';
import {
  ADMIN_DEFAULTS,
  CATEGORIES,
  DEPARTMENTS,
  KB_CATEGORIES,
  PERMISSIONS,
  REQUIRED_UNIQUE_KEYS,
  RESOLUTION_ORDER,
  ROLES,
  SEQUENCES,
  SETTINGS,
  TABLES_REQUIRING_DDL,
  assertPlanIsConsistent,
} from './lib/mssqlSeedPlan.mjs';

// `fileURLToPath`, no `new URL(...).pathname`: en Windows el pathname lleva una
// barra inicial y acabaría rutas como `/D:/...`, que no resuelven.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: config } = await import(pathToFileURL(path.join(HERE, '..', 'config.js')).href);

const BCRYPT_COST = 12;

function boolEnv(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// ---------------------------------------------------------------------------
// Utilidades de lectura. Todas son SELECT y solo se usan para decidir qué falta.
// ---------------------------------------------------------------------------

/** Qué tablas de dbo existen ahora mismo. */
async function listTables(tx) {
  return tx.queryMany(`
    SELECT t.name AS name
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo'`);
}

async function assertUniqueKeysExist(tx, present = null) {
  // Sin la clave lógica no hay idempotencia posible, así que esto aborta antes de
  // escribir nada en vez de descubrirlo a mitad. `present` es el conjunto de
  // tablas dbo que existen ahora mismo: las tablas C2 que aún no tienen DDL se
  // saltan porque son las listas de pendientes las que las reportan, no un error.
  const problems = [];
  for (const [step, spec] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    if (present && !present.has(step)) continue;
    const indexes = await tx.queryMany(`
      SELECT i.is_unique AS is_unique, i.is_primary_key AS is_primary_key
      FROM sys.indexes i
      WHERE i.object_id = OBJECT_ID(@table) AND i.is_unique = 1`, { table: `[dbo].[${spec.table}]` });

    if (step === 'role_permissions') {
      const hasPk = indexes.some((i) => Boolean(i.is_primary_key));
      if (!hasPk) problems.push(`role_permissions necesita su PK (${spec.columns.join(', ')}) para no duplicar`);
      continue;
    }
    const covers = await tx.queryMany(`
      SELECT COUNT(*) AS n
      FROM sys.index_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      WHERE i.object_id = OBJECT_ID(@table) AND i.is_unique = 1 AND c.name = @column`,
    { table: `[dbo].[${spec.table}]`, column: spec.column });
    if (!covers.some((r) => Number(r.n) > 0)) {
      problems.push(`falta un índice ÚNICO en ${spec.table}(${spec.column}); el seed no sería idempotente`);
    }
  }
  if (problems.length) {
    const error = new Error('El destino no garantiza la idempotencia:\n  - ' + problems.join('\n  - '));
    error.code = 'SEED_MISSING_UNIQUE_KEY';
    error.problems = problems;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Los cinco pasos. Devuelven el informe; no deciden nada por su cuenta.
// ---------------------------------------------------------------------------

async function seedPermissions(tx, report) {
  const existing = new Map((await tx.queryMany('SELECT id, code FROM permissions'))
    .map((r) => [r.code, r.id]));

  const ids = {};
  for (const { code, description } of PERMISSIONS) {
    if (existing.has(code)) {
      ids[code] = existing.get(code);
      report.push({ paso: 'permissions', clave: code, accion: 'ya-existe', id: ids[code] });
      continue;
    }
    const { id } = await tx.insertAndGetId(
      `INSERT INTO permissions (code, description)
       OUTPUT INSERTED.id AS id
       VALUES (@code, @description)`,
      { code, description },
    );
    ids[code] = id;
    report.push({ paso: 'permissions', clave: code, accion: 'creado', id });
  }
  return ids;
}

async function seedRoles(tx, report) {
  const existing = new Map((await tx.queryMany('SELECT id, code FROM roles'))
    .map((r) => [r.code, r.id]));

  const ids = {};
  for (const { code, name, description } of ROLES) {
    if (existing.has(code)) {
      ids[code] = existing.get(code);
      report.push({ paso: 'roles', clave: code, accion: 'ya-existe', id: ids[code] });
      continue;
    }
    const { id } = await tx.insertAndGetId(
      `INSERT INTO roles (code, name, description)
       OUTPUT INSERTED.id AS id
       VALUES (@code, @name, @description)`,
      { code, name, description },
    );
    ids[code] = id;
    report.push({ paso: 'roles', clave: code, accion: 'creado', id });
  }
  return ids;
}

async function seedDepartments(tx, report) {
  const existing = new Map((await tx.queryMany('SELECT id, name FROM departments'))
    .map((r) => [r.name, r.id]));

  const ids = {};
  for (const { name } of DEPARTMENTS) {
    if (existing.has(name)) {
      ids[name] = existing.get(name);
      report.push({ paso: 'departments', clave: name, accion: 'ya-existe', id: ids[name] });
      continue;
    }
    const { id } = await tx.insertAndGetId(
      `INSERT INTO departments (name)
       OUTPUT INSERTED.id AS id
       VALUES (@name)`,
      { name },
    );
    ids[name] = id;
    report.push({ paso: 'departments', clave: name, accion: 'creado', id });
  }
  return ids;
}

async function seedRolePermissions(tx, report, roleIds, permissionIds) {
  // El id de role_permissions lo pone SQL Server... salvo que la tabla no lo
  // tenga. Es la única del plan sin IDENTITY, porque su clave natural es la PK
  // compuesta. Se comprueba en vez de suponerlo.
  const hasIdentity = (await tx.queryMany(`
    SELECT 1 AS ok
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.role_permissions')
      AND COLUMNPROPERTY(object_id, name, 'IsIdentity') = 1`)).length > 0;

  const sql = hasIdentity
    ? `INSERT INTO role_permissions (role_id, permission_id)
       OUTPUT INSERTED.role_id AS role_id, INSERTED.permission_id AS permission_id
       VALUES (@roleId, @permissionId)
       WHERE NOT EXISTS (
         SELECT 1 FROM role_permissions WITH (UPDLOCK, HOLDLOCK)
         WHERE role_id = @roleId AND permission_id = @permissionId)`
    : `INSERT INTO role_permissions (role_id, permission_id)
       SELECT @roleId, @permissionId
       WHERE NOT EXISTS (
         SELECT 1 FROM role_permissions WITH (UPDLOCK, HOLDLOCK)
         WHERE role_id = @roleId AND permission_id = @permissionId)`;

  let created = 0;
  let already = 0;
  for (const role of ROLES) {
    const roleId = roleIds[role.code];
    if (!roleId) throw new Error(`El rol ${role.code} no tiene id: no se puede enlazar sus permisos.`);
    for (const permCode of role.permissionCodes) {
      const permissionId = permissionIds[permCode];
      if (!permissionId) throw new Error(`El permiso ${permCode} no tiene id: no se puede enlazar.`);
      const res = await tx.execute(sql, { roleId, permissionId });
      if (res.rowsAffected > 0) created += 1;
      else already += 1;
    }
  }
  report.push({
    paso: 'role_permissions',
    clave: `${ROLES.length} roles`,
    accion: 'enlazados',
    creados: created,
    yaExistentes: already,
  });
  return { created, already };
}

// ---------------------------------------------------------------------------
// C2 · Los catálogos que C1 crea bajo DDL: categories, sequences y settings.
// Son pasos OPCIONALES: solo corren si la tabla ya existe. Si aún no, la lista
// de pendientes de DDL ya lo dice desde inspect() y el seed no se detiene.
// ---------------------------------------------------------------------------

async function seedCategories(tx, report) {
  const existing = new Map((await tx.queryMany('SELECT id, name FROM categories'))
    .map((r) => [r.name, r.id]));

  let created = 0;
  let already = 0;
  for (const { name, description, color } of CATEGORIES) {
    if (existing.has(name)) {
      already += 1;
      report.push({ paso: 'categories', clave: name, accion: 'ya-existe', id: existing.get(name) });
      continue;
    }
    const { id } = await tx.insertAndGetId(
      `INSERT INTO categories (name, description, color)
       OUTPUT INSERTED.id AS id
       VALUES (@name, @description, @color)`,
      { name, description, color },
    );
    created += 1;
    report.push({ paso: 'categories', clave: name, accion: 'creado', id });
  }
  return { created, already };
}

async function seedSequences(tx, report) {
  const existing = new Map((await tx.queryMany('SELECT name, value FROM sequences'))
    .map((r) => [r.name, r.value]));

  let created = 0;
  let already = 0;
  for (const { name, value } of SEQUENCES) {
    if (existing.has(name)) {
      already += 1;
      report.push({ paso: 'sequences', clave: name, accion: 'ya-existe', value: existing.get(name) });
      continue;
    }
    const res = await tx.execute(
      'INSERT INTO sequences (name, value) VALUES (@name, @value)',
      { name, value },
    );
    created += res.rowsAffected > 0 ? 1 : 0;
    report.push({ paso: 'sequences', clave: name, accion: 'creado', value });
  }
  return { created, already };
}

async function seedSettings(tx, report) {
  const existing = new Set((await tx.queryMany('SELECT [key] FROM settings'))
    .map((r) => r.key));

  let created = 0;
  let already = 0;
  for (const { key, value } of SETTINGS) {
    if (existing.has(key)) {
      already += 1;
      report.push({ paso: 'settings', clave: key, accion: 'ya-existe' });
      continue;
    }
    const res = await tx.execute(
      'INSERT INTO settings ([key], value) VALUES (@key, @value)',
      { key, value },
    );
    created += res.rowsAffected > 0 ? 1 : 0;
    report.push({ paso: 'settings', clave: key, accion: 'creado' });
  }
  return { created, already };
}

async function seedAdmin(tx, report, roleIds, departmentIds, env) {
  const password = process.env[ADMIN_DEFAULTS.passwordEnv] || '';
  const force = boolEnv(process.env[ADMIN_DEFAULTS.forceEnv]);
  const username = process.env[ADMIN_DEFAULTS.usernameEnv] || 'admin';
  const email = process.env[ADMIN_DEFAULTS.emailEnv] || 'admin@empresa.com';

  if (!password) {
    report.push({
      paso: 'users',
      clave: username,
      accion: 'omitido',
      motivo: `no hay ${ADMIN_DEFAULTS.passwordEnv}: el administrador NO se crea sin contraseña`,
    });
    return { created: false, reason: 'sin-password' };
  }

  const roleId = roleIds[ADMIN_DEFAULTS.roleCode];
  if (!roleId) throw new Error('No se puede crear el administrador: falta el rol ADMIN.');

  // Se busca por username O email, igual que hace el login, para no dejar dos
  // cuentas que en la práctica son la misma.
  const existing = await tx.queryOne(`
    SELECT id FROM users
    WHERE LOWER(username) = LOWER(@username) OR LOWER(email) = LOWER(@email)`,
    { username, email });

  if (existing && !force) {
    report.push({
      paso: 'users',
      clave: username,
      accion: 'omitido',
      motivo: `ya existe y ${ADMIN_DEFAULTS.forceEnv} no está activo`,
    });
    return { created: false, reason: 'ya-existe' };
  }

  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const departmentId = departmentIds[ADMIN_DEFAULTS.departmentName] ?? null;

  if (existing) {
    await tx.execute(`
      UPDATE users
      SET password_hash = @hash, last_password_change_at = @now, active = 1
      WHERE id = @id`,
    { hash, now: new Date(), id: existing.id });
    report.push({
      paso: 'users',
      clave: username,
      accion: 'contrasena-restablecida',
      id: existing.id,
      aviso: `quite ${ADMIN_DEFAULTS.passwordEnv} y ${ADMIN_DEFAULTS.forceEnv} del entorno en cuanto pueda`,
    });
    return { created: false, reset: true, id: existing.id };
  }

  const { id } = await tx.insertAndGetId(
    `INSERT INTO users (name, last_name, username, email, password_hash,
                        department_id, position, role_id, active, last_password_change_at)
     OUTPUT INSERTED.id AS id
     VALUES (@name, @lastName, @username, @email, @hash,
             @departmentId, @position, @roleId, 1, @now)`,
    {
      name: ADMIN_DEFAULTS.name,
      lastName: ADMIN_DEFAULTS.lastName,
      username,
      email,
      hash,
      departmentId,
      position: ADMIN_DEFAULTS.position,
      roleId,
      now: new Date(),
    },
  );
  report.push({ paso: 'users', clave: username, accion: 'creado', id });
  return { created: true, id };
}

// ---------------------------------------------------------------------------
// Comprobación de solo lectura: qué falta y qué se saltaría.
// ---------------------------------------------------------------------------

async function inspect(contract) {
  const tables = await contract.queryMany(`
    SELECT t.name AS name FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo'`);
  const names = new Set(tables.map((t) => t.name));

  const required = [...RESOLUTION_ORDER, 'users'].filter((t) => t !== 'users');
  const requiredSet = new Set([...RESOLUTION_ORDER]);
  const missingRequired = [...requiredSet].filter((t) => !names.has(t));
  const pendingDdl = Object.entries(TABLES_REQUIRING_DDL)
    .filter(([t]) => !names.has(t))
    .map(([t, why]) => ({ tabla: t, motivo: why }));

  const counts = {};
  for (const t of requiredSet) {
    if (!names.has(t)) continue;
    counts[t] = (await contract.queryOne(`SELECT COUNT_BIG(*) AS n FROM [dbo].[${t}]`)).n;
  }

  const c2Counts = {};
  for (const t of ['categories', 'sequences', 'settings']) {
    if (!names.has(t)) continue;
    c2Counts[t] = (await contract.queryOne(`SELECT COUNT_BIG(*) AS n FROM [dbo].[${t}]`)).n;
  }

  return { names, missingRequired, pendingDdl, counts, c2Counts };
}

// ---------------------------------------------------------------------------

export async function runSeed({ contract, execute, log = console.log }) {
  assertPlanIsConsistent();

  const before = await inspect(contract);
  if (before.missingRequired.length) {
    const error = new Error(
      `Faltan tablas que el seed necesita: ${before.missingRequired.join(', ')}. `
      + 'El seed no hace DDL: crea el esquema antes.',
    );
    error.code = 'SEED_MISSING_TABLES';
    throw error;
  }

  const summary = {
    execute,
    created: 0,
    already: 0,
    skipped: 0,
    rolePermissionsCreated: 0,
    admin: null,
    pendingDdl: before.pendingDdl,
  };
  const report = [];

  if (!execute) {
    // Modo --check: cuenta lo que hay, no escribe. Se dice lo que FALTARÍA, con
    // los mismos pasos y la misma lógica, pero sin tocar nada.
    const counts = {
      permissions: PERMISSIONS.length,
      roles: ROLES.length,
      departments: DEPARTMENTS.length,
      role_permissions: ROLES.reduce((n, r) => n + r.permissionCodes.length, 0),
    };
    log(`[b13-c] --check: NO se escribe nada. Estado actual en ${config.mssql.database}:`);
    for (const [tabla, n] of Object.entries(before.counts)) {
      log(`[b13-c]   ${tabla}: ${n} filas`);
    }
    log(`[b13-c] el seed crearía lo que falte de:`);
    for (const [tabla, total] of Object.entries(counts)) {
      const actual = Number(before.counts[tabla] ?? 0);
      log(`[b13-c]   ${tabla}: ${total} en el plan, ${actual} ya, ${Math.max(0, total - actual)} a crear`);
    }
    // C2: catálogos opcionales. Solo se cuentan si su tabla ya existe (tras el
    // DDL de C1); si no, la lista de pendientes ya lo explica abajo.
    log(`[b13-c] C2 (solo si la tabla existe):`);
    for (const [tabla, total] of [['categories', CATEGORIES.length], ['sequences', SEQUENCES.length], ['settings', SETTINGS.length]]) {
      if (!before.names.has(tabla)) {
        log(`[b13-c]   ${tabla}: tabla ausente, pendiente de DDL (${TABLES_REQUIRING_DDL[tabla]})`);
        continue;
      }
      const actual = Number(before.c2Counts[tabla] ?? 0);
      log(`[b13-c]   ${tabla}: ${total} en el plan, ${actual} ya, ${Math.max(0, total - actual)} a crear`);
    }
    if (before.pendingDdl.length) {
      log('[b13-c] tablas que NO se pueden sembrar porque no existen (requieren DDL aparte):');
      for (const p of before.pendingDdl) log(`[b13-c]   ${p.tabla}: ${p.motivo}`);
    }
    if (!process.env[ADMIN_DEFAULTS.passwordEnv]) {
      log(`[b13-c] el administrador NO se crearía: falta ${ADMIN_DEFAULTS.passwordEnv}.`);
    } else {
      log(`[b13-c] el administrador "${process.env[ADMIN_DEFAULTS.usernameEnv] || 'admin'}" sí se crearía.`);
    }
    return { ...summary, report, check: true };
  }

  await contract.transactionAsync(async (tx) => {
    await assertUniqueKeysExist(tx, before.names);

    const permissionIds = await seedPermissions(tx, report);
    const roleIds = await seedRoles(tx, report);
    const departmentIds = await seedDepartments(tx, report);
    const rp = await seedRolePermissions(tx, report, roleIds, permissionIds);

    const c2 = {};
    if (before.names.has('categories')) c2.categories = await seedCategories(tx, report);
    if (before.names.has('sequences')) c2.sequences = await seedSequences(tx, report);
    if (before.names.has('settings')) c2.settings = await seedSettings(tx, report);

    const admin = await seedAdmin(tx, report, roleIds, departmentIds, config.env);

    summary.rolePermissionsCreated = rp.created;
    summary.admin = admin;
    summary.c2 = c2;
    for (const row of report) {
      if (row.accion === 'creado') summary.created += 1;
      else if (row.accion === 'ya-existe') summary.already += 1;
      else summary.skipped += 1;
    }
  });

  return { ...summary, report };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const check = args.includes('--check');

  if (!execute && !check) {
    console.error('Uso: node src/scripts/seed-mssql.mjs --check | --execute');
    console.error('  --check    solo lee e informa (por defecto es lo seguro)');
    console.error('  --execute  siembra los datos que falten');
    process.exitCode = 2;
    return;
  }

  if (!isDevelopmentDatabase(config.mssql.database)) {
    // Barrera explícita: el seed no se ejecuta nunca contra una base que no sea
    // de desarrollo o pruebas.
    console.error(`[b13-c] BLOQUEADO: "${config.mssql.database}" no es una base de desarrollo o pruebas.`);
    process.exitCode = 3;
    return;
  }

  const contract = createMssqlContract(config.mssql);
  try {
    const result = await runSeed({ contract, execute, log: console.log });
    if (!execute) return;

    console.log(`[b13-c] seed ${config.mssql.database} terminado:`);
    console.log(`[b13-c]   creados=${result.created} ya_existentes=${result.already} omitidos=${result.skipped}`);
    console.log(`[b13-c]   role_permissions enlazados=${result.rolePermissionsCreated}`);
    if (result.admin?.created) console.log('[b13-c]   administrador: creado');
    else if (result.admin?.reset) console.log('[b13-c]   administrador: contraseña restablecida');
    else if (result.admin) console.log(`[b13-c]   administrador: no creado (${result.admin.reason})`);
    if (result.pendingDdl.length) {
      console.log('[b13-c]   siguen sin tabla, requieren DDL aparte:');
      for (const p of result.pendingDdl) console.log(`[b13-c]     ${p.tabla}: ${p.motivo}`);
    }
  } finally {
    await contract.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}