// B11-B1 · verificación de solo lectura de los fixtures B11.
//
// No crea ni borra nada. Corre con la identidad de la aplicación
// (sifha_ticket_dev), la de mínimo privilegio: demuestra que para COMPROBAR los
// fixtures no hace falta ningún login administrativo nuevo.
//
// Uso:  node --env-file-if-exists=.env src/scripts/mssql-b11-verify.js
// Con B11_MARKER=... acota el recuento a un marcador concreto.

import config from '../config.js';
import { createMssqlContract, isDevelopmentDatabase } from '../db/mssql.js';
import { B11_ROLE_CODES, B11_PERMISSION_CODES } from '../fixtures/mssql.b11.js';

const EXPECTED_DATABASE = 'SIFHA_Tickets_DEV';

function assertTarget() {
  if (config.mssql.database !== EXPECTED_DATABASE) {
    throw new Error(`DB_DATABASE="${config.mssql.database}" no es ${EXPECTED_DATABASE}. No se continúa.`);
  }
  if (!isDevelopmentDatabase(config.mssql.database)) {
    throw new Error(`La base "${config.mssql.database}" no está marcada como DEV/TEST.`);
  }
}

async function main() {
  assertTarget();
  const contract = createMssqlContract(config.mssql);
  try {
    const who = await contract.queryOne('SELECT DB_NAME() AS db, ORIGINAL_LOGIN() AS login');
    if (who.db !== EXPECTED_DATABASE) {
      throw new Error(`La conexión está en "${who.db}" y no en ${EXPECTED_DATABASE}. Se aborta.`);
    }

    const marker = process.env.B11_MARKER || null;
    const prefix = marker ? `b11-%${marker}%` : 'b11-%';
    const roleList = B11_ROLE_CODES;

    const users = await contract.queryOne(
      'SELECT COUNT(*) AS n FROM dbo.users WHERE username LIKE @prefix',
      { prefix },
    );
    const roles = await contract.queryOne(
      `SELECT COUNT(*) AS n FROM dbo.roles WHERE code IN (${roleList.map((_, i) => `@r${i}`).join(', ')})`,
      { r0: roleList[0], r1: roleList[1], r2: roleList[2] },
    );
    const rolePermissions = await contract.queryOne(
      `SELECT COUNT(*) AS n FROM dbo.role_permissions
       WHERE role_id IN (SELECT id FROM dbo.roles WHERE code IN (${roleList.map((_, i) => `@r${i}`).join(', ')}))`,
      { r0: roleList[0], r1: roleList[1], r2: roleList[2] },
    );
    const sessions = await contract.queryOne(
      `SELECT COUNT(*) AS n FROM dbo.sessions
       WHERE CAST(JSON_VALUE(sess, '$.userId') AS INT)
             IN (SELECT id FROM dbo.users WHERE username LIKE @prefix)`,
      { prefix },
    );
    const permissions = await contract.queryOne(
      `SELECT COUNT(*) AS n FROM dbo.permissions WHERE code IN (${B11_PERMISSION_CODES.map((_, i) => `@p${i}`).join(', ')})`,
      { p0: B11_PERMISSION_CODES[0], p1: B11_PERMISSION_CODES[1] },
    );

    // El estado real de la cadena que exige la prueba: si esto no está, el
    // login del manager no puede obtener role.manage por la vía legítima.
    const chain = await contract.queryMany(
      `SELECT u.username, r.code AS role_code, p.code AS permission_code
       FROM dbo.users u
       JOIN dbo.roles r ON r.id = u.role_id
       JOIN dbo.role_permissions rp ON rp.role_id = r.id
       JOIN dbo.permissions p ON p.id = rp.permission_id
       WHERE u.username LIKE @prefix
       ORDER BY u.username, p.code`,
      { prefix },
    );

    console.log(`base=${who.db} identidad=${who.login} marcador=${marker || '(cualquiera)'}`);
    console.log(`B11_USERS_REMAINING=${Number(users.n)}`);
    console.log(`B11_ROLES_REMAINING=${Number(roles.n)}`);
    console.log(`B11_SESSIONS_REMAINING=${Number(sessions.n)}`);
    console.log(`B11_ROLE_PERMISSIONS_REMAINING=${Number(rolePermissions.n)}`);
    console.log(`B11_PERMISSIONS_REMAINING=${Number(permissions.n)}`);
    console.log(`B11_PERMISSION_CATALOGUE_PRESENT=${Number(permissions.n) > 0}`);
    if (chain.length) {
      console.log('cadena users -> roles -> role_permissions -> permissions:');
      for (const row of chain) console.log(`  ${row.username} -> ${row.role_code} -> ${row.permission_code}`);
    } else {
      console.log('cadena users -> roles -> role_permissions -> permissions: (vacia; fixtures no creados)');
    }
  } finally {
    await contract.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[b11] ERROR: ${error.message}`);
  process.exitCode = 1;
}