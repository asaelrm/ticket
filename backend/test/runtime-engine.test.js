import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/db/runtime.js';

// -----------------------------------------------------------------------
// Contrato MSSQL falso en memoria. Estas pruebas NO abren ninguna conexión:
// comprueban la traducción SQLite→T-SQL, el binding de parámetros posicionales
// como @pN, la normalización de parámetros/filas y el encaminamiento a la
// transacción activa.

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
    // SQL Server es el único motor aceptado.
    assert.throws(() => createRuntime({ engine: 'oracle' }), /no soportado|único motor/);
    assert.throws(() => createRuntime({ engine: 'sqlite' }), /no soportado|único motor/);
    assert.throws(() => createRuntime({ engine: 'mssql', contract: {} }), /necesita el contrato/);
    assert.throws(() => createRuntime({ engine: 'mssql' }), /necesita el contrato/);
  });
});
