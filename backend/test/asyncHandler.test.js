import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../src/utils/asyncHandler.js';

// Tests unitarios del wrapper compartido. No usan supertest ni servidor: el
// helper se ejercita con dobles de `req`/`res`/`next` para poder comprobar
// cosas que una prueba de integración no ve, como que `next` recibe la MISMA
// referencia de Error y que se llama una sola vez.
//
// Todos los asserts son sincrónicos: el wrapper devuelve una promesa y cada
// test la espera, así que no hay ningún sleep ni temporizador.

/** Double de `next` que registra cada llamada. */
function recorder() {
  const calls = [];
  const next = (...args) => {
    calls.push(args);
  };
  next.calls = calls;
  return next;
}

/** Doble de `res` con lo único que los handlers tocan en estas pruebas. */
function fakeRes() {
  return { statusCode: 200, body: undefined, ended: false };
}

describe('asyncHandler', () => {
  it('un handler síncrono se ejecuta y no toca next', async () => {
    const req = { params: {} };
    const res = fakeRes();
    const next = recorder();
    let seen = null;

    const wrapped = asyncHandler((rq, rs) => {
      seen = { rq, rs };
      rs.body = 'ok';
    });

    const returned = wrapped(req, res, next);
    assert.ok(returned && typeof returned.then === 'function', 'debe devolver una promesa');
    await returned;

    assert.equal(seen.rq, req, 'req debe ser la misma referencia');
    assert.equal(seen.rs, res, 'res debe ser la misma referencia');
    assert.equal(res.body, 'ok');
    assert.equal(next.calls.length, 0, 'next no debe llamarse en el camino feliz');
  });

  it('un handler async se espera hasta completarse', async () => {
    const req = {};
    const res = fakeRes();
    const next = recorder();
    let finished = false;

    const wrapped = asyncHandler(async (rq, rs) => {
      await Promise.resolve();
      rs.body = 'tardío';
      finished = true;
    });

    await wrapped(req, res, next);

    assert.equal(finished, true, 'la promesa debe resolverse antes de volver');
    assert.equal(res.body, 'tardío');
    assert.equal(next.calls.length, 0);
  });

  it('un throw síncrono llega a next(error)', async () => {
    const boom = new Error('síncrono');
    const next = recorder();

    const wrapped = asyncHandler(() => {
      throw boom;
    });

    await wrapped({}, fakeRes(), next);

    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0].length, 1, 'next debe recibir solo el error');
    assert.equal(next.calls[0][0], boom);
  });

  it('una promesa rechazada llega a next(error)', async () => {
    const boom = new Error('asíncrono');
    const next = recorder();

    const wrapped = asyncHandler(async () => {
      await Promise.resolve();
      throw boom;
    });

    await wrapped({}, fakeRes(), next);

    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0][0], boom);
  });

  it('el rechazo conserva la referencia exacta del error, sin clonar', async () => {
    class ValidationError extends Error {
      constructor(fields) {
        super('Datos inválidos');
        this.name = 'ValidationError';
        this.status = 400;
        this.fields = fields;
      }
    }
    const original = new ValidationError({ name: 'obligatorio' });
    const next = recorder();

    const wrapped = asyncHandler(async () => {
      throw original;
    });

    await wrapped({}, fakeRes(), next);

    // Es el mismo objeto, no un equivalente: el errorHandler lee `.status` y
    // `.fields` de esta referencia.
    assert.equal(next.calls[0][0], original);
    assert.equal(next.calls[0][0].status, 400);
    assert.deepEqual(next.calls[0][0].fields, { name: 'obligatorio' });
  });

  it('next(error) se llama exactamente una vez', async () => {
    const next = recorder();

    const rejects = asyncHandler(async () => {
      throw new Error('rechazo');
    });
    await rejects({}, fakeRes(), next);

    const throws = asyncHandler(() => {
      throw new Error('throw');
    });
    await throws({}, fakeRes(), next);

    assert.equal(next.calls.length, 2, 'un fallo por handler, nunca más');
  });

  it('reenvía a next tal cual cuando el handler no recibe error', async () => {
    // Un handler async que llama a `next()` sin error (p. ej. `return next()`)
    // no debe fabricar ningún error ni interferir.
    const next = recorder();
    const wrapped = asyncHandler(async (_rq, _rs, nxt) => {
      nxt();
    });

    await wrapped({}, fakeRes(), next);

    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0].length, 0, 'next() sin argumentos');
  });

  it('pasa req, res y next al handler en ese orden y sin transformación', async () => {
    const req = { params: { id: '7' }, query: { active: '1' }, body: { name: 'x' } };
    const res = fakeRes();
    const next = recorder();
    let args = null;

    const wrapped = asyncHandler((...received) => {
      args = received;
    });

    await wrapped(req, res, next);

    assert.equal(args.length, 3, 'el handler recibe los tres argumentos');
    assert.equal(args[0], req);
    assert.equal(args[1], res);
    assert.equal(args[2], next, 'next se pasa como tercer argumento');
  });

  it('el camino feliz no altera el valor de retorno del handler', async () => {
    const next = recorder();
    const sentinel = { no: 'me toco' };
    const wrapped = asyncHandler(async () => sentinel);

    const returned = await wrapped({}, fakeRes(), next);

    assert.equal(returned, sentinel, 'el valor resolvedor llega intacto');
    assert.equal(next.calls.length, 0);
  });

  it('el camino de error no propaga el rechazo: lo consume next', async () => {
    const next = recorder();
    const wrapped = asyncHandler(async () => {
      throw new Error('x');
    });

    // Si el wrapper dejara escapar el rechazo, esto sería unhandledRejection.
    await assert.doesNotReject(() => wrapped({}, fakeRes(), next));
    assert.equal(next.calls.length, 1);
  });

  it('exporta la misma función como default y como nombrada', async () => {
    const mod = await import('../src/utils/asyncHandler.js');
    assert.equal(mod.default, mod.asyncHandler);
  });
});