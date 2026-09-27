// Barrera previa a cualquier despliegue.
//
// El riesgo que se cierra aquí es que una instalación nazca con credenciales
// conocidas: el seed creaba `admin` con una contraseña escrita en el código en
// cualquier entorno que no fuese exactamente 'production', el compose de
// producción traía esa misma contraseña y un SESSION_SECRET de ejemplo como
// valor por defecto, y la única comprobación de arranque era que SESSION_SECRET
// existiera, no que fuera utilizable.
//
// Estas pruebas comprueban las dos caras: que las reglas se aplican al arrancar
// de verdad (procesos nuevos, no simulaciones) y que el seed ya no tiene
// contraseñas por defecto que se puedan activar por accidente.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import db from '../src/db.js';
import { seed } from '../src/seed.js';
import { verifyPassword } from '../src/utils/password.js';
import {
  MIN_SESSION_SECRET_LENGTH,
  checkSessionSecret,
  collectStartupProblems,
} from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(backendDir, '..');
const serverPath = path.join(backendDir, 'src', 'server.js');

// Secreto de trabajo, generado aquí y nunca impreso: cumple las reglas que se
// exigen en producción sin escribir un valor real en el repositorio.
const SECRETO_VALIDO = crypto.randomBytes(32).toString('base64url');
const MARCA_ARRANQUE = 'API escuchando';
const dirsAbiertos = [];

function dirTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-arranque-'));
  dirsAbiertos.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirsAbiertos) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Si no se puede borrar, que no tumbe el resultado.
    }
  }
});

// Entorno de arranque: NADA se hereda del proceso de pruebas salvo lo
// inevitable. Todo apunta a un directorio temporal, de modo que ningún arranque
// de este archivo puede tocar la base de datos real.
function entorno(dir, extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: dir,
    UPLOAD_DIR: path.join(dir, 'uploads'),
    DIRECTORY_SNAPSHOT_FILE: path.join(dir, 'directory.json'),
    DIRECTORY_SYNC: 'false',
    MAIL_ENABLED: 'false',
    PORT: '0',
    SESSION_SECRET: '',
    PUBLIC_URL: '',
    CORS_ORIGIN: '',
    COOKIE_SECURE: '',
    SEED_ADMIN_PASSWORD: '',
    SEED_ADMIN_FORCE_PASSWORD: '',
    SEED_DEMO_ACCOUNTS: '',
    SEED_DEMO_PASSWORD: '',
    SEED_TECH_PASSWORD: '',
    ...extra,
  };
}

const FALLOS = { SESSION_SECRET: 'SESSION_SECRET', PUBLIC_URL: 'PUBLIC_URL' };

// Arranque que se espera fallido: rápido, el proceso muere solo.
function arrancarYEsperarFallo(extra) {
  const dir = dirTemporal();
  const r = spawnSync(process.execPath, [serverPath], {
    env: entorno(dir, extra),
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

// Arranque que se espera correcto: hay que esperarlo y cortarlo, porque un
// servidor con la base abierta no termina nunca por su cuenta.
function arrancarYEsperarOk(extra) {
  const dir = dirTemporal();
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [serverPath], { env: entorno(dir, extra) });
    let salida = '';
    let resuelto = false;
    const terminar = (arranco) => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(te);
      try {
        hijo.kill('SIGKILL');
      } catch {
        // Puede que ya haya muerto.
      }
      resolve({ arranco, salida });
    };
    hijo.stdout.on('data', (d) => {
      salida += d.toString();
      if (salida.includes(MARCA_ARRANQUE)) terminar(true);
    });
    hijo.stderr.on('data', (d) => {
      salida += d.toString();
    });
    hijo.on('error', () => terminar(false));
    hijo.on('exit', () => terminar(salida.includes(MARCA_ARRANQUE)));
    const te = setTimeout(() => terminar(false), 45000);
  });
}

