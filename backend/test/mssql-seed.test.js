// B13-C · Pruebas del seed MSSQL, con un contrato falso en memoria.
//
// Estas pruebas NO tocan SQL Server. Comprueban tres cosas a la vez:
//
//   1. La lógica del seed: qué crea, en qué orden, y que no duplica.
//   2. El TEXTO del SQL que se envía: que no haya IDENTITY_INSERT, ni DBCC, ni
//      valores interpolados dentro de las sentencias.
//   3. Que la plan sea coherente antes de abrir una transacción.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_DEFAULTS,
  CATEGORIES,
  DEPARTMENTS,
  KB_CATEGORIES,
  PERMISSIONS,
  RESOLUTION_ORDER,
  ROLES,
  assertPlanIsConsistent,
  describePlan,
  findPlanProblems,
} from '../src/scripts/lib/mssqlSeedPlan.mjs';
import * as mssqlSeedPlan from '../src/scripts/lib/mssqlSeedPlan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'scripts', 'seed-mssql.mjs'),
  'utf8',
);
const PLAN_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'scripts', 'lib', 'mssqlSeedPlan.mjs'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Contrato falso: un SQL Server diminuto, en memoria.
// ---------------------------------------------------------------------------

/**
 * Estado inicial que reproduce el de SIFHA_Tickets_DEV el día de la auditoría:
 * las seis tablas de esquema creadas y VACÍAS, y los contadores IDENTITY
 * advanced por los intentos de B13-A (departments last=44, permissions last=5,
 * roles last=4, users last=3).
 *
 * Los contadores NO valen 0 a propósito: el seed tiene que funcionar con los
 * ids que le dé SQL Server, no con los de SQLite.
 */
/**
 * @param {object} [options]
 * @param {object} [options.counters] Último valor de cada IDENTITY.
 * @param {string[]} [options.tables] Tablas existentes; por defecto las seis de DEV.
 * @param {RegExp}   [options.failOn] Si una sentencia casa, revienta. Al vivir
 *   DENTRO de `dispatch` lo ven tanto `contract` como la `tx` de la transacción,
 *   que es donde ocurre el seed.
 * @param {boolean}  [options.missingUniqueKey] Simula que falta el índice único
 *   en las tablas de catálogo.
 */
