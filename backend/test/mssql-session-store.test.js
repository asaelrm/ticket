import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MssqlSessionStore, { destroyUserSessionsMssql } from '../src/utils/mssqlSessionStore.js';

/**
 * Contrato mínimo que reproduce la semántica de dbo.sessions en memoria.
 * Cualquier sentencia que el store no emita en las formas conocidas falla en
 * lugar de simular un borrado global: un DELETE global futuro rompe el test.
 */
function memorySessionContract() {
  const rows = new Map();
  const calls = [];

  function unknown(statement) {
    throw new Error(`Sentencia no permitida en el store de sesiones: ${statement}`);
  }

  return {
    rows,
    calls,
    async queryOne(statement, params = {}) {
      calls.push({ kind: 'queryOne', statement, params });
      if (/^SELECT sess FROM dbo\.sessions WHERE sid = @sid AND expire > @now$/i.test(statement)) {
        const row = rows.get(params.sid);
        if (!row || !(Number(row.expire) > Number(params.now))) return null;
        return { sess: row.sess };
      }
      if (/^SELECT COUNT\(\*\) AS n FROM dbo\.sessions$/i.test(statement)) {
        return { n: rows.size };
      }
      return unknown(statement);
    },
    async execute(statement, params = {}) {
      calls.push({ kind: 'execute', statement, params });
      if (/^UPDATE dbo\.sessions SET sess = @sess, expire = @expire WHERE sid = @sid;/i.test(statement)) {
        const row = rows.get(params.sid);
        if (row) {
          row.sess = params.sess;
          row.expire = Number(params.expire);
        } else {
          rows.set(params.sid, { sess: params.sess, expire: Number(params.expire) });
        }
        return { rowsAffected: 1 };
      }
      if (/^UPDATE dbo\.sessions SET expire = @expire WHERE sid = @sid$/i.test(statement)) {
        const row = rows.get(params.sid);
        if (!row) return { rowsAffected: 0 };
        row.expire = Number(params.expire);
        return { rowsAffected: 1 };
      }
      if (/^DELETE FROM dbo\.sessions WHERE sid = @sid$/i.test(statement)) {
        return { rowsAffected: rows.delete(params.sid) ? 1 : 0 };
      }
      if (/DELETE FROM dbo\.sessions WHERE JSON_VALUE\(sess, '\$\.userId'\) = @userId/i.test(statement)) {
        let removed = 0;
        for (const [sid, row] of [...rows]) {
          const owner = JSON.parse(row.sess)?.userId;
          if (owner !== undefined && owner !== null && String(owner) === String(params.userId)) {
            rows.delete(sid);
            removed += 1;
          }
        }
        return { rowsAffected: removed };
      }
      return unknown(statement);
    },
  };
}

function callbackResult(invoke) {
  return new Promise((resolve, reject) => invoke((error, value) => (error ? reject(error) : resolve(value))));
}

function storeOver(contract) {
  return new MssqlSessionStore({ contract });
}

const SID_A = 'b10-session-A';
const SID_B = 'b10-session-B';
const USER_A = 'b10-user-A';
const USER_B = 'b10-user-B';
const HOUR = 60 * 60 * 1000;

const EXPIRES_A = new Date(Date.now() + HOUR).toISOString();
const EXPIRES_B = new Date(Date.now() + 3 * HOUR).toISOString();
const SESSION_A = { userId: USER_A, cookie: { expires: EXPIRES_A }, note: 'A' };
const SESSION_B = { userId: USER_B, cookie: { expires: EXPIRES_B }, note: 'B' };
const SESSION_A_EXPIRED = { ...SESSION_A, cookie: { expires: new Date(0).toISOString() } };

function rawRow(memory, sid) {
  return { sess: memory.rows.get(sid).sess, expire: memory.rows.get(sid).expire };
}

