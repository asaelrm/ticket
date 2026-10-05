import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { createMssqlContract, isDevelopmentDatabase } from '../src/db/mssql.js';

const enabled = process.env.RUN_MSSQL_INTEGRATION === '1';
const integration = enabled ? test : test.skip;

function integrationConfig() {
  const { server, database, user, password, port, options } = config.mssql;
  if (!isDevelopmentDatabase(database)) {
    throw new Error('La integración MSSQL exige DB_DATABASE con marcador DEV o TEST antes de cualquier escritura.');
  }
  if (!server || !database || !user || !password) {
    throw new Error('Faltan DB_SERVER, DB_DATABASE, DB_USER o DB_PASSWORD para RUN_MSSQL_INTEGRATION=1.');
  }
  return { server, database, user, password, port, options };
}

integration('integración MSSQL DEV · contrato departments', { timeout: 30_000 }, async () => {
  const contract = createMssqlContract(integrationConfig());
  const marker = `B2 ${Date.now()} O'Reilly áéíóú -- DROP TABLE departments`;
  let id;

  try {
    const inserted = await contract.insertAndGetId(
      `INSERT INTO dbo.departments (name, description)
       OUTPUT INSERTED.id AS id
       VALUES (@name, @description)`,
      { name: marker, description: null },
    );
    id = inserted.id;
    assert.equal(typeof id, 'number');
    assert.equal(inserted.rowsAffected, 1);

    const one = await contract.queryOne(
      'SELECT id, name, description, active FROM dbo.departments WHERE id = @id',
      { id },
    );
    assert.equal(one.name, marker);
    assert.equal(one.description, null);
    assert.equal(one.active, true);

    const many = await contract.queryMany('SELECT id FROM dbo.departments WHERE id = @id', { '@id': id });
    assert.deepEqual(many.map((row) => row.id), [id]);

    const updated = await contract.execute(
      'UPDATE dbo.departments SET description = @description WHERE id = @id',
      { id, description: marker },
    );
    assert.deepEqual(updated, { rowsAffected: 1 });

    const after = await contract.queryOne('SELECT description FROM dbo.departments WHERE id = @id', { id });
    assert.equal(after.description, marker);

    await assert.rejects(contract.queryOne('SELECT * FROM dbo.tabla_inexistente_b2'), /Invalid object name|tabla_inexistente_b2/i);
  } finally {
    try {
      if (id !== undefined) {
        const deleted = await contract.execute('DELETE FROM dbo.departments WHERE id = @id', { id });
        assert.equal(deleted.rowsAffected, 1);
      }
    } finally {
      await contract.close();
    }
  }
});

integration('MSSQL DEV transactionAsync departments', { timeout: 30_000 }, async () => {
  const contract = createMssqlContract(integrationConfig());
  const commitMarker = `B5 COMMIT ${Date.now()} O'Reilly áéíóú`;
  const rollbackMarker = `B5 ROLLBACK ${Date.now()} -- DROP TABLE departments`;
  let committedId;
  try {
    const result = await contract.transactionAsync(async (tx) => {
      const inserted = await tx.insertAndGetId(
        'INSERT INTO dbo.departments (name, description) OUTPUT INSERTED.id AS id VALUES (@name, @description)',
        { name: commitMarker, description: null },
      );
      const inside = await tx.queryOne('SELECT id, name, description FROM dbo.departments WHERE id = @id', { id: inserted.id });
      assert.equal(inside.name, commitMarker);
      assert.equal(inside.description, null);
      return inserted;
    });
    committedId = result.id;
    assert.equal(typeof result.id, 'number');
    assert.equal(result.rowsAffected, 1);
    assert.equal((await contract.queryOne('SELECT name FROM dbo.departments WHERE id = @id', { id: committedId })).name, commitMarker);
    await assert.rejects(
      contract.transactionAsync(async (tx) => {
        await tx.insertAndGetId(
          'INSERT INTO dbo.departments (name, description) OUTPUT INSERTED.id AS id VALUES (@name, @description)',
          { name: rollbackMarker, description: 'debe revertirse' },
        );
        throw new Error('rollback B5 controlado');
      }),
      /rollback B5 controlado/,
    );
    assert.equal(await contract.queryOne('SELECT id FROM dbo.departments WHERE name = @name', { name: rollbackMarker }), null);
  } finally {
    try {
      if (committedId !== undefined) {
        assert.equal((await contract.execute('DELETE FROM dbo.departments WHERE id = @id', { id: committedId })).rowsAffected, 1);
      }
    } finally {
      await contract.close();
    }
  }
});

integration('MSSQL DEV transactionAsync role_permissions B8', { timeout: 30_000 }, async () => {
  const contract = createMssqlContract(integrationConfig());
  const roleCode = 'B8_TARGET_ROLE';
  const initialCodes = ['b8.permission.alpha', 'b8.permission.beta'];
  const gammaCode = 'b8.permission.gamma';

  async function associationCodes(client) {
    const rows = await client.queryMany(
      `SELECT p.code
       FROM dbo.role_permissions AS rp
       JOIN dbo.roles AS r ON r.id = rp.role_id
       JOIN dbo.permissions AS p ON p.id = rp.permission_id
       WHERE r.code = @roleCode
       ORDER BY p.code`,
      { roleCode },
    );
    return rows.map((row) => row.code);
  }

  async function replaceWith(client, codes) {
    const role = await client.queryOne('SELECT id FROM dbo.roles WHERE code = @roleCode', { roleCode });
    assert.ok(role, 'B8_TARGET_ROLE debe existir antes de la integración');
    await client.execute('DELETE FROM dbo.role_permissions WHERE role_id = @roleId', { roleId: role.id });
    for (const code of codes) {
      const permission = await client.queryOne('SELECT id FROM dbo.permissions WHERE code = @code', { code });
      assert.ok(permission, `El permiso sintético ${code} debe existir`);
      await client.execute(
        'INSERT INTO dbo.role_permissions (role_id, permission_id) VALUES (@roleId, @permissionId)',
        { roleId: role.id, permissionId: permission.id },
      );
    }
    return role.id;
  }

  try {
    assert.deepEqual(await associationCodes(contract), initialCodes);

    await contract.transactionAsync(async (tx) => {
      await replaceWith(tx, [gammaCode]);
    });
    assert.deepEqual(await associationCodes(contract), [gammaCode]);

    await contract.transactionAsync(async (tx) => {
      await replaceWith(tx, initialCodes);
    });
    assert.deepEqual(await associationCodes(contract), initialCodes);

    await assert.rejects(
      contract.transactionAsync(async (tx) => {
        const roleId = await replaceWith(tx, [gammaCode]);
        const gamma = await tx.queryOne('SELECT id FROM dbo.permissions WHERE code = @code', { code: gammaCode });
        await tx.execute(
          'INSERT INTO dbo.role_permissions (role_id, permission_id) VALUES (@roleId, @permissionId)',
          { roleId, permissionId: gamma.id },
        );
      }),
      /PK_role_permissions|duplicate|PRIMARY KEY/i,
    );
    assert.deepEqual(await associationCodes(contract), initialCodes);
  } finally {
    await contract.close();
  }
});