function createFakeMssql({
  counters = {},
  tables = null,
  hasRolePermissionsIdentity = false,
  failOn = null,
  missingUniqueKey = false,
} = {}) {
  const present = new Set(tables || [
    'departments', 'permissions', 'role_permissions', 'roles', 'sessions', 'users',
  ]);

  const state = {
    departments: [],
    permissions: [],
    role_permissions: [],
    roles: [],
    users: [],
    sessions: [],
    counters: {
      departments: counters.departments ?? 44,
      permissions: counters.permissions ?? 5,
      roles: counters.roles ?? 4,
      users: counters.users ?? 3,
    },
    present,
    journal: [],
  };

  const unique = {
    departments: (r) => r.name.toLowerCase(),
    permissions: (r) => r.code.toLowerCase(),
    roles: (r) => r.code.toLowerCase(),
    users: (r) => r.username.toLowerCase(),
  };

  function nextId(table) {
    state.counters[table] += 1;
    return state.counters[table];
  }

  function enforceUnique(table, row, ignoreId = null) {
    const key = unique[table];
    if (!key) return;
    const clash = state[table].find((r) => key(r) === key(row) && r.id !== ignoreId);
    if (clash) {
      const e = new Error(`Violation of UNIQUE KEY: ${table}`);
      e.code = 'EREQUEST';
      e.number = 2627;
      throw e;
    }
  }

  function dispatch(sql, params) {
    state.journal.push({ sql, params });
    if (failOn && failOn.test(sql)) throw new Error('se cayó la conexión');

    // --- inspección del esquema ------------------------------------------
    if (/FROM sys\.tables/.test(sql)) {
      return [...state.present].map((name) => ({ name }));
    }
    if (/COUNT_BIG\(\*\) AS n FROM \[dbo\]/.test(sql)) {
      const table = /\[dbo\]\.\[(\w+)\]/.exec(sql)[1];
      return [{ n: BigInt((state[table] || []).length) }];
    }
    if (/FROM sys\.indexes/.test(sql) && /is_primary_key/.test(sql)) {
      const table = /\[dbo\]\.\[(\w+)\]/.exec(String(params.table))?.[1];
      const hasPk = table === 'role_permissions' || table === 'sessions';
      return [{ is_unique: true, is_primary_key: hasPk }];
    }
    if (/FROM sys\.index_columns/.test(sql)) {
      return [{ n: missingUniqueKey ? 0 : 1 }];
    }
    if (/COLUMNPROPERTY/.test(sql)) {
      return hasRolePermissionsIdentity ? [{ ok: 1 }] : [];
    }

    // --- lecturas ---------------------------------------------------------
    if (/SELECT id, code FROM permissions/.test(sql)) {
      return state.permissions.map((r) => ({ id: r.id, code: r.code }));
    }
    if (/SELECT id, code FROM roles/.test(sql)) {
      return state.roles.map((r) => ({ id: r.id, code: r.code }));
    }
    if (/SELECT id, name FROM departments/.test(sql)) {
      return state.departments.map((r) => ({ id: r.id, name: r.name }));
    }
    if (/FROM users\s+WHERE LOWER\(username\)/.test(sql)) {
      const u = String(params.username).toLowerCase();
      const e = String(params.email).toLowerCase();
      const row = state.users.find((r) => r.username.toLowerCase() === u || r.email.toLowerCase() === e);
      return row ? [row] : [];
    }

    // --- escrituras -------------------------------------------------------
    if (/INSERT INTO permissions/.test(sql)) {
      const row = { id: nextId('permissions'), code: params.code, description: params.description };
      enforceUnique('permissions', row);
      state.permissions.push(row);
      return { inserted: [row], rowsAffected: [1] };
    }
    if (/INSERT INTO roles/.test(sql)) {
      const row = { id: nextId('roles'), code: params.code, name: params.name, description: params.description };
      enforceUnique('roles', row);
      state.roles.push(row);
      return { inserted: [row], rowsAffected: [1] };
    }
    if (/INSERT INTO departments/.test(sql)) {
      const row = { id: nextId('departments'), name: params.name };
      enforceUnique('departments', row);
      state.departments.push(row);
      return { inserted: [row], rowsAffected: [1] };
    }
    if (/INSERT INTO role_permissions/.test(sql)) {
      const dup = state.role_permissions.some(
        (r) => r.role_id === params.roleId && r.permission_id === params.permissionId,
      );
      if (dup) return { inserted: [], rowsAffected: [0] };
      state.role_permissions.push({ role_id: params.roleId, permission_id: params.permissionId });
      return { inserted: [{ role_id: params.roleId }], rowsAffected: [1] };
    }
    if (/INSERT INTO users/.test(sql)) {
      const row = {
        id: nextId('users'),
        name: params.name,
        last_name: params.lastName,
        username: params.username,
        email: params.email,
        password_hash: params.hash,
        department_id: params.departmentId,
        position: params.position,
        role_id: params.roleId,
        active: 1,
        last_password_change_at: params.now,
      };
      enforceUnique('users', row);
      state.users.push(row);
      return { inserted: [row], rowsAffected: [1] };
    }
    if (/UPDATE users/.test(sql)) {
      const row = state.users.find((r) => r.id === params.id);
      if (row) {
        row.password_hash = params.hash;
        row.last_password_change_at = params.now;
        row.active = 1;
      }
      return { inserted: [], rowsAffected: [row ? 1 : 0] };
    }

    throw new Error(`El contrato falso no sabe responder a:\n${sql}`);
  }

  function wrap() {
    return {
      async queryMany(sql, params) { return dispatch(sql, params || {}); },
      async queryOne(sql, params) { return dispatch(sql, params || {})[0] ?? null; },
      async execute(sql, params) {
        const r = dispatch(sql, params || {});
        return { rowsAffected: (r.rowsAffected || []).reduce((a, b) => a + Number(b), 0) };
      },
      async insertAndGetId(sql, params) {
        const r = dispatch(sql, params || {});
        return { id: r.inserted[0].id, rowsAffected: 1 };
      },
    };
  }

  const contract = wrap();

  // Copia profunda para que el rollback pueda deshacer de verdad.
  const snapshot = JSON.parse(JSON.stringify({
    departments: state.departments,
    permissions: state.permissions,
    role_permissions: state.role_permissions,
    roles: state.roles,
    users: state.users,
    counters: state.counters,
  }));
  const restore = () => Object.assign(state, JSON.parse(JSON.stringify(snapshot)));

  contract.transactionAsync = async (callback) => {
    try {
      return await callback(wrap());
    } catch (error) {
      // Rollback de verdad: si el seed falla a mitad, no queda nada a medias.
      restore();
      throw error;
    }
  };
  contract.close = async () => {};
  contract.state = state;

  return contract;
}

