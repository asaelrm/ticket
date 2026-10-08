import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, currentEngine } from '../src/db/runtime.js';

// -----------------------------------------------------------------------
// drivers falsos

function fakeSqliteConnection(tag, log, { get, all, run } = {}) {
  return {
    prepare(sql) {
      log.push({ tag, sql });
      return {
        get: (...params) => {
          log.push({ tag, method: 'get', params });
          return get ? get(sql, params) : null;
        },
        all: (...params) => {
          log.push({ tag, method: 'all', params });
          return all ? all(sql, params) : [];
        },
        run: (...params) => {
          log.push({ tag, method: 'run', params });
          return run ? run(sql, params) : { changes: 1, lastInsertRowid: 1 };
        },
      };
    },
  };
}

function fakeMssqlContract() {
  const shared = { queryOne: [], queryMany: [], execute: [], insertAndGetId: [], transactions: [] };
  const inTx = { queryOne: [], queryMany: [], execute: [], insertAndGetId: [] };
  const txContract = {
    queryOne: async (...args) => {
      inTx.queryOne.push(args);
      return { via: 'tx' };
    },
    queryMany: async (...args) => {
      inTx.queryMany.push(args);
      return [{ via: 'tx' }];
    },
    execute: async (...args) => {
      inTx.execute.push(args);
      return { rowsAffected: 2 };
    },
    insertAndGetId: async (...args) => {
      inTx.insertAndGetId.push(args);
      return { id: 7, rowsAffected: 1 };
    },
  };
  const contract = {
    queryOne: async (...args) => {
      shared.queryOne.push(args);
      return { ok: 1 };
    },
    queryMany: async (...args) => {
      shared.queryMany.push(args);
      return [];
    },
    execute: async (...args) => {
      shared.execute.push(args);
      return { rowsAffected: 5 };
    },
    insertAndGetId: async (...args) => {
      shared.insertAndGetId.push(args);
      return { id: 9, rowsAffected: 1 };
    },
    transactionAsync: async (callback) => {
      shared.transactions.push('begin');
      const value = await callback(txContract);
      shared.transactions.push('commit');
      return value;
    },
    close: async () => {
      shared.transactions.push('close');
    },
  };
  return { contract, shared, inTx };
}

function sqliteRuntime(options = {}) {
  const log = [];
  const connection = fakeSqliteConnection('main', log, options);
  const txLog = [];
  const txConnection = fakeSqliteConnection('tx', txLog, options);
  const runtime = createRuntime({
    engine: 'sqlite',
    connection,
    openConnection: () => txConnection,
  });
  return { runtime, log, txLog, txConnection };
}

// -----------------------------------------------------------------------
// motor sqlite

