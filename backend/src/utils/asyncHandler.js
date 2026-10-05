//
// Wrapper único para handlers async de Express 4.
//
// Express 4.22 no reenvía los rechazos de promesa de un handler al middleware
// `errorHandler`: si una ruta `async` lanza (un `validate()`, una consulta que
// falla), la petición se queda colgada para siempre en lugar de devolver 4xx o
// 500. `asyncHandler` cierra ese hueco.
//
// Antes de existir este archivo la misma línea estaba copiada en
// `routes/tickets.js`, `routes/categories.js` y `routes/kbCategories.js`. Las
// tres copias eran idénticas; esta es la única implementación.
//
// Uso:
//
//   router.get('/algo', requirePermission('x'), asyncHandler(async (req, res) => {
//     const row = await contract.queryOne('SELECT * FROM t WHERE id = :id', { id: req.params.id });
//     res.json(row);
//   }));
//

/**
 * Envuelve un handler de Express para que sus errores lleguen a `next(error)`.
 *
 * Garantías:
 * - `req`, `res` y `next` se pasan al handler sin transformar (mismas
 *   referencias, incluido `next` como tercer argumento).
 * - Un `throw` síncrono y una promesa rechazada terminan ambos en `next(error)`.
 *   El `try/catch` no es redundante: Express 4 ya captura los throws síncronos
 *   por su cuenta, pero fijarlo aquí hace que el contrato no dependa de un
 *   detalle de la versión de Express.
 * - `next(error)` se invoca una sola vez por fallo, con la referencia exacta
 *   del error que lanzó el handler (no se clona ni se reescribe).
 * - No altera el valor de retorno en el camino feliz: se devuelve la promesa
 *   del handler, que Express ignora igual que antes.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => any} fn
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => any}
 */
export function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    try {
      return Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      // Solo se llega aquí si `fn` lanza de forma síncrona, antes de devolver
      // una promesa. Se propaga igual que cualquier otro error.
      return next(err);
    }
  };
}

export default asyncHandler;