/** Ejecuta el seed con un contrato falso y contraseña de administrador. */
async function seedWith(options = {}) {
  const contract = createFakeMssql(options);
  const previous = {
    password: process.env[ADMIN_DEFAULTS.passwordEnv],
    username: process.env[ADMIN_DEFAULTS.usernameEnv],
    force: process.env[ADMIN_DEFAULTS.forceEnv],
  };
  process.env[ADMIN_DEFAULTS.passwordEnv] = options.password ?? 'una-contrasena-larga';
  process.env[ADMIN_DEFAULTS.usernameEnv] = options.username ?? 'admin';
  delete process.env[ADMIN_DEFAULTS.forceEnv];

  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  try {
    const result = await runSeed({ contract, execute: options.execute !== false, log: () => {} });
    return { contract, result, state: contract.state };
  } finally {
    if (previous.password === undefined) delete process.env[ADMIN_DEFAULTS.passwordEnv];
    else process.env[ADMIN_DEFAULTS.passwordEnv] = previous.password;
    if (previous.username === undefined) delete process.env[ADMIN_DEFAULTS.usernameEnv];
    else process.env[ADMIN_DEFAULTS.usernameEnv] = previous.username;
    if (previous.force === undefined) delete process.env[ADMIN_DEFAULTS.forceEnv];
    else process.env[ADMIN_DEFAULTS.forceEnv] = previous.force;
  }
}

// ---------------------------------------------------------------------------
// 1. El plan
// ---------------------------------------------------------------------------

test('b13-c · el plan es coherente y no tiene claves lógicas duplicadas', () => {
  assert.equal(assertPlanIsConsistent(), true);
  const d = describePlan();
  assert.equal(d.permissions, 24, 'los mismos 24 permisos que SQLite');
  assert.equal(d.roles, 3);
  assert.equal(d.departments, 25, 'los mismos 25 departamentos que SQLite');
  assert.equal(d.categories, 11);
  assert.equal(d.kbCategories, 7);
});

test('b13-c · un plan incoherente se detecta ANTES de abrir la transacción', () => {
  // El plan real está sano.
  assert.equal(assertPlanIsConsistent(), true);
  assert.deepEqual(findPlanProblems(), []);

  // Clave lógica duplicada: dos departamentos con el mismo nombre no podrían
  // coexistir y el seed insertaría el segundo y reventaría.
  assert.match(
    findPlanProblems({ departments: [...DEPARTMENTS, { name: DEPARTMENTS[0].name }] })[0],
    /departments\.name: clave lógica duplicada/,
  );

  // Un rol que apunta a un permiso inexistente dejaría al usuario sin ese
  // permiso y sin ningún aviso.
  assert.match(
    findPlanProblems({
      roles: [{ code: 'X', name: 'X', description: '', permissionCodes: ['no.existe'] }],
    }).join('\n'),
    /roles\[X\] usa el permiso "no\.existe", que no está en el plan/,
  );

  // Y el caso que de verdad importaría: sin rol ADMIN el seed dejaría la base
  // sin ninguna forma de entrar.
  assert.match(
    findPlanProblems({ roles: [ROLES[0]] }).join('\n'),
    /no hay ningún rol ADMIN para el administrador/,
  );

  // Sin el departamento del admin tampoco se puede crearlo.
  assert.match(
    findPlanProblems({ departments: DEPARTMENTS.filter((d) => d.name !== 'Tecnología') }).join('\n'),
    /no está el departamento "Tecnología" del administrador/,
  );

  // Y assertPlanIsConsistent lanza de verdad, no solo devuelve la lista.
  assert.throws(
    () => assertPlanIsConsistent({ departments: [...DEPARTMENTS, { name: DEPARTMENTS[0].name }] }),
    (e) => e.code === 'SEED_PLAN_INCONSISTENT' && /duplicada/.test(e.message),
  );
});

