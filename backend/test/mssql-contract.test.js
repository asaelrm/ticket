import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMssqlContract } from '../src/db/mssql.js';

function fakeDriver({ result = { recordset: [], rowsAffected: [0] } } = {}) {
  const calls = { connects: [], inputs: [], sql: [] };
  const pool = {
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

describe('contrato MSSQL', () => {
  it('abre el pool de forma perezosa y lo reutiliza', async () => {
    const driver = fakeDriver({ result: { recordset: [{ id: 7 }], rowsAffected: [1] } });
    const contract = createMssqlContract({ server: 'dev', database: 'tickets' }, driver);
    assert.equal(driver.calls.connects.length, 0);
    await contract.queryOne('SELECT @id AS id', { id: 7 });
    await contract.queryMany('SELECT @id AS id', { ':id': 8 });
    assert.equal(driver.calls.connects.length, 1);
    assert.deepEqual(driver.calls.inputs, [['id', 7], ['id', 8]]);
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
});
