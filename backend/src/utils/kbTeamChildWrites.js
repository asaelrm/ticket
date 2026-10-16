// Escrituras de las tablas hijas multiempresa del conocimiento y de equipos:
// kb_ticket_articles, kb_article_history y team_members.
//
// Motivo: el esquema MSSQL (src/db/mssql/schema.sql) declara organization_id
// NOT NULL en las tres, con clave foránea compuesta
// (organization_id, <padre_id>) hacia su padre; el esquema SQLite (src/db.js)
// NO tiene esa columna en las tablas hijas: se aíslan a través de su padre. Por
// eso la sentencia se construye según el esquema ACTIVO: no se añade
// organization_id cuando el motor no la tiene.
//
// La organización NUNCA llega del cliente ni de un valor arbitrario: se deriva
// en el servidor leyendo el padre en la MISMA base (kb_articles o teams) y
// contrastando la relación (el ticket para kb_ticket_articles, el usuario
// cuando corresponde). Cualquier relación cruzada, padre inexistente, padre sin
// organización o usuario ajeno se rechaza antes de escribir; nunca se escribe
// NULL ni un valor inventado.
//
// La fábrica `createKbTeamChildWrites` permite inyectar el runtime y la
// detección de motor para probar el comportamiento MSSQL sin conectar a SQL
// Server.

import runtime, { currentEngine } from '../db/runtime.js';

export function createKbTeamChildWrites(rt = runtime, engine = currentEngine) {
  const writesOrganizationId = () => engine() === 'mssql';

  function assertSameOrganization(label, id, ownerOrganizationId, declaredOrganizationId) {
    if (declaredOrganizationId === null || declaredOrganizationId === undefined) return;
    if (Number(declaredOrganizationId) !== Number(ownerOrganizationId)) {
      throw new Error(
        `La organización ${declaredOrganizationId} no corresponde al ${label} ${id} (pertenece a ${ownerOrganizationId}).`,
      );
    }
  }

  async function organizationIdForArticle(articleId, declaredOrganizationId) {
    const row = await rt.queryOne('SELECT organization_id FROM kb_articles WHERE id = ?', articleId);
    if (!row) {
      throw new Error(`No se puede escribir en una tabla hija: no existe el artículo ${articleId}.`);
    }
    if (row.organization_id === null || row.organization_id === undefined) {
      throw new Error(`No se puede escribir en una tabla hija: el artículo ${articleId} no tiene organización.`);
    }
    assertSameOrganization('artículo', articleId, row.organization_id, declaredOrganizationId);
    return row.organization_id;
  }

  async function organizationIdForTeam(teamId, declaredOrganizationId) {
    const row = await rt.queryOne('SELECT organization_id FROM teams WHERE id = ?', teamId);
    if (!row) {
      throw new Error(`No se puede escribir en team_members: no existe el equipo ${teamId}.`);
    }
    if (row.organization_id === null || row.organization_id === undefined) {
      throw new Error(`No se puede escribir en team_members: el equipo ${teamId} no tiene organización.`);
    }
    assertSameOrganization('equipo', teamId, row.organization_id, declaredOrganizationId);
    return row.organization_id;
  }

  // El usuario (si se indica) debe pertenecer a la organización dada. El
  // historial de sistema puede no llevar usuario: entonces no hay relación que
  // validar.
  async function assertUserInOrganization(userId, organizationId) {
    if (userId === null || userId === undefined) return;
    const row = await rt.queryOne('SELECT organization_id FROM users WHERE id = ?', userId);
    if (!row) throw new Error(`El usuario ${userId} no existe.`);
    if (row.organization_id === null || row.organization_id === undefined
        || Number(row.organization_id) !== Number(organizationId)) {
      throw new Error(`El usuario ${userId} no pertenece a la organización ${organizationId}.`);
    }
  }

  async function assertTicketInOrganization(ticketId, organizationId) {
    const row = await rt.queryOne('SELECT organization_id FROM tickets WHERE id = ?', ticketId);
    if (!row) throw new Error(`No existe el ticket ${ticketId}.`);
    if (row.organization_id === null || row.organization_id === undefined
        || Number(row.organization_id) !== Number(organizationId)) {
      throw new Error(`El ticket ${ticketId} no pertenece a la misma organización que el artículo.`);
    }
  }

  async function insertKbArticleHistory(
    articleId,
    userId,
    action,
    field,
    oldValue,
    newValue,
    { organizationId } = {},
  ) {
    if (writesOrganizationId()) {
      const organization = await organizationIdForArticle(articleId, organizationId);
      await assertUserInOrganization(userId, organization);
      return rt.execute(
        'INSERT INTO kb_article_history (organization_id, article_id, user_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
        organization, articleId, userId, action, field, oldValue, newValue,
      );
    }
    return rt.execute(
      'INSERT INTO kb_article_history (article_id, user_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      articleId, userId, action, field, oldValue, newValue,
    );
  }

  async function insertKbTicketArticle(articleId, ticketId, createdBy, { organizationId } = {}) {
    if (writesOrganizationId()) {
      const organization = await organizationIdForArticle(articleId, organizationId);
      await assertTicketInOrganization(ticketId, organization);
      await assertUserInOrganization(createdBy, organization);
      return rt.execute(
        'INSERT INTO kb_ticket_articles (organization_id, article_id, ticket_id, created_by) VALUES (?, ?, ?, ?)',
        organization, articleId, ticketId, createdBy,
      );
    }
    return rt.execute(
      'INSERT INTO kb_ticket_articles (article_id, ticket_id, created_by) VALUES (?, ?, ?)',
      articleId, ticketId, createdBy,
    );
  }

  async function insertTeamMember(teamId, userId, { organizationId } = {}) {
    if (writesOrganizationId()) {
      const organization = await organizationIdForTeam(teamId, organizationId);
      await assertUserInOrganization(userId, organization);
      return rt.execute(
        'INSERT OR IGNORE INTO team_members (organization_id, team_id, user_id) VALUES (?, ?, ?)',
        organization, teamId, userId,
      );
    }
    return rt.execute(
      'INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)',
      teamId, userId,
    );
  }

  return {
    organizationIdForArticle,
    organizationIdForTeam,
    insertKbArticleHistory,
    insertKbTicketArticle,
    insertTeamMember,
  };
}

const defaultWrites = createKbTeamChildWrites();

export const {
  organizationIdForArticle,
  organizationIdForTeam,
  insertKbArticleHistory,
  insertKbTicketArticle,
  insertTeamMember,
} = defaultWrites;