test('b13-c · el orden de resolución respeta las FK', () => {
  const i = (n) => RESOLUTION_ORDER.indexOf(n);
  assert.ok(i('permissions') < i('role_permissions'), 'role_permissions cuelga de permissions');
  assert.ok(i('roles') < i('role_permissions'), 'role_permissions cuelga de roles');
  assert.ok(i('roles') < i('users'), 'users cuelga de roles (obligatorio)');
  assert.ok(i('departments') < i('users'), 'users cuelga de departments');
  // Las tres raíces no tienen FK de entrada.
  assert.equal(i('permissions'), 0);
  assert.equal(i('roles'), 1);
  assert.equal(i('departments'), 2);
});

// ---------------------------------------------------------------------------
// 2. Seed sobre destino vacío
// ---------------------------------------------------------------------------

test('b13-c · siembra un destino vacío con los IDs que le da SQL Server', async () => {
  const { state, result } = await seedWith();

  assert.equal(state.permissions.length, 24);
  assert.equal(state.roles.length, 3);
  assert.equal(state.departments.length, 25);
  assert.equal(state.users.length, 1, 'solo el administrador: no se migran los 5 de SQLite');

  // El punto central de la estrategia: los ids son los de SQL Server, no los de
  // SQLite. SQLite tenía roles 1,2,3 y aquí empiezan en 5.
  const roleIds = state.roles.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(roleIds, [5, 6, 7], 'SQL Server continued desde 4, no desde 1');
  const deptIds = state.departments.map((d) => d.id);
  assert.ok(Math.min(...deptIds) > 30, 'los departamentos empiezan en 45, no en 1');

  assert.equal(result.admin.created, true);
  assert.equal(state.users[0].role_id, roleIds.find((id) => state.roles.find((r) => r.id === id).code === 'ADMIN'));
  assert.ok(state.users[0].password_hash.startsWith('$2'), 'bcrypt, no la contraseña en claro');
  assert.notEqual(state.users[0].password_hash, 'una-contrasena-larga');
});

test('b13-c · la relación role_permissions se construye con los ids NUEVOS', async () => {
  const { state } = await seedWith();

  const adminRole = state.roles.find((r) => r.code === 'ADMIN');
  const techRole = state.roles.find((r) => r.code === 'TECHNICIAN');
  const empRole = state.roles.find((r) => r.code === 'EMPLOYEE');

  const of = (roleId) => new Set(state.role_permissions.filter((r) => r.role_id === roleId).map((r) => r.permission_id));
  const codeOf = (permId) => state.permissions.find((p) => p.id === permId)?.code;
  const codesOf = (roleId) => [...of(roleId)].map(codeOf).sort();

  // Equivalencia FUNCIONAL con SQLite: mismos códigos por rol.
  assert.deepEqual(codesOf(empRole.id).sort(),
    ['kb.view', 'ticket.comment', 'ticket.create', 'ticket.view.own']);
  assert.deepEqual(codesOf(techRole.id).sort(),
    ['dashboard.view', 'kb.create', 'kb.publish', 'kb.view', 'ticket.assign', 'ticket.close',
      'ticket.comment', 'ticket.create', 'ticket.note', 'ticket.reopen', 'ticket.resolve',
      'ticket.update.any', 'ticket.view.all']);
  assert.deepEqual(codesOf(adminRole.id).sort(),
    PERMISSIONS.map((p) => p.code).sort());

  // Y ninguna de esas filas usa un id de SQLite como permission_id.
  const sqliteRoleIds = new Set([1, 2, 3]);
  assert.equal(state.role_permissions.filter((r) => sqliteRoleIds.has(r.role_id)).length, 0);
  assert.equal(state.role_permissions.filter((r) => r.permission_id <= 5).length, 0,
    'los permisos empiezan en 6, así que ningún permission_id puede ser de SQLite');
});

