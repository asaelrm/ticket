// Escrituras de kb_ticket_articles, kb_article_history y team_members según el
// esquema activo.
//
// El esquema MSSQL exige organization_id NOT NULL en las tres (con FK compuesta
// hacia el padre); el esquema SQLite NO tiene esa columna en las tablas hijas.
// Estas pruebas comprueban, con un runtime real sobre un contrato FALSO (sin
// conexión a SQL Server):
//   - MSSQL incluye organization_id derivada del padre real (kb_articles o
//     teams) y rechaza cualquier relación cruzada, padre inexistente o padre
//     sin organización antes de escribir;
//   - kb_article_history valida la relación con el usuario cuando lo lleva;
//   - kb_ticket_articles comprueba que el ticket pertenece a la organización
//     del artículo;
//   - team_members comprueba que el usuario pertenece a la organización del
//     equipo;
//   - SQLite omite organization_id, no consulta el padre y conserva la
//     sentencia anterior (compatibilidad).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/db/runtime.js';
import { createKbTeamChildWrites } from '../src/utils/kbTeamChildWrites.js';

const MSSQL_HISTORY = /INSERT INTO kb_article_history \(organization_id, article_id, user_id, action, field, old_value, new_value\)/;
const MSSQL_LINK = /INSERT INTO kb_ticket_articles \(organization_id, article_id, ticket_id, created_by\)/;
const MSSQL_TEAM_MEMBER = /INSERT \(organization_id, team_id, user_id\)/;
const SQLITE_HISTORY = /INSERT INTO kb_article_history \(article_id, user_id, action, field, old_value, new_value\)/;
const SQLITE_LINK = /INSERT INTO kb_ticket_articles \(article_id, ticket_id, created_by\)/;
const SQLITE_TEAM_MEMBER = /INSERT OR IGNORE INTO team_members \(team_id, user_id\)/;

// Runtime MSSQL real sobre un contrato falso: ejercita la traducción a T-SQL y
// la validación del número de parámetros, sin abrir ninguna conexión.
function fakeMssqlRuntime(responses = {}) {
  const calls = { queryOne: [], execute: [] };
  const contract = {
    async queryOne(sql, params) {
      calls.queryOne.push({ sql, params });
      if (/FROM kb_articles WHERE id/.test(sql)) return responses.article ?? null;
      if (/FROM teams WHERE id/.test(sql)) return responses.team ?? null;
      if (/FROM users WHERE id/.test(sql)) return responses.user ?? null;
      if (/FROM tickets WHERE id/.test(sql)) return responses.ticket ?? null;
      return null;
    },
    async queryMany() { return []; },
    async execute(sql, params) { calls.execute.push({ sql, params }); return { rowsAffected: 1 }; },
    async insertAndGetId() { return { id: 1, rowsAffected: 1 }; },
    async transactionAsync(callback) { return callback(this); },
    async close() {},
  };
  const rt = createRuntime({ engine: 'mssql', contract });
  return { writes: createKbTeamChildWrites(rt, () => 'mssql'), calls };
}

// Runtime SQLite falso: no traduce ni consulta; solo registra.
function fakeSqliteRuntime() {
  const calls = { queryOne: [], execute: [] };
  const rt = {
    async queryOne(sql, ...params) { calls.queryOne.push({ sql, params }); return null; },
    async queryMany() { return []; },
    async execute(sql, ...params) { calls.execute.push({ sql, params }); return { rowsAffected: 1 }; },
    async insertAndGetId() { return { id: 1, rowsAffected: 1 }; },
    async transaction(callback) { return callback(rt); },
  };
  return { writes: createKbTeamChildWrites(rt, () => 'sqlite'), calls };
}