describe('el secreto de sesión tiene que ser aleatorio y largo', () => {
  it('rechaza que no exista', () => {
    assert.match(checkSessionSecret(''), /no está definido/);
    assert.match(checkSessionSecret('   '), /no está definido/);
    assert.match(checkSessionSecret(undefined), /no está definido/);
  });

  it(`rechaza menos de ${MIN_SESSION_SECRET_LENGTH} caracteres`, () => {
    // Una cadena corta pero no repetida, para que la causa sea la longitud y no
    // el descarte de patrones.
    assert.match(checkSessionSecret('aB3$xY9'), /se exigen 32/);
    // Justo de longitud, pero sin repetir un patrón corto: tiene que valer.
    const enElLimite = 'k3Qm7Zt2Rb9Wv4Nc6Xj1Hs5Df0Lp8Ag3EyUi'.slice(0, MIN_SESSION_SECRET_LENGTH);
    assert.equal(checkSessionSecret(enElLimite), null);
  });

  it('rechaza el secreto de desarrollo, que es público', () => {
    assert.match(checkSessionSecret('ticket-dev-secret-change-me'), /ejemplo/);
    assert.match(checkSessionSecret('desarrollo-local-ticket'), /ejemplo/);
  });

  it('rechaza los valores de ejemplo de la documentación', () => {
    assert.match(checkSessionSecret('cambie-este-secreto-en-produccion-1234567890'), /ejemplo/);
    assert.match(checkSessionSecret('cambie-esto-por-una-frase-secreta-suficientemente-larga'), /ejemplo/);
    assert.match(checkSessionSecret(`cambie-esto-${'x'.repeat(40)}`), /ejemplo/);
  });

  it('rechaza un patrón corto repetido, que no es aleatorio', () => {
    assert.match(checkSessionSecret('abcabcabcabcabcabcabcabcabcabc'), /ejemplo/);
    assert.match(checkSessionSecret('a'.repeat(40)), /ejemplo/);
  });

  it('acepta un valor generado al azar', () => {
    assert.equal(checkSessionSecret(SECRETO_VALIDO), null);
  });
});

