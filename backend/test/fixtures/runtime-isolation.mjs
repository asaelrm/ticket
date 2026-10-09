// Fixture de aislamiento del motor.
//
// Se ejecuta como proceso hijo (`node runtime-isolation.mjs`) con DB_CLIENT y
// MSSQL_RUNTIME ya fijados en el entorno. NO ejecuta ninguna consulta: en modo
// MSSQL una consulta abriría una conexión de SQL Server, y lo que se quiere
// comprobar es justamente que importar la fachada no abre SQLite. Solo importa
// el runtime, construye la fachada con currentEngine() (perezosa, sin SQL) y
// reporta el motor efectivo junto con la ruta del archivo SQLite configurado.
import config from '../../src/config.js';
const { default: runtime, currentEngine } = await import('../../src/db/runtime.js');

const engine = currentEngine();
// close() nunca abre el pool: si no hubo consultas es un no-op en ambos motores.
await runtime.close();

console.log(JSON.stringify({ engine, dbFile: config.dbFile }));
