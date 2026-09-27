import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from './helpers.js';
import db from '../src/db.js';
import { saveDirectorySnapshot, restoreDirectorySnapshot } from '../src/directorySync.js';
import { seed } from '../src/seed.js';
import { hashPassword, verifyPassword } from '../src/utils/password.js';

// El directorio de usuarios NUNCA debe decidir una contraseña. Estas pruebas
// fallan con el código anterior al arreglo (que guardaba `password_hash` en el
// archivo y lo restauraba en cada arranque) y pasan con el actual.

const NUEVA = 'ClaveNueva9!';
const VIEJA = '123456';
const IMPOSTA = 'ClaveImpuesta8!';

let workDir;
let snapshotFile;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-directorio-'));
  snapshotFile = path.join(workDir, 'directory.json');
});

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function hashDe(username) {
  return db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;
}

function fijar(username, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hashPassword(password), username);
}

describe('el directorio no transporta contraseñas', () => {
  it('el archivo guardado no contiene ningún password_hash', () => {
    assert.equal(saveDirectorySnapshot({ enabled: true, file: snapshotFile }), true);

    const crudo = fs.readFileSync(snapshotFile, 'utf8');
    assert.equal(crudo.includes('password_hash'), false, 'el archivo sigue bringing password_hash');
    assert.equal(/"password_hash"/.test(crudo), false);

    const snapshot = JSON.parse(crudo);
    assert.equal(snapshot.version, 2);
    assert.ok(snapshot.users.length >= 3, 'debe exportar las cuentas existentes');
    for (const user of snapshot.users) {
      assert.equal('password_hash' in user, false, `el usuario ${user.username} lleva hash`);
    }
  });

  it('tras cambiar una contraseña por la API, el archivo sigue sin hashes', async () => {
    const admin = createClient();
    await admin.login('admin', VIEJA);
    const res = await admin.post('/api/auth/change-password', {
      current_password: VIEJA,
      new_password: NUEVA,
    });
    assert.equal(res.status, 200);
    assert.equal(verifyPassword(NUEVA, hashDe('admin')), true);

    saveDirectorySnapshot({ enabled: true, file: snapshotFile });
    const crudo = fs.readFileSync(snapshotFile, 'utf8');
    assert.equal(crudo.includes('password_hash'), false);

    // Se devuelve la contraseña de la prueba para no dejar el resto alterado.
    fijar('admin', VIEJA);
  });

  it('un snapshot antiguo con hashes no puede cambiar una contraseña', () => {
    fijar('admin', NUEVA);

    // Snapshot con el formato viejo, que además trae un hash de una contraseña
    // que nunca se dio en esta base de datos.
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        version: 1,
        departments: [],
        users: [
          {
            name: 'Administrador',
            last_name: 'Sistema',
            username: 'admin',
            email: 'admin@empresa.com',
            password_hash: hashPassword('ClaveDelHashViejo7!'),
            position: 'Administrador del sistema',
            active: 1,
            role_code: 'ADMIN',
            department_name: null,
          },
        ],
      })
    );

    restoreDirectorySnapshot({ enabled: true, file: snapshotFile });

    assert.equal(verifyPassword(NUEVA, hashDe('admin')), true, 'el snapshot pisó la contraseña vigente');
    assert.equal(verifyPassword('ClaveDelHashViejo7!', hashDe('admin')), false);
    fijar('admin', VIEJA);
  });
});

describe('cambiar una contraseña y reiniciar', () => {
  it('la contraseña anterior no recupera el acceso tras restaurar el directorio', async () => {
    const admin = createClient();
    await admin.login('admin', VIEJA);
    assert.equal((await admin.post('/api/auth/change-password', {
      current_password: VIEJA,
      new_password: NUEVA,
    })).status, 200);

    // Es lo que hace server.js en cada arranque, después del seed.
    seed();
    restoreDirectorySnapshot({ enabled: true, file: snapshotFile });

    const viejo = createClient();
    const intentoViejo = await viejo.login('admin', VIEJA);
    assert.equal(intentoViejo.status, 401, 'la contraseña anterior sigue dando acceso');

    const nuevo = createClient();
    assert.equal((await nuevo.login('admin', NUEVA)).status, 200, 'la contraseña nueva debe servir');

    fijar('admin', VIEJA);
  });
});

describe('el seed no impone contraseñas por defecto', () => {
  it('con SEED_ADMIN_PASSWORD en el entorno el seed NO cambia la de un administrador existente', () => {
    const guardado = process.env.SEED_ADMIN_PASSWORD;
    process.env.SEED_ADMIN_PASSWORD = IMPOSTA;
    try {
      fijar('admin', NUEVA);

      // Exactamente lo que hace server.js en cada arranque.
      seed();

      assert.equal(verifyPassword(NUEVA, hashDe('admin')), true, 'el seed impuso su contraseña');
      assert.equal(verifyPassword(IMPOSTA, hashDe('admin')), false);
    } finally {
      if (guardado === undefined) delete process.env.SEED_ADMIN_PASSWORD;
      else process.env.SEED_ADMIN_PASSWORD = guardado;
      fijar('admin', VIEJA);
    }
  });

  it('SEED_ADMIN_FORCE_PASSWORD sí la cambia, y solo entonces', () => {
    const guardadoPwd = process.env.SEED_ADMIN_PASSWORD;
    const guardadoForce = process.env.SEED_ADMIN_FORCE_PASSWORD;
    process.env.SEED_ADMIN_PASSWORD = IMPOSTA;
    process.env.SEED_ADMIN_FORCE_PASSWORD = 'true';
    try {
      fijar('admin', NUEVA);

      seed();

      assert.equal(verifyPassword(IMPOSTA, hashDe('admin')), true);
    } finally {
      if (guardadoPwd === undefined) delete process.env.SEED_ADMIN_PASSWORD;
      else process.env.SEED_ADMIN_PASSWORD = guardadoPwd;
      if (guardadoForce === undefined) delete process.env.SEED_ADMIN_FORCE_PASSWORD;
      else process.env.SEED_ADMIN_FORCE_PASSWORD = guardadoForce;
      fijar('admin', VIEJA);
    }
  });
});

describe('una cuenta que solo existe en el directorio', () => {
  it('se crea sin ninguna contraseña conocida', () => {
    const nombre = `importado_${Date.now()}`;
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        version: 2,
        departments: [],
        users: [
          {
            name: 'Importado',
            last_name: 'DelDirectorio',
            username: nombre,
            email: `${nombre}@empresa.com`,
            position: 'Puesto',
            active: 1,
            role_code: 'EMPLOYEE',
            department_name: null,
          },
        ],
      })
    );

    const resultado = restoreDirectorySnapshot({ enabled: true, file: snapshotFile });
    assert.equal(resultado.applied, true);
    assert.deepEqual(resultado.nuevas, [nombre]);

    const hash = hashDe(nombre);
    assert.ok(hash && hash.length > 0, 'debe tener hash');
    for (const intento of [VIEJA, NUEVA, IMPOSTA, '123456', nombre, '']) {
      assert.equal(verifyPassword(intento, hash), false, `entró con "${intento}"`);
    }
  });
});
