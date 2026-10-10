// Setup para pruebas MSSQL de integración contra base autorizada existente
// NO crea, borra ni altera bases de datos. Solo valida configuración y conexión.
//
// REQUISITOS DE SEGURIDAD:
// - La base DEBE ser exactamente SIFHA_Tickets_M5_Integration_Test
// - Credenciales vía variables de entorno MSSQL_TEST_*
// - Verificación estricta de DB_NAME() antes de cualquier escritura
// - No imprime secretos
// - No modifica esquemas ni ejecuta migraciones

import sql from 'mssql';

const REQUIRED_ENV = [
  'MSSQL_TEST_SERVER',
  'MSSQL_TEST_DATABASE',
  'MSSQL_TEST_USER',
  'MSSQL_TEST_PASSWORD',
];

// Base autorizada exclusivamente
const AUTHORIZED_DATABASE = 'SIFHA_Tickets_M5_Integration_Test';

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

// Validar que el servidor responde y que DB_NAME() coincide
async function validateTargetDatabase() {
  const pool = await sql.connect(config);
  try {
    const result = await pool.request().query('SELECT DB_NAME() AS current_db');
    const currentDb = result.recordset[0]?.current_db;
    if (currentDb !== AUTHORIZED_DATABASE) {
      throw new Error(
        `Conexión a base incorrecta: DB_NAME()="${currentDb}", ` +
        `se esperaba "${AUTHORIZED_DATABASE}". Abortando antes de cualquier escritura.`
      );
    }
    console.log(`[MSSQL Test Setup] Validado: conectado a "${currentDb}" en ${config.server}`);
  } finally {
    await pool.close();
  }
}

// Verificar que las 24 tablas del esquema M5 existen
async function validateSchema() {
  const pool = await sql.connect(config);
  try {
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
    console.log(`[MSSQL Test Setup] Esquema validado: ${tables.length} tablas presentes`);
  } finally {
    await pool.close();
  }
}

// Configurar variables de entorno para el runtime MSSQL
function configureRuntimeEnv() {
  process.env.DB_CLIENT = 'mssql';
  process.env.MSSQL_RUNTIME = 'true';
  process.env.DB_SERVER = config.server;
  process.env.DB_PORT = String(config.port);
  process.env.DB_DATABASE = AUTHORIZED_DATABASE;
  process.env.DB_USER = config.user;
  process.env.DB_PASSWORD = config.password;
  process.env.DB_ENCRYPT = String(config.options.encrypt);
  process.env.DB_TRUST_SERVER_CERTIFICATE = String(config.options.trustServerCertificate);
  if (config.options.instanceName) {
    process.env.DB_INSTANCE = config.options.instanceName;
  }
  // Variables de test (no credenciales de producción)
  process.env.NODE_ENV = 'test';
  process.env.JOBS_ENABLED = 'false';
}

// Setup principal: solo validación, sin escrituras destructivas
let setupDone = false;
export async function ensureMssqlTestSetup() {
  if (setupDone) return;
  
  console.log('[MSSQL Test Setup] Validando configuración de integración MSSQL...');
  console.log(`[MSSQL Test Setup] Servidor: ${config.server}`);
  console.log(`[MSSQL Test Setup] Base autorizada: ${AUTHORIZED_DATABASE}`);
  console.log(`[MSSQL Test Setup] Usuario: ${config.user}`);
  
  await validateTargetDatabase();
  await validateSchema();
  configureRuntimeEnv();
  
  setupDone = true;
  console.log('[MSSQL Test Setup] Validación completada - listo para pruebas');
}

export const mssqlTestConfig = config;