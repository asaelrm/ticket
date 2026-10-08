// Express 4 no captura promesas rechazadas: si un middleware o manejador es
// async y lanza (o rechaza), la petición se queda colgada y el error llega
// como unhandledRejection. Este módulo añade el envoltorio que Express 5
// haría por sí solo, sin cambiar ninguna ruta:
//
//   - asyncHandler(fn): envuelve un manejador concreto (los de 4 argumentos,
//     los manejadores de error, se devuelven tal cual porque Express los
//     identifica por su longitud).
//   - wrapAsyncRouter(router): recorre el stack de un router y envuelve todos
//     los manejadores y middlewares registrados en él (incluidos sub-routers),
//     de forma idempotente. Se aplica en los puntos de montaje de app.js.
//
// Si un middleware de nivel app (fuera de los routers) se llega a convertir en
// async, hay que envolverlo explícitamente con asyncHandler.

const WRAPPED = Symbol.for('tickets.asyncHandler.wrapped');

function isErrorHandler(fn) {
  return typeof fn === 'function' && fn.length === 4;
}

export function asyncHandler(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('asyncHandler necesita una función de middleware.');
  }
  if (handler[WRAPPED]) return handler;
  if (isErrorHandler(handler)) {
    throw new TypeError('Los manejadores de error (4 argumentos) no deben envolverse.');
  }
  const wrapped = (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped;
}

function wrapMaybe(handler) {
  if (typeof handler !== 'function' || isErrorHandler(handler) || handler[WRAPPED]) return handler;
  return asyncHandler(handler);
}

export function wrapAsyncRouter(router) {
  if (!router || !Array.isArray(router.stack)) {
    throw new TypeError('wrapAsyncRouter necesita un router de Express.');
  }
  if (router[WRAPPED]) return router;
  Object.defineProperty(router, WRAPPED, { value: true });
  for (const layer of router.stack) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack) {
        routeLayer.handle = wrapMaybe(routeLayer.handle);
      }
    } else if (typeof layer.handle === 'function' && Array.isArray(layer.handle.stack)) {
      wrapAsyncRouter(layer.handle);
    } else {
      layer.handle = wrapMaybe(layer.handle);
    }
  }
  return router;
}