describe('la configuración de producción se valida antes de arrancar', () => {
  it('con NODE_ENV=production y sin nada, avisa de SESSION_SECRET y de PUBLIC_URL', () => {
    const { errors } = collectStartupProblems({ NODE_ENV: 'production' });
    assert.equal(errors.length, 2, `esperaba 2 errores, hubo: ${errors.join(' | ')}`);
    assert.ok(errors.some((e) => e.includes(FALLOS.SESSION_SECRET)));
    assert.ok(errors.some((e) => e.includes(FALLOS.PUBLIC_URL)));
  });

  it('una configuración completa no da ningún error', () => {
    const { errors } = collectStartupProblems({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
      COOKIE_SECURE: 'true',
    });
    assert.deepEqual(errors, []);
  });

  it('rechaza pedir cuentas de demostración en producción', () => {
    const { errors } = collectStartupProblems({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
      SEED_DEMO_ACCOUNTS: 'true',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /SEED_DEMO_ACCOUNTS/);
  });

  it('rechaza una contraseña de administrador corta en producción', () => {
    const { errors } = collectStartupProblems({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
      SEED_ADMIN_PASSWORD: '123456',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /SEED_ADMIN_PASSWORD/);
  });

  it('rechaza un PUBLIC_URL que no es una URL', () => {
    const { errors } = collectStartupProblems({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'tickets.example.com',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /PUBLIC_URL/);
  });

  it('en desarrollo y pruebas no hay barrera: no se rompe el trabajo local', () => {
    assert.deepEqual(collectStartupProblems({ NODE_ENV: 'development' }), { errors: [], warnings: [] });
    assert.deepEqual(collectStartupProblems({ NODE_ENV: 'test' }), { errors: [], warnings: [] });
    assert.deepEqual(collectStartupProblems({}), { errors: [], warnings: [] });
  });

  it('avisa, sin impedir el arranque, si la cookie puede viajar sin cifrar', () => {
    const { errors, warnings } = collectStartupProblems({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
    });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes('COOKIE_SECURE')));
  });
});

describe('el proceso real se niega a arrancar con la configuración incompleta', () => {
  it('sin SESSION_SECRET en producción', () => {
    const { status, salida } = arrancarYEsperarFallo({});
    assert.notEqual(status, 0, 'el proceso debería haber muerto');
    assert.match(salida, /no arranca/);
    assert.match(salida, /SESSION_SECRET/);
  });

  it('con un SESSION_SECRET corto', () => {
    const { status, salida } = arrancarYEsperarFallo({ SESSION_SECRET: 'aB3$xY9' });
    assert.notEqual(status, 0);
    assert.match(salida, /se exigen 32/);
  });

  it('con el secreto de desarrollo', () => {
    const { status, salida } = arrancarYEsperarFallo({ SESSION_SECRET: 'ticket-dev-secret-change-me' });
    assert.notEqual(status, 0);
    assert.match(salida, /ejemplo/);
  });

  it('con SESSION_SECRET válido pero sin PUBLIC_URL', () => {
    const { status, salida } = arrancarYEsperarFallo({ SESSION_SECRET: SECRETO_VALIDO });
    assert.notEqual(status, 0);
    assert.match(salida, /PUBLIC_URL/);
  });

  it('pidiendo cuentas de demostración', () => {
    const { status, salida } = arrancarYEsperarFallo({
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
      SEED_DEMO_ACCOUNTS: 'true',
    });
    assert.notEqual(status, 0);
    assert.match(salida, /SEED_DEMO_ACCOUNTS/);
  });

  it('con la configuración completa, arranca', async () => {
    const { arranco, salida } = await arrancarYEsperarOk({
      SESSION_SECRET: SECRETO_VALIDO,
      PUBLIC_URL: 'https://tickets.example.com',
      COOKIE_SECURE: 'true',
    });
    assert.ok(arranco, `no llegó a escuchar:\n${salida.slice(0, 800)}`);
  });

  it('en desarrollo arranca sin SESSION_SECRET ni PUBLIC_URL', async () => {
    const { arranco, salida } = await arrancarYEsperarOk({ NODE_ENV: 'development' });
    assert.ok(arranco, `no llegó a escuchar:\n${salida.slice(0, 800)}`);
  });
});

// Estado del entorno del seed que este archivo manipula.
const VIEJAS = ['SEED_ADMIN_PASSWORD', 'SEED_ADMIN_FORCE_PASSWORD', 'SEED_DEMO_ACCOUNTS', 'SEED_DEMO_PASSWORD', 'SEED_TECH_PASSWORD'];

function conSeed(vars, fn) {
  const guardadas = Object.fromEntries(VIEJAS.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    seed();
  } finally {
    for (const [k, v] of Object.entries(guardadas)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const usuario = (u) => db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(u);
const hashDe = (u) => (usuario(u) || {}).password_hash;

function borrarCuentasIniciales() {
  db.prepare("DELETE FROM users WHERE username IN ('admin', 'empleado', 'tecnico')").run();
}

describe('el seed no tiene ninguna contraseña por defecto', () => {
  after(() => {
    // Se deja la base de este archivo como la encontraron las pruebas.
    borrarCuentasIniciales();
    conSeed({
      SEED_ADMIN_PASSWORD: '123456',
      SEED_DEMO_ACCOUNTS: 'true',
      SEED_DEMO_PASSWORD: 'Empleado1234!',
      SEED_TECH_PASSWORD: 'Tecnico1234!',
    }, () => {});
  });

  it('sin SEED_ADMIN_PASSWORD no crea el administrador', () => {
    borrarCuentasIniciales();
    conSeed({ SEED_ADMIN_PASSWORD: null }, () => {});
    assert.equal(usuario('admin'), undefined, 'el seed creó un administrador sin que nadie lo pidiera');
  });

  it('con SEED_ADMIN_PASSWORD crea el administrador con esa contraseña', () => {
    borrarCuentasIniciales();
    const elegida = 'UnaContrasenaLarga9!';
    conSeed({ SEED_ADMIN_PASSWORD: elegida }, () => {});
    assert.ok(usuario('admin'), 'no se creó el administrador que se pidió');
    assert.equal(verifyPassword(elegida, hashDe('admin')), true);
  });

  it('sin SEED_DEMO_ACCOUNTS no crea las cuentas de demostración', () => {
    borrarCuentasIniciales();
    conSeed({ SEED_DEMO_ACCOUNTS: null, SEED_ADMIN_PASSWORD: 'UnaContrasenaLarga9!' }, () => {});
    assert.equal(usuario('empleado'), undefined, 'se creó empleado sin pedirlo');
    assert.equal(usuario('tecnico'), undefined, 'se creó tecnico sin pedirlo');
  });

  it('con SEED_DEMO_ACCOUNTS las crea con la contraseña indicada', () => {
    borrarCuentasIniciales();
    conSeed({
      SEED_ADMIN_PASSWORD: 'UnaContrasenaLarga9!',
      SEED_DEMO_ACCOUNTS: 'true',
      SEED_DEMO_PASSWORD: 'EmpleadoDePrueba9!',
      SEED_TECH_PASSWORD: 'TecnicoDePrueba9!',
    }, () => {});
    assert.equal(verifyPassword('EmpleadoDePrueba9!', hashDe('empleado')), true);
    assert.equal(verifyPassword('TecnicoDePrueba9!', hashDe('tecnico')), true);
  });

  it('sin contraseñas de demo, las cuentas nacen inservibles en vez de con una conocida', () => {
    borrarCuentasIniciales();
    conSeed({
      SEED_ADMIN_PASSWORD: 'UnaContrasenaLarga9!',
      SEED_DEMO_ACCOUNTS: 'true',
      SEED_DEMO_PASSWORD: null,
      SEED_TECH_PASSWORD: null,
    }, () => {});
    assert.ok(usuario('empleado'), 'no se creó la cuenta pedida');
    assert.ok(usuario('tecnico'), 'no se creó la cuenta pedida');
    for (const conocidas of ['123456', 'Empleado1234!', 'Tecnico1234!', 'empleado', 'tecnico', '']) {
      assert.equal(verifyPassword(conocidas, hashDe('empleado')), false, `empleado entra con "${conocidas}"`);
      assert.equal(verifyPassword(conocidas, hashDe('tecnico')), false, `tecnico entra con "${conocidas}"`);
    }
  });

  it('el código del seed no contiene ninguna de las contraseñas de ejemplo', () => {
    const fuente = fs.readFileSync(path.join(backendDir, 'src', 'seed.js'), 'utf8');
    for (const vieja of ['123456', 'Empleado1234!', 'Tecnico1234!']) {
      assert.equal(fuente.includes(vieja), false, `src/seed.js vuelve a contener "${vieja}"`);
    }
  });

  it('el compose de producción no trae credenciales de ejemplo', (t) => {
    const compose = path.join(repoDir, 'docker-compose.yml');
    // El compose vive en la raíz del repositorio, que no siempre está montada
    // dentro del contenedor donde se ejecutan las pruebas.
    if (!fs.existsSync(compose)) return t.skip('docker-compose.yml no está en esta imagen');
    const fuente = fs.readFileSync(compose, 'utf8');
    assert.equal(fuente.includes('123456'), false, 'el compose de producción vuelve a traer 123456');
    assert.equal(
      fuente.includes('cambie-este-secreto-en-produccion'),
      false,
      'el compose de producción vuelve a traer un SESSION_SECRET de ejemplo'
    );
    assert.match(
      fuente,
      /SESSION_SECRET: \$\{SESSION_SECRET:\?/,
      'SESSION_SECRET debería ser obligatorio en el compose'
    );
  });
});
