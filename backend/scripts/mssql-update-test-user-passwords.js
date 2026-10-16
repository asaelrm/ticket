// Script independiente para actualizar ÚNICAMENTE los hashes bcrypt de los tres usuarios de integración
// admin, empleado, tecnico en SIFHA_Tickets_M5_Integration_Test
// NO modifica roles, permisos, departamentos ni otros usuarios.
// Requiere variables de entorno: MSSQL_TEST_ADMIN_PASS, MSSQL_TEST_EMPLEADO_PASS, MSSQL_TEST_TECNICO_PASS
// Validación estricta: DB_NAME() debe ser SIFHA_Tickets_M5_Integration_Test antes de cualquier escritura.

import sql from 'mssql';
import bcrypt from 'bcryptjs';

const AUTHORIZED_DATABASE = 'SIFHA_Tickets_M5_Integration_Test';

const REQUIRED_ENV = [
  'MSSQL_TEST_SERVER',
  'MSSQL_TEST_DATABASE',
  'MSSQL_TEST_USER',
  'MSSQL_TEST_PASSWORD',
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
  },
};

const USERS_TO_UPDATE = [
  { username: process.env.MSSQL_TEST_ADMIN_USER || 'admin', passwordEnv: 'MSSQL_TEST_ADMIN_PASS' },
  { username: process.env.MSSQL_TEST_EMPLEADO_USER || 'empleado', passwordEnv: 'MSSQL_TEST_EMPLEADO_PASS' },
  { username: process.env.MSSQL_TEST_TECNICO_USER || 'tecnico', passwordEnv: 'MSSQL_TEST_TECNICO_PASS' },
];

const uniqueUsernames = new Set(USERS_TO_UPDATE.map(u => u.username));
if (uniqueUsernames.size !== USERS_TO_UPDATE.length) {
  throw new Error('Los usuarios admin, empleado y tecnico deben ser tres usuarios distintos');
}

async function validateTargetDatabase(transaction) {
  const result = await transaction.request().query('SELECT DB_NAME() AS current_db');
  const currentDb = result.recordset[0]?.current_db;
  if (currentDb !== AUTHORIZED_DATABASE) {
    throw new Error(
      `Conexión a base incorrecta: DB_NAME()="${currentDb}", ` +
      `se esperaba "${AUTHORIZED_DATABASE}". Abortando antes de cualquier escritura.`
    );
  }
  console.log(`[MSSQL Update Passwords] Validado: conectado a "${currentDb}" en ${config.server}`);
}

async function main() {
  console.log('[MSSQL Update Passwords] Iniciando actualización de contraseñas de usuarios de prueba...');
  console.log(`[MSSQL Update Passwords] Base de datos objetivo: ${AUTHORIZED_DATABASE}`);
  console.log(`[MSSQL Update Passwords] Servidor: ${config.server}`);

  const pool = await sql.connect(config);
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    await validateTargetDatabase(transaction);

    console.log('[MSSQL Update Passwords] Procesando usuarios...');

    for (const user of USERS_TO_UPDATE) {
      const password = process.env[user.passwordEnv];

      if (!password) {
        throw new Error(`Contraseña no definida en variable de entorno: ${user.passwordEnv}`);
      }

      if (password.length < 12) {
        throw new Error(`La contraseña para ${user.username} debe tener al menos 12 caracteres (política de seguridad)`);
      }

      const passwordHash = bcrypt.hashSync(password, 12);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 23);

      const result = await transaction.request()
        .input('username', sql.NVarChar(150), user.username)
        .input('password_hash', sql.NVarChar(500), passwordHash)
        .input('last_password_change_at', sql.DateTime2(3), now)
        .query(`
          UPDATE dbo.users
          SET password_hash = @password_hash, last_password_change_at = @last_password_change_at
          WHERE username = @username
        `);

      if (result.rowsAffected[0] !== 1) {
        throw new Error(`Usuario "${user.username}": se esperaba afectar exactamente 1 fila, se afectaron ${result.rowsAffected[0]}`);
      }

      console.log(`[MSSQL Update Passwords] Usuario "${user.username}" actualizado (filas afectadas: ${result.rowsAffected[0]})`);
    }

    await transaction.commit();

    console.log('\n[MSSQL Update Passwords] Actualización completada exitosamente.');
    console.log('[MSSQL Update Passwords] Resumen:');
    for (const user of USERS_TO_UPDATE) {
      console.log(`  - ${user.username}: ACTUALIZADO`);
    }

  } catch (err) {
    try {
      await transaction.rollback();
      console.log('[MSSQL Update Passwords] Transacción revertida (rollback).');
    } catch {
      // Ignorar error de rollback
    }
    throw err;
  } finally {
    await pool.close();
  }
}

main().catch(err => {
  console.error('[MSSQL Update Passwords] ERROR:', err.message);
  process.exit(1);
});