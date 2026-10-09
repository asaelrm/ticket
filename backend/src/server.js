import config from './config.js';
import { startServer } from './startup.js';

// Deja constancia cuando se pidió SQL Server pero el runtime no está activado:
// sin este aviso, un `DB_CLIENT=mssql` sin `MSSQL_RUNTIME=true` parecería estar
// ejecutándose sobre SQL Server cuando en realidad usa SQLite.
if (config.requestedDbClient === 'mssql' && config.dbClient !== 'mssql') {
  console.warn(
    '[db] DB_CLIENT=mssql solicitado, pero el runtime MSSQL no está activado ' +
      '(defina MSSQL_RUNTIME=true para habilitarlo). Este proceso usa SQLite.',
  );
}

// startServer decide el camino por motor: SQLite migra, siembra y restaura la
// instantánea del directorio; MSSQL solo valida el esquema (sin migrar, sin
// sembrar, sin restaurar y sin tocar db.js). Si la validación MSSQL falla, no se
// llega a abrir el puerto HTTP.
//
// El fallo se captura para dejar un mensaje claro y salir con código distinto de
// cero: credenciales incorrectas o un esquema incompatible NO deben arrancar un
// servidor a medias.
try {
  await startServer();
} catch (error) {
  console.error(
    '[ticket] No se pudo iniciar el servidor:',
    error && error.message ? error.message : error,
  );
  process.exitCode = 1;
}