test('b13-c · el total de role_permissions es el de SQLite (41)', async () => {
  const { state } = await seedWith();
  assert.equal(state.role_permissions.length, 41);
});

// ---------------------------------------------------------------------------
// 3. Idempotencia
// ---------------------------------------------------------------------------

test('b13-c · la segunda ejecución no duplica nada', async () => {
  const { contract, state } = await seedWith();
  const antes = {
    p: state.permissions.length,
    r: state.roles.length,
    d: state.departments.length,
    u: state.users.length,
    rp: state.role_permissions.length,
  };

  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  const segunda = await runSeed({ contract, execute: true, log: () => {} });

  assert.equal(state.permissions.length, antes.p);
  assert.equal(state.roles.length, antes.r);
  assert.equal(state.departments.length, antes.d);
  assert.equal(state.users.length, antes.u);
  assert.equal(state.role_permissions.length, antes.rp, 'ni una fila de role_permissions más');
  assert.equal(segunda.created, 0, 'la segunda pasada no crea nada');
  assert.equal(segunda.rolePermissionsCreated, 0);
});

test('b13-c · una tercera vez sigue igual: el seed es reentrante', async () => {
  const { contract, state } = await seedWith();
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  await runSeed({ contract, execute: true, log: () => {} });
  await runSeed({ contract, execute: true, log: () => {} });
  assert.equal(state.role_permissions.length, 41);
  assert.equal(state.users.length, 1);
  assert.equal(state.departments.length, 25);
});

test('b13-c · no crea el administrador si la cuenta ya existe', async () => {
  const { contract, state } = await seedWith();
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  const hashAntes = state.users[0].password_hash;
  const resultado = await runSeed({ contract, execute: true, log: () => {} });
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].password_hash, hashAntes, 'no le toca la contraseña sin SEED_ADMIN_FORCE_PASSWORD');
  assert.equal(resultado.admin.created, false);
  assert.equal(resultado.admin.reason, 'ya-existe');
});

test('b13-c · sin SEED_ADMIN_PASSWORD no crea ningún usuario', async () => {
  const previous = process.env[ADMIN_DEFAULTS.passwordEnv];
  delete process.env[ADMIN_DEFAULTS.passwordEnv];
  try {
    const contract = createFakeMssql();
    const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
    const r = await runSeed({ contract, execute: true, log: () => {} });
    assert.equal(contract.state.users.length, 0, 'nunca una cuenta con contraseña conocida en el repo');
    assert.equal(r.admin.reason, 'sin-password');
  } finally {
    if (previous !== undefined) process.env[ADMIN_DEFAULTS.passwordEnv] = previous;
  }
});

// ---------------------------------------------------------------------------
// 4. Nada de IDENTITY_INSERT, DBCC ni SQL dinámico con datos
// ---------------------------------------------------------------------------

/** El código del seed sin comentarios: lo que se EJECUTA, no lo que se explica. */
function codeWithoutComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

