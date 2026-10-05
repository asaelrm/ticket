import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMssqlContract, isDevelopmentDatabase } from '../src/db/mssql.js';

function fakeDriver({ result = { recordset: [], rowsAffected: [0] } } = {}) {
  const calls = { connects: [], inputs: [], sql: [], closes: 0 };
  const pool = {
    async close() {
      calls.closes += 1;
    },
    request() {
      return {
        input(name, value) {
          calls.inputs.push([name, value]);
          return this;
        },
        async query(statement) {
          calls.sql.push(statement);
          return result;
        },
      };
    },
  };
  return { calls, connect: async (config) => { calls.connects.push(config); return pool; } };
}

function transactionDriver({ result = { recordset: [{ id: 9 }], rowsAffected: [1] }, beginError, queryError, commitError, rollbackError } = {}) {
  const calls = { transactions: [], requests: [], begins: 0, commits: 0, rollbacks: 0, closes: 0, sql: [], inputs: [] };
  const pool = { async close() { calls.closes += 1; } };
  class Transaction {
    constructor(parentPool) { calls.transactions.push(parentPool); }
    async begin() { calls.begins += 1; if (beginError) throw beginError; }
    async commit() { calls.commits += 1; if (commitError) throw commitError; }
    async rollback() { calls.rollbacks += 1; if (rollbackError) throw rollbackError; }
  }
  class Request {
    constructor(transaction) { calls.requests.push(transaction); }
    input(name, value) { calls.inputs.push([name, value]); return this; }
    async query(statement) { calls.sql.push(statement); if (queryError) throw queryError; return result; }
  }
  return { calls, pool, Transaction, Request, async connect() { return pool; } };
}

