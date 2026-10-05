// B12 · el arranque depende del motor de base de datos.
//
// Antes, `runMigrations()` era la primera línea de server.js y es SQLite puro:
// con DB_CLIENT=mssql moría ahí y no había servidor. Estas pruebas fijan las dos
// ramas del arranque.
//
// Lo que hay que evitar a toda costa es el falso positivo obvio: que la suite
// pase porque ya no se ejecuta NADA. Por eso la rama SQLite se comprueba tanto
// por sus pasos (con dobles que registran el orden) como de extremo a extremo, y
// la rama MSSQL se comprueba contra un proceso real.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import {
  SQLITE_BOOTSTRAP_STEPS,
  runDatabaseBootstrap,
  startBackgroundJobs,
  usesSqliteBootstrap,
} from '../src/startup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
const serverPath = path.join(backendDir, 'src', 'server.js');
const MARCA_ESCUCHA = 'API escuchando';
// Se espera a la ÚLTIMA línea del arranque, no a la primera: así se sabe que el
// hijo ya imprimió su configuración completa.
const MARCA_LISTO = '[ticket] Uploads:';
const dirsAbiertos = [];
const hijosAbiertos = [];

// Configuración de conexión INVENTADA para comprobar que el arranque no la
// imprime. `.invalid` es un TLD reservado por la RFC 2606 que nunca resuelve,
// así que estos valores no pueden apuntan a nada real aunque se intentara
// conectar. No se lee el .env del repositorio ni del desarrollador.
const CONEXION_SINTETICA = {
  servidor: 'servidor-inexistente.invalid',
  puerto: '1433',
  base: 'base_de_datos_inventada',
  usuario: 'usuario_inventado',
  contrasena: 'contrasena-inventada-que-no-existe',
};

function dirTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-b12-'));
  dirsAbiertos.push(dir);
  return dir;
}

// Borra el directorio temporal. `force: true` solo ignora que ya no exista, que
// es el estado normal cuando la prueba ya lo limpió; cualquier otro fallo
// (EBUSY, EPERM) se propaga para que la suite lo diga en vez de tragárselo.
function borrarTemporal(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Resolve cuando el hijo ya terminó. `SIGKILL` es asíncrono y en Windows los
// handles de SQLite (tickets.db, -wal, -shm) no se liberan hasta que el proceso
// ha muerto de verdad: sin esta espera, borrar el directorio falla.
function esperarSalida(hijo) {
  return new Promise((resolve) => {
    if (hijo.exitCode !== null || hijo.signalCode !== null) return resolve();
    hijo.once('exit', resolve);
    hijo.once('error', resolve);
  });
}

// Red de seguridad para lo que una prueba fallida pueda dejar sin cerrar. No se
// traga nada: si algo queda vivo o sin borrar, la suite falla diciéndolo.
after(async () => {
  const problemas = [];
  for (const hijo of hijosAbiertos) {
    if (hijo.exitCode === null && hijo.signalCode === null) {
      hijo.kill('SIGKILL');
      await esperarSalida(hijo);
    }
  }
  for (const dir of dirsAbiertos) {
    try {
      borrarTemporal(dir);
    } catch (e) {
      problemas.push(`no se pudo borrar ${dir}: ${e.message}`);
    }
  }
  if (problemas.length) throw new Error(`limpieza de B12:\n  ${problemas.join('\n  ')}`);
});

// Puerto libre para el hijo: el servidor tiene que escuchar en uno real para
// poder pedirle /api/health, y con PORT=0 el proceso solo imprimiría "0".
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

// Entorno del hijo. Con `mssql` se le pasa una configuración inventada: en el
// arranque no se abre ninguna conexión, así que sirve para comprobar que los
// datos de conexión no se imprimen. Sin `mssql` se anulan, para que la prueba de
// SQLite no dependa de ninguna configuración de SQL Server.
function entornoHijo({ dir, port, dbClient, mssql }) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    DB_CLIENT: dbClient,
    DB_SERVER: mssql?.servidor ?? '',
    DB_PORT: mssql?.puerto ?? '',
    DB_INSTANCE: '',
    DB_DATABASE: mssql?.base ?? '',
    DB_USER: mssql?.usuario ?? '',
    DB_PASSWORD: mssql?.contrasena ?? '',
    DB_ENCRYPT: '',
    DB_FILE: '',
    DATA_DIR: dir,
    UPLOAD_DIR: path.join(dir, 'uploads'),
    DIRECTORY_SNAPSHOT_FILE: path.join(dir, 'directory.json'),
    DIRECTORY_SYNC: 'false',
    MAIL_ENABLED: 'false',
    PORT: String(port),
    SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
    SEED_ADMIN_PASSWORD: '',
    SEED_ADMIN_FORCE_PASSWORD: '',
    SEED_DEMO_ACCOUNTS: '',
    SEED_DEMO_PASSWORD: '',
    SEED_TECH_PASSWORD: '',
  };
}

