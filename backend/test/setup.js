// Se carga con `node --import` antes que cualquier prueba, una vez por cada
// archivo de test (node --test usa un proceso por archivo).
//
// SQL Server es el ÚNICO motor: la suite ya no crea una base SQLite temporal ni
// ejecuta migraciones/seed. Las pruebas de integración se ejecutan contra una
// base de SQL Server de PRUEBAS autorizada, indicada por variables de entorno
// (DB_* o sus alias MSSQL_TEST_*). Este archivo solo fija el entorno; NO abre
// conexión, NO migra y NO siembra.
//
// Si no hay base configurada, las pruebas que dependen de la base fallarán con
// un error de conexión: es el comportamiento esperado mientras no se disponga de
// un SQL Server de pruebas (documentado en el informe de la Fase 2).

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_CLIENT = 'mssql';
process.env.JOBS_ENABLED = 'false';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'ticket-pruebas';

// Alias: permite reutilizar la configuración de integración MSSQL_TEST_* como
// configuración de runtime DB_* para la suite.
const ALIASES = [
  ['DB_SERVER', 'MSSQL_TEST_SERVER'],
  ['DB_PORT', 'MSSQL_TEST_PORT'],
  ['DB_DATABASE', 'MSSQL_TEST_DATABASE'],
  ['DB_USER', 'MSSQL_TEST_USER'],
  ['DB_PASSWORD', 'MSSQL_TEST_PASSWORD'],
  ['DB_ENCRYPT', 'MSSQL_TEST_ENCRYPT'],
  ['DB_TRUST_SERVER_CERTIFICATE', 'MSSQL_TEST_TRUST_SERVER_CERTIFICATE'],
  ['DB_INSTANCE', 'MSSQL_TEST_INSTANCE'],
];
for (const [target, source] of ALIASES) {
  if (!process.env[target] && process.env[source]) process.env[target] = process.env[source];
}
