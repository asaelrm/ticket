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
const fixtureTickets = path.join(__dirname, 'fixtures', 'legacy-tickets-migration.mjs');

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

// ETAPA 3: la migración debe ser ADITIVA, IDEMPOTENTE y SIN PÉRDIDA DE DATOS
// sobre una base pre-multiempresa con tickets y dominios asociados reales, y
// además heredar la secuencia legacy de numeración a la clave por organización
// (continuidad: el siguiente ticket de UCE es 4, no 1). El rebuild de la tabla
// tickets debe conservar filas hijas e ids, recrear objetos personalizados y
// dejar la integridad referencial intacta al REARANCAR el proceso sobre el
// MISMO archivo.
describe('Migración de los dominios asociados a la organización (ETAPA 3)', () => {
  function runOn(db) {
    const r = spawnSync(process.execPath, [fixtureTickets], {
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
    return JSON.parse(r.stdout.trim().split('\n').pop());
  }

  function runLegacy() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migracion3-'));
    const db = path.join(dir, 'legacy.db');
    return { dir, result: runOn(db) };
  }

  it('añade organization_id a las 6 tablas, hace backfill a UCE y conserva los datos', () => {
    const { dir, result } = runLegacy();
    try {
      for (const table of ['tickets', 'categories', 'teams', 'canned_responses', 'kb_categories', 'kb_articles']) {
        assert.equal(result.hasColumn[table], true, `debe existir organization_id en ${table}`);
      }
      assert.ok(result.uceId, 'debe existir la organización inicial UCE');

      // Backfill: ningún registro legacy queda huérfano ni fuera de UCE.
      for (const table of ['tickets', 'categories', 'teams', 'canned_responses', 'kb_categories', 'kb_articles']) {
        assert.equal(result.orphanBackfill[table], 0, `nada queda sin organización en ${table}`);
      }
      assert.equal(result.counts.ticketsTotal, 2, 'se conservan los dos tickets legacy');
      assert.equal(result.counts.ticketsUce, 2);
      assert.equal(result.counts.categoriesUce >= 2, true, 'categorías legacy + iniciales en UCE');
      assert.equal(result.counts.teamsUce, 1, 'el equipo legacy queda en UCE');
      assert.equal(result.counts.cannedUce, 2, 'plantillas GLOBAL y PERSONAL legacy en UCE');
      assert.equal(result.counts.kbCategoriesUce >= 1, true, 'categoría KB legacy en UCE');
      assert.equal(result.counts.kbArticlesUce, 1, 'el artículo legacy queda en UCE');
      assert.equal(result.counts.usersTotal, 1, 'no debe duplicarse el admin legacy');

      // La columna es una FK real, no decorativa.
      assert.equal(result.fkOk, true, 'insertar una categoría con organización inexistente debe violar la FK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sustituye el UNIQUE de columna de ticket_number por la unicidad compuesta por organización', () => {
    const { dir, result } = runLegacy();
    try {
      assert.equal(result.numberUnique.constraintColumnRemoved, true,
        'el autoindex UNIQUE de columna legado debe desaparecer de la tabla tickets');
      assert.equal(result.numberUnique.compositeIndex, true,
        'debe existir el índice único compuesto idx_tickets_number_org');
      assert.equal(result.numberUnique.dupSameOrgThrows, true,
        'duplicar el número dentro de la misma organización sigue violando la unicidad');
      assert.equal(result.numberUnique.dupOtherOrgAllowed, true,
        'la numeración es por organización: el mismo número en otra organización es legítimo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hereda la secuencia de tickets legacy y hace continuos los números', () => {
    const { dir, result } = runLegacy();
    try {
      assert.equal(result.numbering.legacySeq, 3, 'la secuencia legacy se conserva intacta');
      assert.equal(result.numbering.uceSeq, 3, 'la clave ticket_number:<UCE> se inicializa con el valor legacy');
      assert.equal(result.numbering.nextNumber, 'TCK-000004', 'el siguiente ticket de UCE continúa la secuencia legacy (no reinicia en 000001)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el seed rearrancado sobre la misma base no duplica ni reparte de nuevo', () => {
    // Doble arranque sobre el MISMO archivo: se reejecuta el proceso completo
    // (migración + seed + verificación) dos veces contra la misma base. El
    // fixture es idempotente (no reconstruye el esquema legacy si la base ya
    // está migrada), por lo que ambos resultados deben coincidir al detalle y
    // los registros han de conservar sus ids.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migracion3-'));
    const db = path.join(dir, 'legacy.db');
    try {
      const first = runOn(db);
      const second = runOn(db);
      assert.deepEqual(second.counts, first.counts, 'repetir migración+seed no altera los datos');
      assert.deepEqual(second.orphanBackfill, first.orphanBackfill, 'nada vuelve a quedar huérfano');
      assert.deepEqual(second.numbering, first.numbering, 'la numeración no se reajusta al rearrancar');
      assert.deepEqual(second.rebuild, first.rebuild, 'el rebuild es idempotente');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el rebuild de tickets conserva filas, nombres e integridad referencial', () => {
    const { dir, result } = runLegacy();
    try {
      // ids de los tickets legacy intactos tras reconstruir la tabla.
      assert.equal(result.rebuild.idsKept, 2, 'los dos tickets legacy conservan su id');
      // tablas hijas sin columna propia sobreviven al DROP/RENAME.
      assert.equal(result.rebuild.attachmentsTotal, 1, 'el adjunto legacy sigue ligado al ticket 1');
      // objetos personalizados recreados por el rebuild.
      assert.equal(result.rebuild.customIndexKept, true, 'el índice personalizado idx_tickets_title se recrea');
      assert.equal(result.rebuild.customTriggerKept, true, 'el trigger personalizado trg_tickets_auto_updated se recrea');
      assert.equal(result.rebuild.triggerWorks, true, 'el trigger reconstruido sigue operativo');
      // integridad: sin violaciones de FK y secuencia heredada del max(id).
      assert.equal(result.rebuild.fkCheckOk, true, 'foreign_key_check queda limpio tras el rebuild');
      assert.equal(result.rebuild.seqOk, true, 'sqlite_sequence se restaura al max(id)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});