test('b13-c · cero IDENTITY_INSERT y cero DBCC en todo el seed', async () => {
  const { state } = await seedWith();

  for (const { sql } of state.journal) {
    assert.doesNotMatch(sql, /IDENTITY_INSERT/i, `sentencia con IDENTITY_INSERT:\n${sql}`);
    assert.doesNotMatch(sql, /\bDBCC\b/i, `sentencia con DBCC:\n${sql}`);
    assert.doesNotMatch(sql, /CHECKIDENT/i, `sentencia con CHECKIDENT:\n${sql}`);
    assert.doesNotMatch(sql, /\bRESEED\b/i, `sentencia con RESEED:\n${sql}`);
    assert.doesNotMatch(sql, /\bDELETE\b/i, `sentencia que borra datos:\n${sql}`);
    assert.doesNotMatch(sql, /\bDROP\b/i, `sentencia DDL:\n${sql}`);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `sentencia DDL:\n${sql}`);
    assert.doesNotMatch(sql, /\bMERGE\b/i, `sentencia que el seed evita a propósito:\n${sql}`);
  }

  // Tampoco en el código ejecutable. La cabecera SÍ menciona IDENTITY_INSERT y
  // DBCC, pero para decir que no los usa: por eso se quitan los comentarios
  // antes de mirar, en vez de prohibirse la palabra.
  const codigo = codeWithoutComments(SEED_SOURCE);
  assert.doesNotMatch(codigo, /IDENTITY_INSERT/);
  assert.doesNotMatch(codigo, /\bDBCC\b/);
  assert.doesNotMatch(codigo, /CHECKIDENT/);
  assert.doesNotMatch(codigo, /\bRESEED\b/);
  assert.doesNotMatch(codeWithoutComments(PLAN_SOURCE), /IDENTITY_INSERT/);
});