describe('runtime: motor sqlite', () => {
  it('consulta posicional y normaliza filas', async () => {
    const { runtime, log } = sqliteRuntime({
      get: () => ({ active: true, big: 9n, n: 1, name: 'ana' }),
    });
    const row = await runtime.queryOne('SELECT active FROM users WHERE id = ?', 5);
    assert.deepEqual(row, { active: 1, big: 9, n: 1, name: 'ana' });
    assert.deepEqual(log.at(-1), { tag: 'main', method: 'get', params: [5] });
  });

  it('queryMany, execute e insertAndGetId devuelven la forma combinada', async () => {
    const { runtime } = sqliteRuntime({
      all: () => [{ ok: true }, { ok: false }],
      run: () => ({ changes: 3, lastInsertRowid: 44 }),
    });
    assert.deepEqual(await runtime.queryMany('SELECT 1'), [{ ok: 1 }, { ok: 0 }]);
    assert.deepEqual(await runtime.execute('UPDATE users SET name = ?', 'ana'), { rowsAffected: 3 });
    assert.deepEqual(await runtime.insertAndGetId('INSERT INTO users (name) VALUES (?)', 'ana'), {
      id: 44,
      rowsAffected: 3,
    });
  });

  it('normaliza parámetros: fecha a ISO, booleano a 0/1 y rechaza undefined', async () => {
    const { runtime, log } = sqliteRuntime();
    await runtime.queryOne('SELECT ? AS at', new Date('2026-01-02T03:04:05.678Z'));
    assert.deepEqual(log.at(-1).params, ['2026-01-02T03:04:05.678Z']);
    await runtime.queryMany('SELECT ? AS flag', true);
    assert.deepEqual(log.at(-1).params, [1]);
    await assert.rejects(runtime.execute('UPDATE users SET name = ?', undefined), /undefined/);
    await assert.rejects(
      runtime.execute('UPDATE users SET name = ?'),
      /tiene 1 parámetro\(s\).*pero se enviaron 0/,
    );
    await assert.rejects(runtime.queryOne('SELECT ?', { a: 1 }), /posicionales/);
  });

  it('transaction usa una conexión aparte con BEGIN IMMEDIATE/COMMIT y la cierra', async () => {
    const txConnection = { execLog: [], closed: false, ops: [] };
    const runtime2 = createRuntime({
      engine: 'sqlite',
      connection: fakeSqliteConnection('main', []),
      openConnection: () => ({
        exec: (sql) => txConnection.execLog.push(sql),
        close: () => {
          txConnection.closed = true;
        },
        prepare: (sql) => ({
          get: (...params) => {
            txConnection.ops.push({ sql, params });
            return { origen: 'tx' };
          },
          all: () => [],
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
        }),
      }),
    });
    const value = await runtime2.transaction(async (tx) => {
      const inner = await tx.queryOne('SELECT origen FROM cosas WHERE id = ?', 3);
      // También la fachada del runtime, dentro del callback, debe ir a la
      // conexión de la transacción.
      const viaRuntime = await runtime2.queryOne('SELECT 1');
      return { inner, viaRuntime };
    });
    assert.deepEqual(value.inner, { origen: 'tx' });
    assert.deepEqual(value.viaRuntime, { origen: 'tx' });
    assert.deepEqual(txConnection.execLog, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(txConnection.closed, true);
    assert.deepEqual(txConnection.ops[0].params, [3]);

    await assert.rejects(
      runtime2.transaction(async () => {
        throw new Error('falla dentro');
      }),
      /falla dentro/,
    );
    assert.deepEqual(txConnection.execLog, ['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'ROLLBACK']);
    await assert.rejects(runtime2.transaction(() => runtime2.transaction(async () => {})), /anidadas/);
    assert.deepEqual(
      txConnection.execLog,
      ['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'ROLLBACK', 'BEGIN IMMEDIATE', 'ROLLBACK'],
      'la transacción anidada se rechaza antes de abrir conexión y la externa hace rollback',
    );
    assert.equal(txConnection.closed, true, 'cada transacción cierra su conexión');
  });

  it('expone el identificador del motor', () => {
    const { runtime } = sqliteRuntime();
    assert.equal(runtime.engine, 'sqlite');
  });
});

// -----------------------------------------------------------------------
// motor mssql (contrato falso)

describe('runtime: motor mssql', () => {
  it('traduce la sentencia y ata los parámetros posicionales como @pN', async () => {
    const { contract, shared } = fakeMssqlContract();
    const runtime = createRuntime({ engine: 'mssql', contract });
    const row = await runtime.queryOne('SELECT id FROM users WHERE id = ? AND active = 1', 5);
    assert.deepEqual(row, { ok: 1 });
    const [text, params] = shared.queryOne[0];
    assert.match(text, /@p0/);
    assert.ok(!text.includes('?'), 'la sentencia traducida no debe conservar marcadores ?');
    assert.deepEqual(params, { p0: 5 });
  });

  it('normaliza fechas sin sufijo Z, booleanos y rechaza undefined antes de tocar el pool', async () => {
    const { contract, shared } = fakeMssqlContract();
    const runtime = createRuntime({ engine: 'mssql', contract });
    await runtime.queryOne('SELECT ? AS at', new Date('2026-01-02T03:04:05.678Z'));
    assert.equal(shared.queryOne.at(-1)[1].p0, '2026-01-02T03:04:05.678');
    await runtime.queryOne('SELECT ? AS at', '2026-01-02T03:04:05.678Z');
    assert.equal(shared.queryOne.at(-1)[1].p0, '2026-01-02T03:04:05.678');
    await runtime.queryOne('SELECT ? AS text', 'un texto Z');
    assert.equal(shared.queryOne.at(-1)[1].p0, 'un texto Z');
    await runtime.queryMany('SELECT ? AS flag', false);
    assert.deepEqual(shared.queryMany.at(-1)[1], { p0: 0 });
    const antes = shared.queryOne.length;
    await assert.rejects(runtime.queryOne('SELECT ?', undefined), /undefined/);
    await assert.rejects(runtime.queryOne('SELECT ?, ?', 1), /pero se enviaron 1/);
    await assert.rejects(runtime.queryOne('SELECT ?', { a: 1 }), /posicionales/);
    assert.equal(shared.queryOne.length, antes, 'ninguna llamada debe llegar al contrato');
  });

  it('normaliza filas devueltas: BIT booleano a 0/1', async () => {
    const { contract, shared } = fakeMssqlContract();
    contract.queryMany = async () => [{ active: true, id: 1 }];
    contract.queryOne = async () => null;
    const runtime = createRuntime({ engine: 'mssql', contract });
    assert.deepEqual(await runtime.queryMany('SELECT active FROM users'), [{ active: 1, id: 1 }]);
    assert.equal(await runtime.queryOne('SELECT 1 WHERE 0'), null);
    assert.equal(shared.queryOne.length, 0);
  });

  it('execute e insertAndGetId pasan el resultado del contrato e insertId traduce a SCOPE_IDENTITY', async () => {
    const { contract, shared } = fakeMssqlContract();
    const runtime = createRuntime({ engine: 'mssql', contract });
    assert.deepEqual(await runtime.execute('UPDATE users SET active = 1 WHERE id = ?', 4), {
      rowsAffected: 5,
    });
    assert.deepEqual(await runtime.insertAndGetId('INSERT INTO tickets (title) VALUES (?)', 'hola'), {
      id: 9,
      rowsAffected: 1,
    });
    assert.match(shared.execute[0][0], /@p0/);
    const [text] = shared.insertAndGetId[0];
    assert.match(text, /SCOPE_IDENTITY/);
    assert.match(text, /@p0/);
  });

  it('transaction encamina las consultas al contrato de la transacción', async () => {
    const { contract, shared, inTx } = fakeMssqlContract();
    const runtime = createRuntime({ engine: 'mssql', contract });
    const value = await runtime.transaction(async (tx) => {
      const viaTxObject = await tx.queryOne('SELECT ? AS a', 1);
      const viaRuntime = await runtime.queryMany('SELECT ? AS b', 2);
      assert.equal(shared.queryOne.length, 0, 'fuera de la tx no debe usarse el contrato compartido');
      assert.equal(shared.queryMany.length, 0);
      return { viaTxObject, viaRuntime };
    });
    assert.deepEqual(value.viaTxObject, { via: 'tx' });
    assert.deepEqual(value.viaRuntime, [{ via: 'tx' }]);
    assert.equal(inTx.queryOne.length, 1);
    assert.equal(inTx.queryMany.length, 1);
    assert.deepEqual(shared.transactions, ['begin', 'commit']);
    await assert.rejects(runtime.transaction(() => runtime.transaction(async () => {})), /anidadas/);
  });

  it('expone el identificador del motor y valida sus dependencias', () => {
    const { contract } = fakeMssqlContract();
    assert.equal(createRuntime({ engine: 'mssql', contract }).engine, 'mssql');
    assert.throws(() => createRuntime({ engine: 'oracle' }), /no soportado/);
    assert.throws(() => createRuntime({ engine: 'sqlite' }), /necesita la conexión/);
    assert.throws(() => createRuntime({ engine: 'mssql', contract: {} }), /necesita el contrato/);
  });
});

// -----------------------------------------------------------------------
// fachada por defecto (la suite corre con DB_CLIENT=sqlite)

describe('runtime: fachada por defecto', () => {
  it('elige el motor de la configuración y ejecuta sobre la base real de pruebas', async () => {
    const { default: db } = await import('../src/db/runtime.js');
    assert.equal(currentEngine(), 'sqlite');
    assert.deepEqual(await db.queryOne('SELECT 1 AS one'), { one: 1 });
    assert.deepEqual(await db.queryMany('SELECT 1 AS a WHERE 0'), []);
    assert.deepEqual(await db.execute('UPDATE users SET name = name WHERE 0'), { rowsAffected: 0 });
    const two = await db.transaction(async (tx) => (await tx.queryOne('SELECT 2 AS two')).two);
    assert.equal(two, 2);
    await assert.rejects(db.queryOne('SELECT ?, ?', 1), /pero se enviaron 1/);
  });
});
