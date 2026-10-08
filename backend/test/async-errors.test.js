import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { asyncHandler, wrapAsyncRouter } from '../src/middleware/asyncHandler.js';

function buildApp() {
  const app = express();
  const sub = express.Router();
  sub.get('/boom', async () => {
    throw new Error('boom sub');
  });

  const router = express.Router();
  router.get('/async-boom', async () => {
    throw new Error('boom async');
  });
  router.get('/async-reject', () => Promise.reject(new Error('rechazo async')));
  router.get('/async-ok', async (req, res) => res.json({ ok: true }));
  router.get('/sync-boom', () => {
    throw new Error('boom sync');
  });
  router.use('/sub', sub);
  router.use(
    async (req, res, next) => {
      if (req.url === '/mw-boom') throw new Error('middleware async');
      next();
    },
  );
  // Manejador de error de 4 argumentos DENTRO del router: wrapAsyncRouter no
  // debe envolverlo (Express lo reconoce por su longitud).
  router.use((err, req, res, next) => {
    res.status(599).json({ via: 'router-error-mw', message: err.message });
  });

  wrapAsyncRouter(router);
  app.use('/r', router);

  app.use((err, req, res, next) => {
    res.status(500).json({ via: 'app-error-mw', message: err.message });
  });
  return app;
}

describe('wrapAsyncRouter', () => {
  const app = buildApp();

  it('una promesa rechazada en un manejador async llega al manejador de error', async () => {
    const res = await request(app).get('/r/async-boom');
    assert.equal(res.status, 599);
    assert.deepEqual(res.body, { via: 'router-error-mw', message: 'boom async' });
  });

  it('una promesa rechazada con reject() también se captura', async () => {
    const res = await request(app).get('/r/async-reject');
    assert.equal(res.status, 599);
    assert.equal(res.body.message, 'rechazo async');
  });

  it('los manejadores async que responden siguen funcionando', async () => {
    const res = await request(app).get('/r/async-ok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('las excepciones síncronas siguen llegando al manejador de error', async () => {
    const res = await request(app).get('/r/sync-boom');
    assert.equal(res.status, 599);
    assert.equal(res.body.message, 'boom sync');
  });

  it('recorre también los sub-routers', async () => {
    const res = await request(app).get('/r/sub/boom');
    assert.equal(res.status, 599);
    assert.equal(res.body.message, 'boom sub');
  });

  it('envuelve los middlewares async registrados con router.use', async () => {
    const res = await request(app).get('/r/mw-boom');
    assert.equal(res.status, 599);
    assert.equal(res.body.message, 'middleware async');
  });

  it('no envuelve los manejadores de error de 4 argumentos', async () => {
    // Si wrapAsyncRouter lo hubiera envuelto (longitud 3), Express lo ignoraría
    // en el flujo de errores y la respuesta saldría del manejador de app.
    const res = await request(app).get('/r/async-boom');
    assert.equal(res.body.via, 'router-error-mw');
  });

  it('es idempotente: dos envolvimientos no encadenan envoltorios', async () => {
    const router = express.Router();
    router.get('/x', async () => {
      throw new Error('una vez');
    });
    const antes = router.stack[0].route.stack[0].handle;
    wrapAsyncRouter(router);
    const despues = router.stack[0].route.stack[0].handle;
    wrapAsyncRouter(router);
    assert.equal(router.stack[0].route.stack[0].handle, despues);
    assert.notEqual(despues, antes);
    const app2 = express();
    app2.use('/x', router);
    app2.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    const res = await request(app2).get('/x/x');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'una vez');
  });

  it('valida su argumento', () => {
    assert.throws(() => wrapAsyncRouter({}), /necesita un router/);
    assert.throws(() => wrapAsyncRouter(null), /necesita un router/);
  });
});

describe('asyncHandler', () => {
  it('envía la promesa rechazada a next', async () => {
    let captured;
    const wrapped = asyncHandler(async () => {
      throw new Error('fallo async');
    });
    wrapped({}, {}, (error) => {
      captured = error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(captured?.message, 'fallo async');
  });

  it('captura también las excepciones síncronas', () => {
    let captured;
    const wrapped = asyncHandler(() => {
      throw new Error('fallo sync');
    });
    wrapped({}, {}, (error) => {
      captured = error;
    });
    assert.equal(captured?.message, 'fallo sync');
  });

  it('es idempotente y no toca los manejadores de error', () => {
    const base = async () => {};
    const wrapped = asyncHandler(base);
    assert.equal(asyncHandler(wrapped), wrapped);
    const errorHandlerLike = (err, req, res, next) => next(err);
    assert.throws(() => asyncHandler(errorHandlerLike), /4 argumentos/);
  });

  it('valida su argumento', () => {
    assert.throws(() => asyncHandler(null), /necesita una función/);
  });
});