// Arranca server.js de verdad. El proceso se queda vivo: la prueba necesita
// pedirle /api/health antes de cortarlo, no al revés. `salida` es un getter
// para poder leer lo que el hijo imprima hasta el final, no una copia del
// instante en que dejó de escuchar.
async function arrancar({ dbClient, mssql }) {
  const dir = dirTemporal();
  const port = await puertoLibre();
  const hijo = spawn(process.execPath, [serverPath], { env: entornoHijo({ dir, port, dbClient, mssql }) });
  hijosAbiertos.push(hijo);

  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d.toString(); });
  hijo.stderr.on('data', (d) => { salida += d.toString(); });

  let errorArranque = null;
  hijo.on('error', (e) => { errorArranque = e; });
  hijo.on('exit', () => {
    if (!salida.includes(MARCA_LISTO)) errorArranque = new Error('el proceso terminó antes de escuchar');
  });

  for (let intento = 0; intento < 450; intento += 1) {
    if (salida.includes(MARCA_LISTO)) break;
    if (errorArranque) throw errorArranque;
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    dir,
    port,
    get salida() { return salida; },
    listo: salida.includes(MARCA_LISTO),
    // Idempotente: espera a la muerte real del hijo antes de devolver el control.
    detener: async () => {
      if (hijo.exitCode === null && hijo.signalCode === null) hijo.kill('SIGKILL');
      await esperarSalida(hijo);
    },
  };
}

