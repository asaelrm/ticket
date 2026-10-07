import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMssqlContract, isDevelopmentDatabase } from '../src/db/mssql.js';

function driver({ result = { recordset: [{ id: 7 }], rowsAffected: [1] }, queryError, commitError, rollbackError, queryGate, connectGate, onQuery, onConnect } = {}) {
  const calls = { connects: 0, inputs: [], statements: [], begins: 0, commits: 0, rollbacks: 0, closes: 0 };
  const makeRequest = () => ({
    input(name, value) { calls.inputs.push([name, value]); return this; },
    async query(statement) {
      calls.statements.push(statement);
      onQuery?.();
      if (queryGate) await queryGate;
      const error = typeof queryError === 'function' ? queryError() : queryError;
      if (error) throw error;
      return result;
    },
  });
  const pool = { request: makeRequest, async close() { calls.closes += 1; } };
  class Transaction {
    async begin() { calls.begins += 1; }
    async commit() { calls.commits += 1; if (commitError) throw commitError; }
    async rollback() { calls.rollbacks += 1; if (rollbackError) throw rollbackError; }
  }
  class Request { constructor() { return makeRequest(); } }
  return { calls, connect: async () => { calls.connects += 1; onConnect?.(); if (connectGate) await connectGate; return pool; }, Transaction, Request };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('M1 MSSQL data contract', () => {
  it('imports and remains lazy until its first operation', () => {
    const fake = driver();
    createMssqlContract({ server: 'not-used' }, fake);
    assert.equal(fake.calls.connects, 0);
  });

  it('supports queryOne, queryMany, and execute through named parameters', async () => {
    const fake = driver({ result: { recordset: [{ at: new Date('2026-01-01T00:00:00.000Z') }, { id: 2 }], rowsAffected: [3] } });
    const db = createMssqlContract({}, fake);
    assert.equal((await db.queryOne('SELECT @id', { ':id': 1 })).at, '2026-01-01T00:00:00.000Z');
    assert.equal((await db.queryMany('SELECT @name', { name: 'safe' })).length, 2);
    assert.deepEqual(await db.execute('UPDATE x SET n = @n', { n: 3 }), { rowsAffected: 3 });
    assert.deepEqual(fake.calls.inputs, [['id', 1], ['name', 'safe'], ['n', 3]]);
  });

  it('keeps SQL unchanged and rejects unsafe or undefined bindings', async () => {
    const fake = driver();
    const db = createMssqlContract({}, fake);
    const statement = 'SELECT @name -- :not-a-parameter';
    await db.queryOne(statement, { name: "O'Reilly" });
    assert.equal(fake.calls.statements[0], statement);
    await assert.rejects(db.queryOne('SELECT @id', { 'id;DROP': 1 }), /no válido/);
    await assert.rejects(db.queryOne('SELECT @id', { id: undefined }), /undefined/);
  });

  it('requires OUTPUT INSERTED.id for insertAndGetId', async () => {
    const db = createMssqlContract({}, driver({ result: { recordset: [], rowsAffected: [1] } }));
    await assert.rejects(db.insertAndGetId('INSERT x VALUES (@x)', { x: 1 }), /OUTPUT INSERTED.id/);
  });

  it('commits transactionAsync and exposes the same async contract', async () => {
    const fake = driver();
    const db = createMssqlContract({}, fake);
    const value = await db.transactionAsync(async (tx) => {
      assert.deepEqual(await tx.execute('UPDATE x SET n = @n', { n: 1 }), { rowsAffected: 1 });
      return 'ok';
    });
    assert.equal(value, 'ok');
    assert.deepEqual([fake.calls.begins, fake.calls.commits, fake.calls.rollbacks], [1, 1, 0]);
  });

  it('rolls back and preserves the original query error', async () => {
    const failure = new Error('query failure');
    const fake = driver({ queryError: failure, rollbackError: new Error('rollback failure') });
    const db = createMssqlContract({}, fake);
    await assert.rejects(db.transactionAsync((tx) => tx.queryOne('SELECT broken')), (error) => {
      assert.equal(error, failure);
      assert.match(error.rollbackError.message, /rollback/);
      return true;
    });
    assert.equal(fake.calls.rollbacks, 1);
  });

  it('propagates a commit failure without issuing a second rollback', async () => {
    const fake = driver({ commitError: new Error('commit failure') });
    const db = createMssqlContract({}, fake);
    await assert.rejects(db.transactionAsync(async () => 'done'), /commit failure/);
    assert.deepEqual([fake.calls.commits, fake.calls.rollbacks], [1, 0]);
  });

  it('closes only an opened pool and recognizes dev/test names', async () => {
    const fake = driver();
    const db = createMssqlContract({}, fake);
    await db.close();
    assert.equal(fake.calls.closes, 0);
    await db.queryOne('SELECT 1');
    await db.close();
    assert.equal(fake.calls.closes, 1);
    assert.equal(isDevelopmentDatabase('SIFHADEV_TEST'), true);
    assert.equal(isDevelopmentDatabase('SIFHADEV'), false);
  });

  it('waits for a pending ordinary query before closing and rejects new work while closing', async () => {
    const queryStarted = deferred();
    const queryGate = deferred();
    const fake = driver({ queryGate: queryGate.promise, onQuery: queryStarted.resolve });
    const db = createMssqlContract({}, fake);
    const query = db.queryOne('SELECT pending');
    await queryStarted.promise;
    const closing = db.close();
    await assert.rejects(db.queryOne('SELECT too-late'), /se está cerrando/);
    assert.equal(fake.calls.closes, 0);
    queryGate.resolve();
    await query;
    await closing;
    assert.equal(fake.calls.closes, 1);
  });

  it('releases a failed ordinary operation so close completes and a later query reopens', async () => {
    const queryStarted = deferred();
    const queryGate = deferred();
    const failure = new Error('ordinary failure');
    let failsOnce = true;
    const fake = driver({
      queryError: () => (failsOnce ? (failsOnce = false, failure) : null),
      queryGate: queryGate.promise,
      onQuery: queryStarted.resolve,
    });
    const db = createMssqlContract({}, fake);
    const query = db.queryOne('SELECT broken');
    await queryStarted.promise;
    const closing = db.close();
    queryGate.resolve();
    await assert.rejects(query, failure);
    await closing;
    assert.equal(fake.calls.closes, 1);
    await db.queryOne('SELECT reopened');
    assert.equal(fake.calls.connects, 2);
  });

  it('waits for a lazy connection that is still opening before it closes the pool', async () => {
    const connectStarted = deferred();
    const connectGate = deferred();
    const fake = driver({ connectGate: connectGate.promise, onConnect: connectStarted.resolve });
    const db = createMssqlContract({}, fake);
    const query = db.queryOne('SELECT lazy');
    await connectStarted.promise;
    const closing = db.close();
    assert.equal(fake.calls.closes, 0);
    connectGate.resolve();
    await query;
    await closing;
    assert.equal(fake.calls.closes, 1);
  });
});