describe('kb_article_history: organization_id derivada del artículo (MSSQL)', () => {
  it('incluye organization_id del artículo y valida que el usuario es de esa organización', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      article: { organization_id: 7 },
      user: { organization_id: 7 },
    });
    await writes.insertKbArticleHistory(50, 3, 'UPDATED', 'Título', 'antes', 'después');

    assert.equal(calls.queryOne.length, 2, 'resuelve artículo y luego usuario');
    assert.match(calls.queryOne[0].sql, /FROM kb_articles WHERE id/);
    assert.match(calls.queryOne[1].sql, /FROM users WHERE id/);
    assert.equal(calls.execute.length, 1);
    assert.match(calls.execute[0].sql, MSSQL_HISTORY);
    assert.deepEqual(calls.execute[0].params, {
      p0: 7, p1: 50, p2: 3, p3: 'UPDATED', p4: 'Título', p5: 'antes', p6: 'después',
    });
  });

  it('el historial de sistema (sin usuario) también lleva organization_id y no consulta usuarios', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: { organization_id: 5 } });
    await writes.insertKbArticleHistory(51, null, 'CREATED', null, null, 'Nuevo');

    assert.equal(calls.queryOne.length, 1, 'sin usuario no hay relación que validar');
    assert.equal(calls.execute[0].params.p0, 5);
    assert.equal(calls.execute[0].params.p2, null);
  });

  it('rechaza un usuario de otra organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      article: { organization_id: 7 },
      user: { organization_id: 9 },
    });
    await assert.rejects(
      () => writes.insertKbArticleHistory(50, 3, 'UPDATED', 'Título', null, 'x'),
      /El usuario 3 no pertenece a la organización 7/,
    );
    assert.equal(calls.execute.length, 0, 'el cruce se rechaza ANTES de insertar');
  });

  it('rechaza un artículo inexistente sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: null });
    await assert.rejects(
      () => writes.insertKbArticleHistory(404, 3, 'CREATED', null, null, 'x'),
      /no existe el artículo 404/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un artículo sin organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: { organization_id: null } });
    await assert.rejects(
      () => writes.insertKbArticleHistory(50, 3, 'CREATED', null, null, 'x'),
      /el artículo 50 no tiene organización/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un organizationId declarado que no corresponde al artículo', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: { organization_id: 7 } });
    await assert.rejects(
      () => writes.insertKbArticleHistory(50, 3, 'CREATED', null, null, 'x', { organizationId: 8 }),
      /La organización 8 no corresponde al artículo 50 \(pertenece a 7\)/,
    );
    assert.equal(calls.execute.length, 0);
  });
});

describe('kb_ticket_articles: artículo y ticket en la misma organización (MSSQL)', () => {
  it('incluye organization_id del artículo cuando el ticket es de la misma organización', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      article: { organization_id: 7 },
      ticket: { organization_id: 7 },
      user: { organization_id: 7 },
    });
    await writes.insertKbTicketArticle(50, 10, 3);

    assert.equal(calls.queryOne.length, 3, 'artículo, ticket y usuario');
    assert.match(calls.execute[0].sql, MSSQL_LINK);
    assert.deepEqual(calls.execute[0].params, { p0: 7, p1: 50, p2: 10, p3: 3 });
  });

  it('rechaza un ticket de otra organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      article: { organization_id: 7 },
      ticket: { organization_id: 9 },
    });
    await assert.rejects(
      () => writes.insertKbTicketArticle(50, 10, 3),
      /El ticket 10 no pertenece a la misma organización que el artículo/,
    );
    assert.equal(calls.execute.length, 0, 'el cruce se rechaza ANTES de insertar');
  });

  it('rechaza un ticket inexistente sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: { organization_id: 7 }, ticket: null });
    await assert.rejects(
      () => writes.insertKbTicketArticle(50, 404, 3),
      /No existe el ticket 404/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un artículo inexistente sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ article: null });
    await assert.rejects(
      () => writes.insertKbTicketArticle(404, 10, 3),
      /no existe el artículo 404/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un creador de otra organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      article: { organization_id: 7 },
      ticket: { organization_id: 7 },
      user: { organization_id: 9 },
    });
    await assert.rejects(
      () => writes.insertKbTicketArticle(50, 10, 3),
      /El usuario 3 no pertenece a la organización 7/,
    );
    assert.equal(calls.execute.length, 0);
  });
});