// /api/health se registra antes del CSRF y del limitador, así que responde sin
// sesión ni token. Se reintenta un poco por si el socket va con retraso.
async function health(port) {
  for (let intento = 0; intento < 20; intento += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      return { status: res.status, body: await res.json() };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('el servidor no llegó a responder /api/health');
}

// Doble que registra qué pasos de arranque se ejecutan y en qué orden.
function dobles() {
  const llamadas = [];
  return {
    llamadas,
    runMigrations: () => llamadas.push('runMigrations'),
    seed: () => llamadas.push('seed'),
    restoreDirectorySnapshot: () => llamadas.push('restoreDirectorySnapshot'),
    startJobs: () => llamadas.push('startJobs'),
  };
}

describe('B12 · qué motor decide la inicialización', () => {
  it('sin DB_CLIENT se usa SQLite (el valor por defecto de config.js)', () => {
    assert.equal(usesSqliteBootstrap(undefined), true);
    assert.equal(usesSqliteBootstrap(''), true);
  });

  it('DB_CLIENT=sqlite y DB_CLIENT=mssql se distinguen', () => {
    assert.equal(usesSqliteBootstrap('sqlite'), true);
    assert.equal(usesSqliteBootstrap('mssql'), false);
  });

  it('los pasos de inicialización de SQLite son los conocidos', () => {
    assert.deepEqual(SQLITE_BOOTSTRAP_STEPS, ['migraciones', 'seed', 'directorio']);
  });
});

describe('B12 · el arranque sin DB_CLIENT conserva el comportamiento actual', () => {
  it('ejecuta migraciones, seed y directorio, en ese orden', () => {
    const d = dobles();
    const omitidos = runDatabaseBootstrap({ dbClient: undefined, ...d, log: () => {} });
    assert.deepEqual(d.llamadas, ['runMigrations', 'seed', 'restoreDirectorySnapshot']);
    assert.deepEqual(omitidos, []);
  });
});

describe('B12 · el arranque con DB_CLIENT=sqlite conserva el comportamiento actual', () => {
  it('ejecuta migraciones, seed y directorio, en ese orden', () => {
    const d = dobles();
    const omitidos = runDatabaseBootstrap({ dbClient: 'sqlite', ...d, log: () => {} });
    assert.deepEqual(d.llamadas, ['runMigrations', 'seed', 'restoreDirectorySnapshot']);
    assert.deepEqual(omitidos, []);
  });

  it('arranca el mantenimiento programado', () => {
    const d = dobles();
    assert.equal(startBackgroundJobs({ dbClient: 'sqlite', ...d, log: () => {} }), true);
    assert.deepEqual(d.llamadas, ['startJobs']);
  });
});

describe('B12 · el arranque con DB_CLIENT=mssql omite la inicialización de SQLite', () => {
  it('no invoca migraciones, seed ni directorio', () => {
    const d = dobles();
    const omitidos = runDatabaseBootstrap({ dbClient: 'mssql', ...d, log: () => {} });
    assert.deepEqual(d.llamadas, [], 'ninguna inicialización de SQLite debe ejecutarse');
    assert.deepEqual(omitidos, SQLITE_BOOTSTRAP_STEPS);
  });

  it('no invoca el mantenimiento programado', () => {
    const d = dobles();
    assert.equal(startBackgroundJobs({ dbClient: 'mssql', ...d, log: () => {} }), false);
    assert.deepEqual(d.llamadas, []);
  });
});

describe('B12 · proceso real con DB_CLIENT=mssql', () => {
  it('arranca, sirve health, no inicializa SQLite y no imprime la conexión', async () => {
    const hijo = await arrancar({ dbClient: 'mssql', mssql: CONEXION_SINTETICA });
    try {
      assert.ok(hijo.listo, `el servidor no llegó a escuchar:\n${hijo.salida}`);
      assert.ok(hijo.salida.includes(MARCA_ESCUCHA), `debe anunciarse la escucha:\n${hijo.salida}`);
      assert.ok(!hijo.salida.includes('La API legacy'), `no debe fallar por la API legacy:\n${hijo.salida}`);
      assert.match(hijo.salida, /Base de datos: SQL Server/);
      assert.match(hijo.salida, /migraci[oó]n progresiva/i);
      assert.match(hijo.salida, /API legacy de SQLite/);

      // Lo que en B11 bloqueaba el proceso: migraciones, seed y directorio.
      assert.ok(
        !fs.existsSync(path.join(hijo.dir, 'tickets.db')),
        'no debe crearse ninguna base SQLite cuando el motor es SQL Server',
      );

      // El mantenimiento quedó desactivado, así que tampoco debe ensuciar el log.
      assert.ok(!hijo.salida.includes('[jobs] Error'), `no debe haber errores de jobs:\n${hijo.salida}`);

      // La conexión no se imprime. Se comprueba con valores inventados, no con
      // los de nadie: si alguno apareciera, el arranque lo estaría filtrando.
      const salida = hijo.salida.toLowerCase();
      for (const valor of Object.values(CONEXION_SINTETICA)) {
        assert.ok(!salida.includes(valor.toLowerCase()), `no debe aparecer el dato de conexión "${valor}"`);
      }
      assert.ok(!/db_password/i.test(hijo.salida), 'no debe aparecer el nombre DB_PASSWORD');

      const { status, body } = await health(hijo.port);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    } finally {
      await hijo.detener();
      borrarTemporal(hijo.dir);
    }
  });
});

describe('B12 · el proceso real con SQLite no ha cambiado de comportamiento', () => {
  it('sigue migrando, sembrando y anunciando SQLite', async () => {
    const hijo = await arrancar({ dbClient: 'sqlite' });
    try {
      assert.ok(hijo.listo, `el servidor no llegó a escuchar:\n${hijo.salida}`);
      assert.ok(hijo.salida.includes(MARCA_ESCUCHA), `debe anunciarse la escucha:\n${hijo.salida}`);
      assert.match(hijo.salida, /Base de datos: SQLite/);

      const sqlite = path.join(hijo.dir, 'tickets.db');
      assert.ok(fs.existsSync(sqlite), 'con SQLite la base debe crearse igual que antes');

      // El log del seed solo se emite al ejecutar `node src/seed.js`, así que la
      // prueba de que el seed corrió se hace sobre los datos, que es lo que
      // importa: migraciones aplicadas y datos sembrados en el arranque.
      const bd = new DatabaseSync(sqlite, { readOnly: true });
      try {
        assert.equal(bd.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 11);
        assert.equal(bd.prepare('SELECT COUNT(*) AS n FROM departments').get().n, 7);
        assert.ok(bd.prepare('SELECT COUNT(*) AS n FROM permissions').get().n > 0);
        assert.ok(bd.prepare('SELECT COUNT(*) AS n FROM roles').get().n > 0);
      } finally {
        bd.close();
      }

      const { status, body } = await health(hijo.port);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    } finally {
      await hijo.detener();
      // Solo cuando el hijo ha muerto de verdad: si no, el borrado falla con
      // EBUSY por tickets.db-wal y el directorio se queda ahí para siempre.
      borrarTemporal(hijo.dir);
    }
  });
});
