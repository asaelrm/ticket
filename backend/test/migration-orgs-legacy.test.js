import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ETAPA 2: la migración que añade departments.organization_id debe ser
// ADITIVA, IDEMPOTENTE y SIN PÉRDIDA DE DATOS sobre una base pre-multiempresa
// real. Se hace en un proceso hijo con su propio DB_FILE (igual que
// secureConfig.test.js arranca procesos reales): los departamentos existentes
// terminan asociados a UCE y la columna queda como FK operativa.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'legacy-migration.mjs');

function legacyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migracion-'));
  return {
    dir,
    db: path.join(dir, 'legacy.db'),
  };
}

describe('Migración de departamentos.organization_id (ETAPA 2)', () => {
  it('añade la columna, hace backfill a UCE y conserva los datos sin duplicar', () => {
    const { dir, db } = legacyPath();
    const r = spawnSync(process.execPath, [fixture], {
      env: {
        ...process.env,
        DB_FILE: db,
        SEED_DEMO_ACCOUNTS: 'false',
        SEED_DEMO_PASSWORD: '',
        SEED_TECH_PASSWORD: '',
        NODE_ENV: 'development',
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `el hijo falló:\n${r.stdout}\n${r.stderr}`);
    const result = JSON.parse(r.stdout.trim().split('\n').pop());

    assert.equal(result.hasColumn, true, 'debe existir departments.organization_id');
    assert.ok(result.cols.includes('organization_id'));
    assert.ok(result.uceId, 'debe existir la organización inicial UCE');

    // Backfill: los departamentos legacy pertenecen a UCE.
    assert.equal(result.legacyBackfill, true, 'los departamentos pre-multiempresa se asocian a UCE');
    assert.ok(result.nombresLegacy.includes('IRH Legacy'), 'se conserva el nombre del departamento legacy');
    assert.ok(result.nombresLegacy.includes('TI Legacy'));

    // Backfill de usuarios (regresión de ETAPA 1A en el mismo proceso).
    assert.equal(result.userBackfill, true, 'el admin legacy termina en UCE');
    assert.equal(result.adminOrg, result.uceId);

    // Sin cuentas demo el único usuario es el admin legacy: no se duplicó.
    assert.equal(result.usersTotal, 1, 'no debe duplicarse el admin legacy');

    // La columna es una FK real, no una columna decorativa.
    assert.equal(result.fkOk, true, 'insertar un departamento con organización inexistente debe violar la FK');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('el seed rearrancado sobre la misma base no vuelve a separar ni duplicar', () => {
    // La idempotencia ya se ejecuta dos veces dentro del hijo (seed(); seed()).
    // Aquí se verifica el caso más fino: un departamento legacy cuyo nombre no
    // coincide con los iniciales sigue en UCE tras reejecutar (ningún UPDATE
    // de separación existe), última llamada del hijo anterior.
    const { dir, db } = legacyPath();
    const r = spawnSync(process.execPath, [fixture], {
      env: {
        ...process.env,
        DB_FILE: db,
        SEED_DEMO_ACCOUNTS: 'false',
        NODE_ENV: 'development',
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `el hijo falló:\n${r.stderr}`);
    const result = JSON.parse(r.stdout.trim().split('\n').pop());
    const legacyDepts = result.depts.filter((d) => d.name.endsWith('Legacy'));
    assert.equal(legacyDepts.length, 2, 'los departamentos legacy siguen siendo exactamente dos');
    assert.ok(legacyDepts.every((d) => d.organization_id === result.uceId));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});