describe('MssqlSessionStore · aislamiento por SID', () => {
  it('set(A) no afecta B', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const before = rawRow(memory, SID_B);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    assert.deepEqual(rawRow(memory, SID_B), before);
    assert.deepEqual(await callbackResult((done) => store.get(SID_B, done)), SESSION_B);
  });

  it('set() no ejecuta ningún DELETE', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    assert.equal(memory.calls.length, 1, 'set() debe emitir exactamente una sentencia');
    assert.doesNotMatch(memory.calls[0].statement, /DELETE/i);
    assert.equal(memory.rows.size, 1);
  });

  it('get() de una sesión expirada devuelve null sin borrar filas', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    const expired = SESSION_A_EXPIRED;
    await callbackResult((done) => store.set(SID_A, expired, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const size = memory.rows.size;
    assert.equal(await callbackResult((done) => store.get(SID_A, done)), null);
    assert.equal(memory.rows.size, size, 'get() no debe eliminar filas');
    assert.deepEqual(await callbackResult((done) => store.get(SID_B, done)), SESSION_B);
  });

  it('get(A) no afecta B', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const snapshot = new Map([...memory.rows].map(([sid]) => [sid, rawRow(memory, sid)]));
    assert.deepEqual(await callbackResult((done) => store.get(SID_A, done)), SESSION_A);
    assert.deepEqual(new Map([...memory.rows].map(([sid]) => [sid, rawRow(memory, sid)])), snapshot);
  });

  it('touch(A) no afecta B', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const before = rawRow(memory, SID_B);
    const touchedExpiry = new Date(Date.now() + 5 * HOUR).toISOString();
    await callbackResult((done) => store.touch(SID_A, { cookie: { expires: touchedExpiry } }, done));
    assert.deepEqual(rawRow(memory, SID_B), before);
    assert.equal(memory.rows.get(SID_A).expire, new Date(touchedExpiry).getTime());
  });

  it('destroy(A) no afecta B', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    await callbackResult((done) => store.destroy(SID_A, done));
    assert.equal(memory.rows.has(SID_A), false);
    assert.deepEqual(await callbackResult((done) => store.get(SID_B, done)), SESSION_B);
  });

  it('length() es una lectura global que no muta nada', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const snapshot = new Map([...memory.rows].map(([sid]) => [sid, rawRow(memory, sid)]));
    assert.equal(await callbackResult((done) => store.length(done)), 2);
    assert.deepEqual(new Map([...memory.rows].map(([sid]) => [sid, rawRow(memory, sid)])), snapshot);
  });

  it('destroyUserSessionsMssql(userA) no afecta userB', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    await destroyUserSessionsMssql(USER_A, memory);
    assert.equal(memory.rows.has(SID_A), false);
    assert.deepEqual(await callbackResult((done) => store.get(SID_B, done)), SESSION_B);
  });
});

describe('MssqlSessionStore · Unicode, JSON e inyección', () => {
  it('preserva Unicode, comillas y JSON anidado', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    const payload = {
      userId: USER_A,
      cookie: { expires: new Date(Date.now() + HOUR).toISOString(), originalMaxAge: HOUR },
      nota: "O'Reilly \"comillas\" áéíóú 你好 \u{1F600} -- DROP TABLE sessions",
      lista: [{ n: 1 }, { n: 2 }],
      anidado: { a: { b: { c: null } } },
    };
    await callbackResult((done) => store.set(SID_A, payload, done));
    assert.equal(memory.rows.get(SID_A).sess, JSON.stringify(payload));
    assert.deepEqual(await callbackResult((done) => store.get(SID_A, done)), JSON.parse(JSON.stringify(payload)));
  });

  it('trata un SID malicioso como parámetro en get/set/touch/destroy', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    const evilSid = "b10'; DROP TABLE dbo.sessions; --";
    await callbackResult((done) => store.set(evilSid, SESSION_A, done));
    assert.deepEqual(await callbackResult((done) => store.get(evilSid, done)), SESSION_A);
    await callbackResult((done) => store.touch(evilSid, { cookie: { expires: new Date(Date.now() + 9 * HOUR).toISOString() } }, done));
    await callbackResult((done) => store.destroy(evilSid, done));
    assert.equal(memory.rows.has(evilSid), false);
    for (const call of memory.calls) {
      assert.doesNotMatch(call.statement, /DROP TABLE/i, 'El SID jamás se concatena en el SQL');
      if (call.params.sid !== undefined) assert.equal(call.params.sid, evilSid);
    }
  });

  it('trata un userId malicioso como parámetro en destroyUserSessionsMssql', async () => {
    const memory = memorySessionContract();
    const store = storeOver(memory);
    await callbackResult((done) => store.set(SID_A, SESSION_A, done));
    await callbackResult((done) => store.set(SID_B, SESSION_B, done));
    const evilUserId = "b10-user' OR '1'='1";
    await destroyUserSessionsMssql(evilUserId, memory);
    assert.equal(memory.rows.size, 2, 'Un userId malicioso no puede borrar sesiones ajenas');
    const last = memory.calls.at(-1);
    assert.equal(last.params.userId, String(evilUserId));
    assert.doesNotMatch(last.statement, /OR '1'/i);
  });
});

