import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSqliteDatabase, createSqliteContract } from '../src/db/sqlite.js';

// Pruebas del CONTRATO de A2 sobre un SQLite propio y temporal. No tocan la base
// real: cada archivo de test corre en su proceso (node --test) y abre un fichero
// nuevo en un directorio temporal que se borra al terminar.

let dir;
let db;
let contract;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-contrato-'));
  db = createSqliteDatabase(path.join(dir, 'contrato.db'));
  contract = createSqliteContract(db);
  db.exec(`
    CREATE TABLE usuarios (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      nota  TEXT
    )
  `);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('contrato SQLite · queryOne', () => {
  it('devuelve la fila cuando existe', async () => {
    const { id } = await contract.insertAndGetId(
      'INSERT INTO usuarios(email, nota) VALUES(:email, :nota)',
      { email: 'ada@tickets.local', nota: 'primera' },
    );
    const fila = await contract.queryOne('SELECT email, nota FROM usuarios WHERE id = :id', { id });
    assert.equal(fila.email, 'ada@tickets.local');
    assert.equal(fila.nota, 'primera');
  });

  it('devuelve null (no undefined) cuando no existe', async () => {
    const fila = await contract.queryOne('SELECT * FROM usuarios WHERE id = :id', { id: 999 });
    assert.equal(fila, null);
  });

  it('acepta la clave del parámetro con o sin los dos puntos', async () => {
    const a = await contract.queryOne('SELECT :n AS n', { n: 5 });
    const b = await contract.queryOne('SELECT :n AS n', { ':n': 5 });
    assert.equal(a.n, 5);
    assert.equal(b.n, 5);
  });

  it('funciona sin objeto de parámetros', async () => {
    await contract.insertAndGetId('INSERT INTO usuarios(email) VALUES(:email)', { email: 'a@b.c' });
    const total = await contract.queryOne('SELECT COUNT(*) AS c FROM usuarios');
    assert.equal(total.c, 1);
  });
});

describe('contrato SQLite · queryMany', () => {
  it('devuelve un array con todas las filas', async () => {
    await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', { email: 'a@b.c' });
    await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', { email: 'd@e.f' });
    const filas = await contract.queryMany('SELECT email FROM usuarios ORDER BY email');
    assert.ok(Array.isArray(filas));
    assert.equal(filas.length, 2);
    assert.deepEqual(filas.map((f) => f.email), ['a@b.c', 'd@e.f']);
  });

  it('devuelve [] cuando no hay filas', async () => {
    const filas = await contract.queryMany('SELECT * FROM usuarios');
    assert.deepEqual(filas, []);
  });
});

describe('contrato SQLite · execute', () => {
  it('devuelve rowsAffected normalizado en un INSERT', async () => {
    const resultado = await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', {
      email: 'nuevo@b.c',
    });
    assert.deepEqual(resultado, { rowsAffected: 1 });
  });

  it('devuelve rowsAffected 0 cuando nada coincide', async () => {
    const resultado = await contract.execute('UPDATE usuarios SET nota = :n WHERE id = :id', {
      n: 'x',
      id: 999,
    });
    assert.deepEqual(resultado, { rowsAffected: 0 });
  });

  it('cuenta varias filas afectadas en un UPDATE masivo', async () => {
    await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', { email: 'a@b.c' });
    await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', { email: 'd@e.f' });
    const resultado = await contract.execute('UPDATE usuarios SET nota = :n', { n: 'misma' });
    assert.deepEqual(resultado, { rowsAffected: 2 });
  });

  it('no expone lastInsertRowid', async () => {
    const resultado = await contract.execute('INSERT INTO usuarios(email) VALUES(:email)', {
      email: 'x@y.z',
    });
    assert.deepEqual(Object.keys(resultado), ['rowsAffected']);
  });
});

describe('contrato SQLite · insertAndGetId', () => {
  it('devuelve el id generado y rowsAffected', async () => {
    const resultado = await contract.insertAndGetId(
      'INSERT INTO usuarios(email, nota) VALUES(:email, :nota)',
      { email: 'conid@b.c', nota: null },
    );
    assert.equal(typeof resultado.id, 'number');
    assert.equal(resultado.rowsAffected, 1);
    const fila = await contract.queryOne('SELECT email FROM usuarios WHERE id = :id', {
      id: resultado.id,
    });
    assert.equal(fila.email, 'conid@b.c');
  });

  it('devuelve ids correlativos reales', async () => {
    const primero = await contract.insertAndGetId('INSERT INTO usuarios(email) VALUES(:email)', {
      email: '1@b.c',
    });
    const segundo = await contract.insertAndGetId('INSERT INTO usuarios(email) VALUES(:email)', {
      email: '2@b.c',
    });
    assert.equal(segundo.id, primero.id + 1);
  });
});