describe('team_members: equipo y usuario en la misma organización (MSSQL)', () => {
  it('incluye organization_id del equipo y valida que el usuario es de esa organización', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      team: { organization_id: 7 },
      user: { organization_id: 7 },
    });
    await writes.insertTeamMember(20, 3, { organizationId: 7 });

    assert.equal(calls.queryOne.length, 2, 'equipo y usuario');
    assert.match(calls.queryOne[0].sql, /FROM teams WHERE id/);
    assert.match(calls.queryOne[1].sql, /FROM users WHERE id/);
    assert.equal(calls.execute.length, 1);
    assert.match(calls.execute[0].sql, /MERGE team_members/);
    assert.match(calls.execute[0].sql, MSSQL_TEAM_MEMBER);
    assert.deepEqual(calls.execute[0].params, { p0: 7, p1: 20, p2: 3 });
  });

  it('rechaza un usuario de otra organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({
      team: { organization_id: 7 },
      user: { organization_id: 9 },
    });
    await assert.rejects(
      () => writes.insertTeamMember(20, 3, { organizationId: 7 }),
      /El usuario 3 no pertenece a la organización 7/,
    );
    assert.equal(calls.execute.length, 0, 'el cruce se rechaza ANTES de insertar');
  });

  it('rechaza un equipo inexistente sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ team: null });
    await assert.rejects(
      () => writes.insertTeamMember(404, 3),
      /no existe el equipo 404/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un equipo sin organización sin insertar', async () => {
    const { writes, calls } = fakeMssqlRuntime({ team: { organization_id: null } });
    await assert.rejects(
      () => writes.insertTeamMember(20, 3),
      /el equipo 20 no tiene organización/,
    );
    assert.equal(calls.execute.length, 0);
  });

  it('rechaza un organizationId declarado que no corresponde al equipo', async () => {
    const { writes, calls } = fakeMssqlRuntime({ team: { organization_id: 7 } });
    await assert.rejects(
      () => writes.insertTeamMember(20, 3, { organizationId: 9 }),
      /La organización 9 no corresponde al equipo 20 \(pertenece a 7\)/,
    );
    assert.equal(calls.execute.length, 0);
  });
});

describe('escrituras de KB y equipos (SQLite, compatibilidad)', () => {
  it('kb_article_history omite organization_id y no consulta el artículo', async () => {
    const { writes, calls } = fakeSqliteRuntime();
    await writes.insertKbArticleHistory(50, 3, 'UPDATED', 'Título', 'antes', 'después');

    assert.equal(calls.queryOne.length, 0, 'en SQLite no hace falta resolver la organización');
    assert.equal(calls.execute.length, 1);
    assert.match(calls.execute[0].sql, SQLITE_HISTORY);
    assert.doesNotMatch(calls.execute[0].sql, /organization_id/);
    assert.deepEqual(calls.execute[0].params, [50, 3, 'UPDATED', 'Título', 'antes', 'después']);
  });

  it('kb_ticket_articles omite organization_id y no consulta el artículo', async () => {
    const { writes, calls } = fakeSqliteRuntime();
    await writes.insertKbTicketArticle(50, 10, 3);

    assert.equal(calls.queryOne.length, 0);
    assert.match(calls.execute[0].sql, SQLITE_LINK);
    assert.deepEqual(calls.execute[0].params, [50, 10, 3]);
  });

  it('team_members conserva INSERT OR IGNORE sin organization_id', async () => {
    const { writes, calls } = fakeSqliteRuntime();
    await writes.insertTeamMember(20, 3);

    assert.equal(calls.queryOne.length, 0);
    assert.match(calls.execute[0].sql, SQLITE_TEAM_MEMBER);
    assert.deepEqual(calls.execute[0].params, [20, 3]);
  });
});