describe('MssqlSessionStore · callbacks y errores', () => {
  function failingContract({ row = null, error = null } = {}) {
    const calls = [];
    return {
      calls,
      async queryOne(statement, params) {
        calls.push({ kind: 'queryOne', statement, params });
        if (error) throw error;
        return row;
      },
      async execute(statement, params) {
        calls.push({ kind: 'execute', statement, params });
        if (error) throw error;
        return { rowsAffected: 1 };
      },
    };
  }

  it('get inexistente devuelve null usando el SID como parámetro', async () => {
    const fake = failingContract();
    const store = storeOver(fake);
    assert.equal(await callbackResult((done) => store.get('missing', done)), null);
    assert.match(fake.calls[0].statement, /sid = @sid/);
    assert.equal(fake.calls[0].params.sid, 'missing');
  });

  it('set actualiza o inserta usando solo el SID recibido', async () => {
    const fake = failingContract();
    const store = storeOver(fake);
    await callbackResult((done) => store.set('safe-sid', { userId: 7, cookie: {} }, done));
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].statement, /UPDATE dbo\.sessions/);
    assert.match(fake.calls[0].statement, /INSERT INTO dbo\.sessions/);
    assert.equal(fake.calls[0].params.sid, 'safe-sid');
    assert.equal(fake.calls[0].params.sess, JSON.stringify({ userId: 7, cookie: {} }));
    assert.ok(Number.isFinite(fake.calls[0].params.expire));
  });

  it('set respeta expires de la cookie y aplica un valor por defecto razonable', async () => {
    const fake = failingContract();
    const store = storeOver(fake);
    const expires = new Date(Date.now() + HOUR).toISOString();
    await callbackResult((done) => store.set('sid-exp', { cookie: { expires } }, done));
    assert.equal(fake.calls.at(-1).params.expire, new Date(expires).getTime());
    const before = Date.now();
    await callbackResult((done) => store.set('sid-no-exp', { cookie: {} }, done));
    const fallback = fake.calls.at(-1).params.expire;
    assert.ok(fallback >= before + 23 * HOUR, 'El fallback debe estar cerca de 24h');
    assert.ok(fallback <= Date.now() + 24 * HOUR + 1000, 'El fallback no debe superar 24h');
  });

  it('touch, destroy y length usan parámetros y reportan filas', async () => {
    const fake = failingContract({ row: { n: 3 } });
    const store = storeOver(fake);
    await callbackResult((done) => store.touch('sid-1', { cookie: {} }, done));
    await callbackResult((done) => store.destroy('sid-1', done));
    assert.equal(await callbackResult((done) => store.length(done)), 3);
    await destroyUserSessionsMssql(42, fake);
    assert.match(fake.calls.at(-1).statement, /JSON_VALUE\(sess, '\$\.userId'\) = @userId/);
    assert.equal(fake.calls.at(-1).params.userId, '42');
  });

  it('propaga errores SQL y de serialización mediante callbacks', async () => {
    const sqlError = new Error('SQL falló');
    const failing = storeOver(failingContract({ error: sqlError }));
    await assert.rejects(callbackResult((done) => failing.destroy('sid', done)), sqlError);
    await assert.rejects(callbackResult((done) => failing.set('sid', { cookie: {} }, done)), sqlError);

    const invalid = storeOver(failingContract({ row: { sess: '{' } }));
    await assert.rejects(callbackResult((done) => invalid.get('sid', done)), /deserialization/);

    const circular = { cookie: {} };
    circular.self = circular;
    await assert.rejects(callbackResult((done) => storeOver(failingContract()).set('sid', circular, done)), /circular/i);
  });
});

describe('MssqlSessionStore · regresión de limpieza global', () => {
  const source = readFileSync(new URL('../src/utils/mssqlSessionStore.js', import.meta.url), 'utf8');

  function methodBody(name) {
    const start = source.indexOf(`\n  ${name}(`);
    assert.notEqual(start, -1, `No se encontró el método ${name} en el store`);
    const end = source.indexOf('\n  }', start);
    assert.notEqual(end, -1, `No se pudo delimitar el método ${name}`);
    return source.slice(start, end);
  }

  it('set() no contiene ninguna sentencia DELETE', () => {
    assert.doesNotMatch(
      methodBody('set'),
      /DELETE/i,
      'set() no debe ejecutar ningún DELETE, ni global ni por SID',
    );
  });

  it('get(), touch() y length() no contienen ninguna sentencia DELETE', () => {
    for (const name of ['get', 'touch', 'length']) {
      assert.doesNotMatch(methodBody(name), /DELETE/i, `${name}() no debe ejecutar ningún DELETE`);
    }
  });

  it('los únicos DELETE del store están acotados por @sid o @userId', () => {
    const statements = source.match(/DELETE FROM dbo\.sessions[^\n]*/gi) ?? [];
    assert.equal(statements.length, 2, 'Solo destroy() y destroyUserSessionsMssql() borran sesiones');
    for (const statement of statements) {
      assert.match(statement, /WHERE[\s\S]*(@sid\b|@userId\b)/i, `DELETE sin acotar por parámetro: ${statement}`);
      assert.doesNotMatch(statement, /expire/i, `No se permite borrar sesiones por expire: ${statement}`);
    }
  });

  it('destroy() solo borra el SID recibido', () => {
    assert.match(methodBody('destroy'), /DELETE FROM dbo\.sessions WHERE sid = @sid/);
  });
});