describe('contrato MSSQL', () => {
  it('solo reconoce nombres de base DEV/TEST inequívocos para integración', () => {
    assert.equal(isDevelopmentDatabase('SIFHA_Tickets_DEV'), true);
    assert.equal(isDevelopmentDatabase('tickets-test'), true);
    assert.equal(isDevelopmentDatabase('TicketsProduction'), false);
    assert.equal(isDevelopmentDatabase('devops'), false);
  });

  it('abre el pool de forma perezosa y lo reutiliza', async () => {
    const driver = fakeDriver({ result: { recordset: [{ id: 7 }], rowsAffected: [1] } });
    const contract = createMssqlContract({ server: 'dev', database: 'tickets' }, driver);
    assert.equal(driver.calls.connects.length, 0);
    await contract.queryOne('SELECT @id AS id', { id: 7 });
    await contract.queryMany('SELECT @id AS id', { ':id': 8 });
    assert.equal(driver.calls.connects.length, 1);
    assert.deepEqual(driver.calls.inputs, [['id', 7], ['id', 8]]);
  });

  it('close sin conexión previa no abre ni cierra un pool', async () => {
    const driver = fakeDriver();
    const contract = createMssqlContract({}, driver);
    await contract.close();
    assert.equal(driver.calls.connects.length, 0);
    assert.equal(driver.calls.closes, 0);
  });

  it('close cierra el pool activo, es idempotente y la siguiente query reconecta', async () => {
    const pools = [];
    const contract = createMssqlContract({}, {
      async connect() {
        const pool = {
          closed: 0,
          async close() { this.closed += 1; },
          request() {
            return { async query() { return { recordset: [{ id: 1 }], rowsAffected: [1] }; } };
          },
        };
        pools.push(pool);
        return pool;
      },
    });
    await contract.queryOne('SELECT 1 AS id');
    await contract.close();
    await contract.close();
    assert.equal(pools[0].closed, 1);

    await contract.queryOne('SELECT 1 AS id');
    assert.equal(pools.length, 2);
    assert.notEqual(pools[0], pools[1]);
  });

  it('permite retry tras un fallo inicial de conexión', async () => {
    let attempts = 0;
    const pool = fakeDriver({ result: { recordset: [{ id: 1 }] } });
    const contract = createMssqlContract({}, {
      async connect(config) {
        attempts += 1;
        if (attempts === 1) throw new Error('conexión inicial fallida');
        return pool.connect(config);
      },
    });
    await assert.rejects(contract.queryOne('SELECT 1 AS id'), /inicial fallida/);
    await contract.queryOne('SELECT 1 AS id');
    assert.equal(attempts, 2);
  });

  it('propaga un error real al cerrar y libera la referencia para reconectar', async () => {
    const closeError = new Error('cierre fallido');
    let connects = 0;
    const pool = {
      request() {
        return { async query() { return { recordset: [{ id: 1 }], rowsAffected: [1] }; } };
      },
      async close() {
        throw closeError;
      },
    };
    const contract = createMssqlContract({}, { async connect() { connects += 1; return pool; } });
    await contract.queryOne('SELECT 1 AS id');
    await assert.rejects(contract.close(), closeError);
    await contract.queryOne('SELECT 1 AS id');
    assert.equal(connects, 2);
  });

  it('entrega el SQL intacto y usa binding nativo', async () => {
    const driver = fakeDriver({ result: { recordset: [{ value: "O'Reilly" }], rowsAffected: [1] } });
    const contract = createMssqlContract({}, driver);
    const statement = "SELECT @name AS value -- :comentario";
    const row = await contract.queryOne(statement, { '@name': "O'Reilly" });
    assert.equal(row.value, "O'Reilly");
    assert.deepEqual(driver.calls.sql, [statement]);
    assert.deepEqual(driver.calls.inputs, [['name', "O'Reilly"]]);
  });

  it('normaliza rowsAffected e id mediante OUTPUT INSERTED.id', async () => {
    const driver = fakeDriver({ result: { recordset: [{ id: 42 }], rowsAffected: [1] } });
    const contract = createMssqlContract({}, driver);
    const inserted = await contract.insertAndGetId(
      'INSERT INTO departments(name) OUTPUT INSERTED.id AS id VALUES(@name)',
      { name: 'Tecnología' },
    );
    assert.deepEqual(inserted, { id: 42, rowsAffected: 1 });
  });

  it('rechaza valores undefined y nombres inseguros sin tocar el SQL', async () => {
    const driver = fakeDriver();
    const contract = createMssqlContract({}, driver);
    await assert.rejects(contract.queryOne('SELECT @name', { name: undefined }), /undefined/);
    await assert.rejects(contract.queryOne('SELECT @id', { 'id; DROP TABLE x': 1 }), /no válido/);
    assert.deepEqual(driver.calls.sql, []);
  });

  it('exige OUTPUT INSERTED.id para el contrato de inserción', async () => {
    const driver = fakeDriver({ result: { recordset: [], rowsAffected: [1] } });
    const contract = createMssqlContract({}, driver);
    await assert.rejects(
      contract.insertAndGetId('INSERT INTO departments(name) VALUES(@name)', { name: 'TI' }),
      /OUTPUT INSERTED.id/,
    );
  });

  it('transactionAsync usa Transaction/Request, confirma y devuelve el valor del callback', async () => {
    const driver = transactionDriver();
    const contract = createMssqlContract({}, driver);
    const value = await contract.transactionAsync(async (tx) => {
      assert.deepEqual(Object.keys(tx).sort(), ['execute', 'insertAndGetId', 'queryMany', 'queryOne']);
      assert.equal((await tx.queryOne('SELECT @id AS id', { id: 1 })).id, 9);
      assert.equal((await tx.queryMany('SELECT @id AS id', { id: 2 })).length, 1);
      assert.deepEqual(await tx.execute('UPDATE x SET a = @id', { id: 3 }), { rowsAffected: 1 });
      assert.deepEqual(await tx.insertAndGetId('INSERT x OUTPUT INSERTED.id AS id VALUES(@id)', { id: 4 }), { id: 9, rowsAffected: 1 });
      return 'confirmado';
    });
    assert.equal(value, 'confirmado');
    assert.deepEqual(driver.calls.transactions, [driver.pool]);
    assert.equal(driver.calls.requests.length, 4);
    assert.equal(driver.calls.begins, 1);
    assert.equal(driver.calls.commits, 1);
    assert.equal(driver.calls.rollbacks, 0);
  });

  it('transactionAsync no ejecuta callback si begin falla', async () => {
    const beginError = new Error('begin fallido');
    const driver = transactionDriver({ beginError });
    const contract = createMssqlContract({}, driver);
    let called = false;
    await assert.rejects(contract.transactionAsync(async () => { called = true; }), beginError);
    assert.equal(called, false);
    assert.equal(driver.calls.rollbacks, 0);
  });

  it('hace rollback y preserva el error original, incluso si rollback falla', async () => {
    const queryError = new Error('query fallida');
    const rollbackError = new Error('rollback fallido');
    const driver = transactionDriver({ queryError, rollbackError });
    const contract = createMssqlContract({}, driver);
    await assert.rejects(contract.transactionAsync(async (tx) => tx.queryOne('SELECT ERROR')), (error) => {
      assert.equal(error, queryError);
      assert.equal(error.rollbackError, rollbackError);
      return true;
    });
    assert.equal(driver.calls.rollbacks, 1);
  });

  it('propaga fallo de commit sin rollback automático', async () => {
    const commitError = new Error('commit fallido');
    const driver = transactionDriver({ commitError });
    const contract = createMssqlContract({}, driver);
    await assert.rejects(contract.transactionAsync(async () => 'ok'), commitError);
    assert.equal(driver.calls.commits, 1);
    assert.equal(driver.calls.rollbacks, 0);
  });

  it('rechaza anidamiento y close mientras la transacción está activa', async () => {
    const driver = transactionDriver();
    const contract = createMssqlContract({}, driver);
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const running = contract.transactionAsync(async () => {
      entered();
      await assert.rejects(contract.transactionAsync(async () => 'nested'), /anidadas/);
      await waiting;
    });
    await enteredPromise;
    await assert.rejects(contract.close(), /transacciones activas/);
    release();
    await running;
    await contract.close();
    assert.equal(driver.calls.closes, 1);
  });
});
