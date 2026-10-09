// Fixture de aislamiento del directorio.
//
// Se ejecuta como proceso hijo con DB_CLIENT y MSSQL_RUNTIME ya fijados en el
// entorno. Importa `src/directorySync.js` (que antes arrastraba `src/seed.js` y,
// con él, la conexión SQLite) y reporta la ruta del archivo SQLite configurado.
// No ejecuta ninguna consulta, así que en modo MSSQL nunca se abre una conexión
// de SQL Server.
import config from '../../src/config.js';
await import('../../src/directorySync.js');

console.log(JSON.stringify({ dbFile: config.dbFile }));