describe('contrato SQLite · parámetros nombrados', () => {
  it('acepta varios parámetros en la misma consulta', async () => {
    await contract.insertAndGetId('INSERT INTO usuarios(email, nota) VALUES(:email, :nota)', {
      email: 'multi@b.c',
      nota: 'varias',
    });
    const fila = await contract.queryMany(
      'SELECT * FROM usuarios WHERE email = :email AND nota = :nota',
      { email: 'multi@b.c', nota: 'varias' },
    );
    assert.equal(fila.length, 1);
  });

  it('acepta un parámetro repetido en la misma sentencia', async () => {
    await contract.insertAndGetId('INSERT INTO usuarios(email, nota) VALUES(:email, :email)', {
      email: 'repetido@b.c',
    });
    const fila = await contract.queryOne('SELECT * FROM usuarios WHERE email = :email OR nota = :email', {
      email: 'repetido@b.c',
    });
    assert.equal(fila.email, 'repetido@b.c');
  });

  it('conserva NULL, números y booleanos', async () => {
    await contract.insertAndGetId('INSERT INTO usuarios(email, nota) VALUES(:email, :nota)', {
      email: 'nulos@b.c',
      nota: null,
    });
    const nulos = await contract.queryOne('SELECT nota FROM usuarios WHERE email = :email', {
      email: 'nulos@b.c',
    });
    assert.equal(nulos.nota, null);

    const numero = await contract.queryOne('SELECT :n AS n', { n: -12.5 });
    assert.equal(numero.n, -12.5);

    // SQLite no tiene booleano: el contrato lo guarda como 1/0.
    const verdadero = await contract.queryOne('SELECT :b AS b', { b: true });
    const falso = await contract.queryOne('SELECT :b AS b', { b: false });
    assert.equal(verdadero.b, 1);
    assert.equal(falso.b, 0);
  });

  it('rechaza undefined con un mensaje que nombra el parámetro', async () => {
    await assert.rejects(
      contract.execute('INSERT INTO usuarios(email, nota) VALUES(:email, :nota)', {
        email: 'undef@b.c',
        nota: undefined,
      }),
      /nota.*undefined|undefined.*nota/,
    );
  });

  it('rechaza parámetros que no son un objeto', async () => {
    await assert.rejects(
      contract.queryOne('SELECT :id AS id', ['no', 'es', 'objeto']),
      TypeError,
    );
  });

  // Los valores siguientes contienen, mezclados, todo lo que un reemplazo
  // ingenuo de texto rompería: comillas, dos puntos, interrogación, inicio de
  // comentario SQL, bloque de comentario, operador de comparación y acentos.
  // Si alguno se interpretara como SQL, la consulta fallaría o devolvería otras
  // filas; que devuelva exactamente el valor es la prueba de que el binding es
  // nativo y no hay sustitución de texto.
  const VALORES_ESCAPARIOS = [
    "comilla simple O'Reilly",
    'comilla doble "citado"',
    'dos puntos : nombre',
    'interrogación ?',
    'comentario de línea -- DROP TABLE usuarios',
    'comentario de bloque /*DROP TABLE usuarios*/',
    'acentos: áéíóúñ ¿? ¡!',
    'unicode: 你好 مرحبا',
    'json: {"nota":"abierta","id":1}',
    "combinado O'Reilly: \"x\" -- /*y*/ ? á 你好",
  ];

  for (const valor of VALORES_ESCAPARIOS) {
    it(`trata como dato: ${JSON.stringify(valor).slice(0, 48)}`, async () => {
      const email = 'escapatorio@b.c';
      const { id } = await contract.insertAndGetId(
        'INSERT INTO usuarios(email, nota) VALUES(:email, :nota)',
        { email, nota: valor },
      );
      const fila = await contract.queryOne('SELECT nota FROM usuarios WHERE id = :id', { id });
      assert.equal(fila.nota, valor);
    });
  }

  it('un valor con SQL incrustado no puede ejecutar nada', async () => {
    const { rowsAffected } = await contract.execute(
      'INSERT INTO usuarios(email, nota) VALUES(:email, :nota)',
      { email: 'inyeccion@b.c', nota: "'); DROP TABLE usuarios; --" },
    );
    assert.equal(rowsAffected, 1);
    const siguen = await contract.queryOne(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='usuarios'",
    );
    assert.equal(siguen.c, 1);
  });

  it('un nombre de parámetro mal formado no puede inyectar SQL', async () => {
    // La clave no se inserta en la sentencia: SQLite rechaza los nombres que no
    // corresponden a un parámetro declarado, así que el `DROP TABLE` nunca llega
    // a ejecutarse aunque forme parte de la clave.
    await assert.rejects(
      contract.queryOne('SELECT :id AS id', { 'id; DROP TABLE usuarios': 1 }),
      /Unknown named parameter/,
    );
  });
});

