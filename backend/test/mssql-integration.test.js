import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { createMssqlContract, isDevelopmentDatabase } from '../src/db/mssql.js';
import MssqlSessionStore, { destroyUserSessionsMssql } from '../src/utils/mssqlSessionStore.js';

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

integration('MSSQL DEV DATETIME2(3) UTC B10.5', { timeout: 30_000 }, async () => {
  const contract = createMssqlContract(integrationConfig());
  const isoUtc = '2026-10-05T18:20:29.317Z';
  try {
    // Consulta de solo lectura: valida ISO 8601 → DATETIME2(3), sin DML.
    const row = await contract.queryOne(
      'SELECT CONVERT(datetime2(3), @at, 127) AS at',
      { at: new Date(isoUtc) },
    );
    assert.equal(row.at, isoUtc);
    const rendered = await contract.queryOne(
      "SELECT CONVERT(char(23), CONVERT(datetime2(3), @at, 127), 126) AS value",
      { at: new Date(isoUtc) },
    );
    assert.equal(rendered.value, '2026-10-05T18:20:29.317');
  } finally {
    await contract.close();
  }
});

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

function callbackResult(invoke) {
  return new Promise((resolve, reject) => invoke((error, value) => (error ? reject(error) : resolve(value))));
}

integration('MSSQL DEV MssqlSessionStore B10 · aislamiento', { timeout: 30_000 }, async () => {
  const contract = createMssqlContract(integrationConfig());
  const store = new MssqlSessionStore({ contract });

  // Todos los SIDs de B10 llevan el marcador `b10-session-`. Es la única llave
  // que permite setup y cleanup: ninguna sentencia borra sesiones por expire,
  // por tabla completa ni por TRUNCATE.
  const MARKER = 'b10-session-';
  const markerLike = `${MARKER}%`;
  const sidA = 'b10-session-A';
  const sidB = 'b10-session-B';
  const sidExpired = 'b10-session-A-expired';
  const sidMalicious = `${MARKER}A'; DROP TABLE dbo.sessions; --`;
  const runId = `b10-${Date.now()}`;
  const userA = `${runId}-user-a`;
  const userB = `${runId}-user-b`;

  async function cleanupMarker() {
    return contract.execute('DELETE FROM dbo.sessions WHERE sid LIKE @marker', { marker: markerLike });
  }

  async function markerRows() {
    const row = await contract.queryOne('SELECT COUNT(*) AS n FROM dbo.sessions WHERE sid LIKE @marker', { marker: markerLike });
    return Number(row.n);
  }

  async function rowOf(sid) {
    return contract.queryOne('SELECT sess, expire FROM dbo.sessions WHERE sid = @sid', { sid });
  }

  async function rowsOfSid(sid) {
    const row = await contract.queryOne('SELECT COUNT(*) AS n FROM dbo.sessions WHERE sid = @sid', { sid });
    return Number(row.n);
  }

  const sessionA = {
    userId: userA,
    cookie: { expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(), originalMaxAge: 3_600_000 },
    nota: "O'Reilly \"comillas\" áéíóú 你好 \u{1F600} -- no SQL",
    lista: [{ n: 1 }, { n: 2 }],
    anidado: { a: { b: { c: null } } },
  };
  const sessionB = {
    userId: userB,
    cookie: { expires: new Date(Date.now() + 120 * 60 * 1000).toISOString(), originalMaxAge: 7_200_000 },
    nota: 'sesión ajena intacta',
  };

  let snapshotB;

  async function assertBIntacto(step) {
    assert.deepEqual(await rowOf(sidB), snapshotB, `${step}: la sesión B no puede cambiar`);
  }

  try {
    await cleanupMarker();
    assert.equal(await markerRows(), 0, 'El setup debe partir de cero sesiones B10');

    // get() sobre SIDs inexistentes.
    assert.equal(await callbackResult((done) => store.get(sidA, done)), null);
    assert.equal(await callbackResult((done) => store.get(sidB, done)), null);
    assert.equal(await markerRows(), 0, 'get() no puede crear filas');

    // set() + get() de A y de B.
    await callbackResult((done) => store.set(sidA, sessionA, done));
    assert.equal(await rowsOfSid(sidA), 1);
    assert.equal((await rowOf(sidA)).sess, JSON.stringify(sessionA), 'Unicode y JSON deben persistir literalmente');
    assert.deepEqual(await callbackResult((done) => store.get(sidA, done)), sessionA);

    await callbackResult((done) => store.set(sidB, sessionB, done));
    snapshotB = await rowOf(sidB);
    assert.deepEqual(await callbackResult((done) => store.get(sidB, done)), sessionB);
    await assertBIntacto('set(A)');

    // Update de A: una sola fila, contenido nuevo, B intacta.
    const sessionAUpdated = {
      ...sessionA,
      nota: 'actualizada',
      cookie: { ...sessionA.cookie, expires: new Date(Date.now() + 180 * 60 * 1000).toISOString() },
    };
    await callbackResult((done) => store.set(sidA, sessionAUpdated, done));
    assert.equal(await rowsOfSid(sidA), 1, 'set() repetido no debe duplicar el SID');
    assert.deepEqual(await callbackResult((done) => store.get(sidA, done)), sessionAUpdated);
    await assertBIntacto('update(A)');

    // touch(A) renueva solo el expire de A.
    const touchedExpiry = new Date(Date.now() + 240 * 60 * 1000).toISOString();
    await callbackResult((done) => store.touch(sidA, { cookie: { expires: touchedExpiry } }, done));
    assert.equal(Number((await rowOf(sidA)).expire), new Date(touchedExpiry).getTime());
    await assertBIntacto('touch(A)');

    // get(A) repetido no muta nada.
    await callbackResult((done) => store.get(sidA, done));
    await assertBIntacto('get(A)');

    // Sesión expirada: get() devuelve null y la fila sigue ahí.
    await callbackResult((done) => store.set(sidExpired, { userId: userA, cookie: { expires: new Date(0).toISOString() } }, done));
    assert.equal(await callbackResult((done) => store.get(sidExpired, done)), null);
    assert.equal(await rowsOfSid(sidExpired), 1, 'get() no debe borrar la fila expirada');
    await assertBIntacto('get(expirada)');

    // length() coincide con el conteo real y no muta.
    const length = await callbackResult((done) => store.length(done));
    const total = await contract.queryOne('SELECT COUNT(*) AS n FROM dbo.sessions');
    assert.equal(length, Number(total.n));
    assert.equal(await markerRows(), 3);
    await assertBIntacto('length()');

    // SID malicioso tratado como parámetro.
    await callbackResult((done) => store.set(sidMalicious, { userId: userA, cookie: { expires: new Date(Date.now() + 60 * 60 * 1000).toISOString() } }, done));
    assert.ok(await rowOf(sidMalicious), 'El SID malicioso debe insertarse como dato, no como SQL');
    await callbackResult((done) => store.destroy(sidMalicious, done));
    assert.equal(await rowOf(sidMalicious), null);

    // destroyUserSessionsMssql(userA) no toca las sesiones de userB.
    const destroyed = await destroyUserSessionsMssql(userA, contract);
    assert.equal(destroyed.rowsAffected, 2, 'Solo las dos sesiones propias de userA deben desaparecer');
    assert.equal(await callbackResult((done) => store.get(sidA, done)), null);
    assert.equal(await rowsOfSid(sidExpired), 0);
    await assertBIntacto('destroyUserSessionsMssql(userA)');
    assert.deepEqual(await callbackResult((done) => store.get(sidB, done)), sessionB);

    // destroy(A) explícito sobre una fila nueva no afecta a B.
    await callbackResult((done) => store.set(sidA, { userId: userA, cookie: { expires: new Date(Date.now() + 60 * 60 * 1000).toISOString() } }, done));
    await callbackResult((done) => store.destroy(sidA, done));
    assert.equal(await rowOf(sidA), null);
    await assertBIntacto('destroy(A)');

    await callbackResult((done) => store.destroy(sidB, done));
    assert.equal(await rowOf(sidB), null);
    assert.equal(await callbackResult((done) => store.get(sidB, done)), null);
    assert.equal(await markerRows(), 0);
  } finally {
    try {
      await cleanupMarker();
      const remaining = await markerRows();
      assert.equal(remaining, 0, 'El cleanup B10 debe dejar cero sesiones con marcador');
      console.log(`B10_SESSION_ROWS_REMAINING=${remaining}`);
    } finally {
      await contract.close();
    }
  }
});
