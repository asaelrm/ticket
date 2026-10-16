import { startServer } from './startup.js';

// SQL Server es el único motor de base de datos. El arranque valida el esquema
// (solo lectura) y, si la validación falla, NO se llega a abrir el puerto HTTP.
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