test('b13-c · todo dato viaja como parámetro @nombre, ninguno interpolado', async () => {
  const { state } = await seedWith();
  const writes = state.journal.filter((j) => /^\s*INSERT/.test(j.sql) || /^\s*UPDATE/.test(j.sql));
  assert.ok(writes.length >= 24 + 3 + 25 + 1, 'hubo escrituras de verdad');

  for (const { sql, params } of writes) {
    assert.match(sql, /@[a-zA-Z_]\w*/, `falta un parámetro en:\n${sql}`);
    for (const key of Object.keys(params)) {
      assert.doesNotMatch(sql, new RegExp(`'${String(params[key]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
        `el valor de ${key} aparece dentro del SQL, no como parámetro:\n${sql}`);
    }
  }

  // Los nombres de tabla vienen del código, no de datos: solo los cinco del plan.
  const tablas = [...SEED_SOURCE.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tablas)].sort(), ['departments', 'permissions', 'role_permissions', 'roles', 'users']);
});

test('b13-c · el seed no depende de ningún id histórico', async () => {
  // El plan no puede contener ids de SQLite como constantes.
  assert.doesNotMatch(PLAN_SOURCE, /sqlite_sequence/);
  assert.doesNotMatch(PLAN_SOURCE, /\bsqlite_sequence\s*=\s*480/);

  // Y arrancar con contadores muy distintos debe dar el mismo resultado funcional.
  const conContadoresAltos = await seedWith({ counters: { departments: 900, permissions: 70, roles: 12, users: 40 } });
  const conContadoresCeros = await seedWith({ counters: { departments: 0, permissions: 0, roles: 0, users: 0 } });

  const formaDe = (state) => ({
    roles: state.roles.map((r) => r.code).sort(),
    perms: state.permissions.length,
    depts: state.departments.length,
    rp: state.role_permissions.length,
    adminPerms: state.role_permissions.filter((r) => r.role_id === state.roles.find((x) => x.code === 'ADMIN').id).length,
  });

  assert.deepEqual(formaDe(conContadoresAltos.state), formaDe(conContadoresCeros.state),
    'el resultado es el mismo con ids altos que con ids desde 1');
  assert.ok(Math.min(...conContadoresAltos.state.departments.map((d) => d.id)) > 900);
});

// ---------------------------------------------------------------------------
// 5. Rollback ante fallo
// ---------------------------------------------------------------------------

test('b13-c · un fallo a mitad deja la base como estaba', async () => {
  // Se rompe al leer los roles, DESPUÉS de haber insertado los 24 permisos.
  const contract = createFakeMssql({ failOn: /SELECT id, code FROM roles/ });

  const previous = process.env[ADMIN_DEFAULTS.passwordEnv];
  process.env[ADMIN_DEFAULTS.passwordEnv] = 'una-contrasena-larga';
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  try {
    await assert.rejects(() => runSeed({ contract, execute: true, log: () => {} }), /se cayó la conexión/);
  } finally {
    if (previous === undefined) delete process.env[ADMIN_DEFAULTS.passwordEnv];
    else process.env[ADMIN_DEFAULTS.passwordEnv] = previous;
  }

  assert.equal(contract.state.permissions.length, 0, 'los permisos insertados antes del fallo se deshicieron');
  assert.equal(contract.state.departments.length, 0);
  assert.equal(contract.state.users.length, 0);
  assert.equal(contract.state.counters.permissions, 5, 'y el contador IDENTITY también volvió atrás');
});

test('b13-c · aborta si el destino no tiene la clave lógica única', async () => {
  const contract = createFakeMssql({ missingUniqueKey: true });
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  await assert.rejects(() => runSeed({ contract, execute: true, log: () => {} }), /idempotente/);
  assert.equal(contract.state.permissions.length, 0);
});

test('b13-c · aborta, sin escribir, si falta una tabla del esquema', async () => {
  const contract = createFakeMssql({ tables: ['departments', 'roles', 'users'] });
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  await assert.rejects(() => runSeed({ contract, execute: true, log: () => {} }), /Faltan tablas/);
  assert.equal(contract.state.departments.length, 0);
});

// ---------------------------------------------------------------------------
// 6. --check no escribe
// ---------------------------------------------------------------------------

test('b13-c · --check no escribe una sola sentencia de datos', async () => {
  const contract = createFakeMssql();
  const { runSeed } = await import('../src/scripts/seed-mssql.mjs');
  const result = await runSeed({ contract, execute: false, log: () => {} });
  assert.equal(result.check, true);
  assert.equal(result.created, 0);
  const escrituras = contract.state.journal.filter((j) => /^\s*(INSERT|UPDATE|DELETE|MERGE)/i.test(j.sql));
  assert.equal(escrituras.length, 0, 'en --check no sale ninguna escritura');
  assert.equal(contract.state.departments.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Lo que NO se siembra, y está escrito en el código
// ---------------------------------------------------------------------------

test('b13-c · el plan declara qué tablas quedan pendientes de DDL, y por qué', () => {
  const { TABLES_REQUIRING_DDL } = mssqlSeedPlan;
  assert.deepEqual(
    Object.keys(TABLES_REQUIRING_DDL).sort(),
    ['categories', 'kb_categories', 'sequences', 'settings', 'teams'],
  );
  // Sin estas, POST /api/tickets no puede validar ni numerar: se documenta, no
  // se esconde.
  assert.match(TABLES_REQUIRING_DDL.sequences, /TCK-000001/);
  assert.match(TABLES_REQUIRING_DDL.settings, /ticket_prefix/);
  assert.match(SEED_SOURCE, /TABLES_REQUIRING_DDL/);
  // El seed no las crea: no hay DDL en su SQL.
  assert.doesNotMatch(codeWithoutComments(SEED_SOURCE), /CREATE\s+TABLE/i);
});

test('b13-c · los catálogos sin tabla no se intentan sembrar', async () => {
  const { state } = await seedWith();
  // categories y kb_categories no existen en DEV: no se inventan ni se saltan.
  assert.equal(state.categories, undefined);
  assert.equal(state.kbCategories, undefined);
  // Pero sus datos están listos para cuando haya DDL.
  assert.equal(CATEGORIES.length, 11);
  assert.equal(KB_CATEGORIES.length, 7);
});

test('b13-c · no siembra usuarios de SQLite ni tickets', async () => {
  const { state } = await seedWith();
  const usernames = state.users.map((u) => u.username);
  assert.deepEqual(usernames, ['admin'], 'ni lrosario, ni YFRANCISCO, ni empleado, ni tecnico');
  assert.equal(state.tickets, undefined, 'tickets no se tocan: SQLite queda como respaldo');
});

test('b13-c · el seed se bloquea fuera de una base de desarrollo', async () => {
  const { isDevelopmentDatabase } = await import('../src/db/mssql.js');
  assert.equal(isDevelopmentDatabase('SIFHA_Tickets_DEV'), true);
  assert.equal(isDevelopmentDatabase('SIFHA_Tickets'), false);
  assert.equal(isDevelopmentDatabase('SIFHA_Tickets_PROD'), false);
  assert.equal(isDevelopmentDatabase('production'), false);
  assert.match(SEED_SOURCE, /isDevelopmentDatabase/);
});