describe('contrato SQLite · errores', () => {
  it('propaga el error de SQL sin envolverlo', async () => {
    await assert.rejects(
      contract.queryMany('SELECT * FROM tabla_que_no_existe'),
      /no such table: tabla_que_no_existe/,
    );
  });

  it('propaga el error de una restricción violada', async () => {
    await assert.rejects(
      contract.execute('INSERT INTO usuarios(id, email) VALUES(:id, :email)', {
        id: 1,
        email: 'a@b.c',
      }).then(() => contract.execute('INSERT INTO usuarios(id, email) VALUES(:id, :email)', {
        id: 1,
        email: 'd@e.f',
      })),
      /UNIQUE constraint failed: usuarios.id/,
    );
  });
});

describe('contrato SQLite · conexión', () => {
  it('rechaza un objeto que no sea una conexión SQLite', () => {
    assert.throws(() => createSqliteContract(null), TypeError);
    assert.throws(() => createSqliteContract({}), TypeError);
  });

  it('sigue usando la misma conexión que la fachada legacy', async () => {
    await contract.insertAndGetId('INSERT INTO usuarios(email) VALUES(:email)', { email: 'misma@b.c' });
    // Lectura por la API legacy: si el contrato usara otra conexión, no vería la fila.
    const porLegacy = db.prepare('SELECT COUNT(*) AS c FROM usuarios').get();
    assert.equal(porLegacy.c, 1);
  });
});

// ---------------------------------------------------------------------------
// Configuración SQLite: A2 no puede haberla tocado.
// ---------------------------------------------------------------------------

describe('SQLite · configuración preservada', () => {
  it('sigue en WAL, con claves foráneas y busy_timeout', () => {
    const journal = db.prepare('PRAGMA journal_mode').get();
    const fk = db.prepare('PRAGMA foreign_keys').get();
    const busy = db.prepare('PRAGMA busy_timeout').get();
    assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
    assert.equal(fk.foreign_keys, 1);
    assert.equal(busy.timeout, 5000);
  });

  it('createSqliteDatabase sigue devolviendo el DatabaseSync sin envolver', () => {
    assert.equal(typeof db.prepare, 'function');
    assert.equal(typeof db.exec, 'function');
  });
});

// ---------------------------------------------------------------------------
// Selección de driver: A2 no abre la puerta a SQL Server.
// ---------------------------------------------------------------------------

async function configCon(env) {
  const ruta = pathToFileURL(path.resolve(import.meta.dirname, '../src/config.js')).href;
  const anterior = {};
  for (const [k, v] of Object.entries(env)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const { default: config } = await import(`${ruta}?caso=${Math.random()}`);
    return config;
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('DB_CLIENT · SQLite legacy y contrato MSSQL', () => {
  it('sin DB_CLIENT usa sqlite', async () => {
    assert.equal((await configCon({ DB_CLIENT: undefined })).dbClient, 'sqlite');
  });

  it('DB_CLIENT=sqlite se acepta', async () => {
    assert.equal((await configCon({ DB_CLIENT: 'sqlite' })).dbClient, 'sqlite');
  });

  it('DB_CLIENT=mssql se acepta para el contrato async', async () => {
    assert.equal((await configCon({ DB_CLIENT: 'mssql' })).dbClient, 'mssql');
  });

  it('db.js exporta el contrato y la conexión legacy a la vez', async () => {
    const modulo = await import('../src/db.js');
    assert.equal(typeof modulo.default.prepare, 'function', 'db.prepare() sigue disponible');
    assert.equal(typeof modulo.transaction, 'function', 'transaction(fn) sigue disponible');
    assert.equal(typeof modulo.runMigrations, 'function', 'runMigrations sigue disponible');
    assert.equal(typeof modulo.contract.queryOne, 'function');
    assert.equal(typeof modulo.contract.queryMany, 'function');
    assert.equal(typeof modulo.contract.execute, 'function');
    assert.equal(typeof modulo.contract.insertAndGetId, 'function');
  });

  it('todas las operaciones del contrato devuelven Promises', async () => {
    const { contract } = await import('../src/db.js');
    for (const nombre of ['queryOne', 'queryMany', 'execute', 'insertAndGetId']) {
      const retorno = contract[nombre]('SELECT 1 AS x');
      assert.ok(retorno instanceof Promise, `${nombre} debe devolver Promise`);
      await retorno;
    }
  });

  it('el contrato no expone transactionAsync todavía (decisión de A2)', async () => {
    const { contract } = await import('../src/db.js');
    assert.equal(contract.transactionAsync, undefined);
  });
});
