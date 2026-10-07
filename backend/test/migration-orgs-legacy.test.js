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
function runOn(db, extraEnv = {}) {
  const r = spawnSync(process.execPath, [fixtureTickets], {
    env: {
      ...process.env,
      DB_FILE: db,
      SEED_DEMO_ACCOUNTS: 'false',
      SEED_DEMO_PASSWORD: '',
      SEED_TECH_PASSWORD: '',
      NODE_ENV: 'development',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `el hijo falló:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function runLegacy(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migracion3-'));
  const db = path.join(dir, 'legacy.db');
  return { dir, result: runOn(db, extraEnv) };
}

describe('Migración de los dominios asociados a la organización (ETAPA 3)', () => {
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

  it('el rebuild preserva EXPLÍCITAMENTE las filas hijas (comentarios, adjuntos, historial, KB)', () => {
    const { dir, result } = runLegacy();
    try {
      // Antes y después del rebuild, fila a fila: cantidad, IDs y ticket_id.
      assert.deepEqual(
        result.children.after.comments,
        result.children.before.comments,
        'ticket_comments: misma cantidad, mismos ids y mismos ticket_id tras el rebuild'
      );
      assert.deepEqual(
        result.children.after.attachments,
        result.children.before.attachments,
        'ticket_attachments: misma cantidad, mismos ids y mismos ticket_id tras el rebuild'
      );
      assert.deepEqual(
        result.children.after.history,
        result.children.before.history,
        'ticket_history: misma cantidad, mismos ids y mismos ticket_id tras el rebuild'
      );
      assert.deepEqual(
        result.children.after.kb_ticket_articles,
        result.children.before.kb_ticket_articles,
        'kb_ticket_articles: mismas claves (article_id/ticket_id) tras el rebuild'
      );
      assert.deepEqual(
        result.children.afterIds,
        result.children.beforeIds,
        'los ids de tickets y de las tablas hijas no cambian con el rebuild'
      );

      // Contenidos concretos: los registros sembrados siguen existiendo.
      assert.equal(result.children.after.comments.count, 2);
      assert.deepEqual(result.children.after.comments.ids, [1, 2]);
      assert.deepEqual(result.children.after.comments.ticketIds, [1, 2]);
      assert.equal(result.children.after.attachments.count, 1);
      assert.deepEqual(result.children.after.attachments.ids, [1]);
      assert.deepEqual(result.children.after.attachments.ticketIds, [1]);
      assert.equal(result.children.after.history.count, 2);
      assert.deepEqual(result.children.after.history.ids, [1, 2]);
      assert.deepEqual(result.children.after.history.ticketIds, [1, 2]);
      assert.equal(result.children.after.kb_ticket_articles.count, 2);
      assert.deepEqual(result.children.after.kb_ticket_articles.entries, ['1/1', '1/2']);
      assert.deepEqual(result.children.after.kb_ticket_articles.ticketIds, [1, 2]);
      assert.deepEqual(result.children.after.kb_ticket_articles.articleIds, [1, 1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un fallo inducido durante el rebuild hace rollback y deja todo utilizable', () => {
    const { dir, result } = runLegacy({ INDUCE_REBUILD_FAILURE: '1' });
    try {
      assert.equal(result.induce, true);
      assert.equal(result.rollback.thrown, true, 'el rebuild debe abortar por el huérfano preexistente');
      assert.match(result.migrationError, /foreign_key_check/, 'el error debe venir de foreign_key_check');

      // Rollback completo: PRAGMA foreign_keys vuelve a ON, sin tabla temporal
      // huérfana, y los datos originales siguen ahí.
      assert.equal(result.rollback.fkOn, true, 'PRAGMA foreign_keys termina ON');
      assert.equal(result.rollback.ticketsExists, true, 'la tabla tickets sigue existiendo');
      assert.equal(result.rollback.rebuildTableGone, true, 'no queda tickets_rebuild huérfana');
      assert.equal(result.rollback.originalTickets, 2, 'los tickets originales se conservan');
      assert.ok(
        result.rollback.originalNumbers.includes('OLD-000001') && result.rollback.originalNumbers.includes('OLD-000002'),
        'se conservan los números y filas originales'
      );

      // Las filas hijas preexistentes sobreviven al rollback (el huérfano de
      // prueba incluido: era el dato corrupto que disparó el fallo).
      assert.equal(result.rollback.childrenAfterRollback.comments.count, 3);
      assert.deepEqual(result.rollback.childrenAfterRollback.comments.ids, [1, 2, 3]);
      assert.ok(
        result.rollback.childrenAfterRollback.comments.ticketIds.includes(999999),
        'el comentario huérfano que indujo el fallo sigue presente (el rollback no lo inventa ni lo borra)'
      );

      // La base sigue utilizable: se inserta y lee un ticket nuevo sin error.
      assert.equal(result.rollback.usable, true, 'tickets sigue aceptando operaciones');
      assert.equal(result.rollback.insertError, null);

      // El único fallo residual es justamente el dato corrupto preexistente.
      assert.equal(result.rollback.foreignKeyViolationsAfter, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// BLOQUEANTE 1: un `CREATE UNIQUE INDEX` explícito sobre ticket_number puede
// sobrevivir a la migración (la migración anterior solo buscaba autoindexes de
// constraint, origin 'u'). Aquí el UNIQUE global llega como índice explícito
// (origin 'c'): debe eliminarse con DROP INDEX sin reconstruir la tabla y la
// numeración por organización debe quedar operativa, incluso al rearrancar.
describe('UNIQUE global explícito sobre ticket_number (BLOQUEANTE 1)', () => {
  function legacyPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-unique-explicito-'));
    const db = path.join(dir, 'legacy.db');
    return { dir, db };
  }

  it('existe antes de migrar, la migración lo elimina y el mismo número vale en dos orgs', () => {
    const { dir, db } = legacyPath();
    try {
      const r = runOn(db, { LEGACY_EXPLICIT_GLOBAL_UNIQUE: '1' });
      assert.deepEqual(
        r.globalUnique.before.map((i) => ({ name: i.name, origin: i.origin })),
        [{ name: 'legacy_ticket_number_unique', origin: 'c' }],
        '1) el índice UNIQUE global explícito existe antes de la migración'
      );
      assert.deepEqual(r.globalUnique.after, [], '2) la migración elimina el UNIQUE global explícito');
      assert.equal(r.globalUnique.compositeIndex, true, '8) el compuesto UNIQUE(organization_id, ticket_number) sigue presente');
      assert.equal(r.perOrg.aOk, true, '3) ORG_A acepta TCK-000001');
      assert.equal(r.perOrg.bOk, true, '4) ORG_B acepta TCK-000001');
      assert.equal(r.perOrg.dupAThrows, true, '5) ORG_A no acepta un segundo TCK-000001');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('segundo arranque sobre la misma base: el índice global no reaparece y el compuesto sigue', () => {
    const { dir, db } = legacyPath();
    try {
      const first = runOn(db, { LEGACY_EXPLICIT_GLOBAL_UNIQUE: '1' });
      const second = runOn(db, { LEGACY_EXPLICIT_GLOBAL_UNIQUE: '1' });
      assert.deepEqual(second.globalUnique.before, [], '6) segundo arranque funciona y nada vuelve a aparecer');
      assert.deepEqual(second.globalUnique.after, [], '7) el índice global no reaparece tras el segundo arranque');
      assert.equal(second.globalUnique.compositeIndex, true, '8) el compuesto sigue presente tras el segundo arranque');
      assert.deepEqual(second.perOrg, first.perOrg, 'la numeración por organización es idempotente');
      assert.deepEqual(second.counts, first.counts, 'no se pierden ni duplican datos al rearrancar');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cuando el UNIQUE global proviene de constraint + índice explícito, el rebuild no lo restaura', () => {
    const { dir, db } = legacyPath();
    try {
      const r = runOn(db, { LEGACY_REBUILD_EXPLICIT: '1' });
      const origins = r.globalUnique.before.map((i) => i.origin).sort();
      assert.deepEqual(origins, ['c', 'u'], 'antes conviven el autoindex de constraint (u) y el índice explícito (c)');
      assert.deepEqual(r.globalUnique.after, [], 'el rebuild elimina AMBOS y no restaura el UNIQUE global');
      assert.equal(r.globalUnique.compositeIndex, true, 'el compuesto UNIQUE(organization_id, ticket_number) queda creado');
      assert.equal(r.perOrg.aOk, true, 'ORG_A acepta TCK-000001 tras el rebuild');
      assert.equal(r.perOrg.bOk, true, 'ORG_B acepta TCK-000001 tras el rebuild');
      assert.equal(r.perOrg.dupAThrows, true, 'ORG_A no acepta un segundo TCK-000001');
      assert.equal(r.rebuild.fkCheckOk, true, 'el rebuild quedó íntegro pese a no restaurar el índice');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});