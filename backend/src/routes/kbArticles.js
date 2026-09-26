import express from 'express';
import db, { nowIso } from '../db.js';
import { safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { canViewTicket } from './tickets.js';
import {
  ARTICLE_STATUSES,
  normalizeKeywords,
  validateArticleFields,
} from '../utils/articleLimits.js';

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------- visibilidad

function hasPerm(user, code) {
  return user.permissions.includes(code);
}

/** kb.manage:.administra artículos de cualquier autor y en cualquier estado. */
function canModerate(user) {
  return hasPerm(user, 'kb.manage');
}

/**
 * ¿Puede este usuario leer este artículo?
 *
 * PUBLISHED → cualquiera con kb.view (garantizado por el middleware de la ruta).
 * DRAFT o ARCHIVED → solo su autor, o quien tenga kb.manage.
 *
 * Un borrador es privado por definición: no existe ninguna ruta pública que lo
 * devuelva, y `/:id` responde 404 (nunca 403) para no confirmar que existe.
 */
function canRead(user, article) {
  if (!article) return false;
  if (article.status === 'PUBLISHED') return true;
  return article.author_id === user.id || canModerate(user);
}

/** Edición: el autor o quien administra. */
function canEdit(user, article) {
  if (!article) return false;
  return article.author_id === user.id || canModerate(user);
}

/**
 * Cambio de estado (publicar, despublicar, archivar, destacar).
 * El autor necesita kb.publish sobre SU artículo; cualquier otro necesita
 * kb.manage. Así un técnico nunca publica material de otro técnico sin que
 * intervenga un administrador.
 */
function canTransition(user, article) {
  if (!article) return false;
  if (canModerate(user)) return true;
  return article.author_id === user.id && hasPerm(user, 'kb.publish');
}

// ------------------------------------------------------------------- listados

const SORTS = {
  recent: 'a.published_at DESC, a.title ASC',
  popular: 'a.view_count DESC, a.title ASC',
  title: 'a.title ASC',
};

/**
 * Orden solicitado, o el más reciente si no es uno de los previstos.
 *
 * Se comprueba con Object.hasOwn porque `SORTS[valor]` también resolvería las
 * claves heredadas de Object.prototype (`constructor`, `toString`, `__proto__`),
 * que son verdaderas y acabarían concatenadas en el ORDER BY provocando un 500.
 * Mismo criterio que sortClause() en cannedResponses.js.
 */
function sortClause(value) {
  return Object.hasOwn(SORTS, value) ? SORTS[value] : SORTS.recent;
}

const SEARCH_ESCAPE = `ESCAPE '\\'`;

/** Escapa %, _ y \ para que un término de búsqueda no se convierta en comodín. */
function likePattern(term) {
  return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SUMMARY_SELECT = `
  SELECT a.id, a.title, a.summary, a.keywords, a.status, a.category_id,
         a.author_id, a.is_featured, a.view_count, a.published_at,
         a.created_at, a.updated_at,
         u.name || ' ' || u.last_name AS author_name,
         c.name AS category_name, c.color AS category_color
  FROM kb_articles a
  LEFT JOIN users u ON u.id = a.author_id
  LEFT JOIN kb_categories c ON c.id = a.category_id
`;

/** El detalle añade el cuerpo; los listados nunca lo arrastran. */
const DETAIL_SELECT = `
  SELECT a.*, a.title AS _t, u.name || ' ' || u.last_name AS author_name,
         c.name AS category_name, c.color AS category_color
  FROM kb_articles a
  LEFT JOIN users u ON u.id = a.author_id
  LEFT JOIN kb_categories c ON c.id = a.category_id
`;

/** Cláusulas de búsqueda libre sobre los cinco campos de texto del artículo. */
function searchClause(alias, value) {
  const pattern = likePattern(value);
  const fields = ['title', 'summary', 'description', 'solution', 'keywords'];
  const parts = fields.map((f) => `LOWER(${alias}.${f}) LIKE ? ${SEARCH_ESCAPE}`);
  return { sql: `(${parts.join(' OR ')})`, params: fields.map(() => pattern) };
}

/** Normaliza page/perPage con los mismos topes que usa routes/tickets.js. */
function pagination(req) {
  const page = Math.max(parseIntSafe(req.query.page) || 1, 1);
  const perPage = Math.min(Math.max(parseIntSafe(req.query.perPage) || 15, 1), 100);
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Filtros compartidos por los tres listados (público, propio y de gestión).
 * Devuelve las cláusulas ya filtradas por estado/autor para que el llamante las
 *-use tal cual.
 */
function filterClauses(req, { alias = 'a' } = {}) {
  const clauses = [];
  const params = [];

  const q = safeStr(req.query.q);
  if (q) {
    const search = searchClause(alias, q);
    clauses.push(search.sql);
    params.push(...search.params);
  }

  const categoryId = parseIntSafe(req.query.category);
  if (categoryId) {
    clauses.push(`${alias}.category_id = ?`);
    params.push(categoryId);
  }

  if (req.query.featured === '1' || req.query.featured === 'true') {
    clauses.push(`${alias}.is_featured = 1`);
  }

  const status = req.query.status ? String(req.query.status).toUpperCase() : '';
  if (status) {
    if (!ARTICLE_STATUSES.includes(status)) {
      return { error: 'Estado no válido' };
    }
    clauses.push(`${alias}.status = ?`);
    params.push(status);
  }

  const authorId = parseIntSafe(req.query.author);
  if (authorId) {
    clauses.push(`${alias}.author_id = ?`);
    params.push(authorId);
  }

  return { clauses, params };
}

/**
 * Cuenta y devuelve página con el MISMO where, para que el total nunca incluya
 * filas que el listado va a filtrar (fuga por paginación).
 */
function runList(clauses, params, order, { page, perPage, offset }, selectSql) {
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM kb_articles a ${where}`).get(...params).n;
  const data = db
    .prepare(`${selectSql} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { data, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

// ------------------------------------------------------------------ historial

/** Recorte para el historial: guarda unFragmento legible, nunca el cuerpo entero. */
function preview(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function recordHistory(articleId, userId, action, field, oldValue, newValue) {
  db.prepare(
    'INSERT INTO kb_article_history (article_id, user_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(articleId, userId, action, field, preview(oldValue), preview(newValue));
}

// ------------------------------------------------------------------ duplicados

/**
 * Unicidad de título por autor entre artículos NO archivados.
 *
 * Se comprueba sobre DRAFT+PUBLISHED: un artículo archivado libera su título
 * para reutilizarlo, igual que `is_active` libera el de una plantilla. No se
 * comprueba entre autores distintos: dos técnicos documentando problemas
 * parecidos con títulos parecidos es legítimo, laKnowledge Base se orienta a
 * la reutilización, no a la deduplicación forzada.
 */
function duplicateExists({ title, authorId, excludeId = null }) {
  const row = db
    .prepare(
      `SELECT a.id FROM kb_articles a
       WHERE a.author_id = ?
         AND a.status IN ('DRAFT','PUBLISHED')
         AND LOWER(a.title) = LOWER(?)
         AND a.id != ?`
    )
    .get(authorId, title, excludeId ?? 0);
  return Boolean(row);
}

// ------------------------------------------------------------------ categorías

/**
 * Resuelve la categoría de un artículo. Acepta null (sin categoría) y rechaza
 * con 400 una categoría inexistente o desactivada, para no dejar artículos
 * apuntando a un catálogo que el usuario no puede ver en los filtros.
 */
function resolveCategoryId(value) {
  if (value === null) return { ok: true, categoryId: null };
  const id = parseIntSafe(value);
  if (!id) return { ok: false, error: 'Categoría de conocimiento no válida' };
  const row = db.prepare('SELECT id FROM kb_categories WHERE id = ? AND active = 1').get(id);
  if (!row) return { ok: false, error: 'La categoría de conocimiento no existe o está desactivada' };
  return { ok: true, categoryId: id };
}

// ------------------------------------------------------------------- artículos

/** Carga un artículo legible por el usuario, o null (el llamante responde 404). */
function readableArticle(user, id) {
  const row = db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id);
  return canRead(user, row) ? row : null;
}

router.get('/mine', requirePermission('kb.create'), (req, res) => {
  // Los artículos propios en cualquier estado, incluidos los archivados: es la
  // vista de trabajo del autor.
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const clauses = ['a.author_id = ?', ...filters.clauses];
  const params = [req.user.id, ...filters.params];
  const { page, perPage, offset } = pagination(req);
  res.json(runList(clauses, params, 'a.updated_at DESC, a.id DESC', { page, perPage, offset }, SUMMARY_SELECT));
});

router.get('/manage', requirePermission('kb.manage'), (req, res) => {
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const { page, perPage, offset } = pagination(req);
  res.json(
    runList(filters.clauses, filters.params, sortClause(req.query.sort), { page, perPage, offset }, SUMMARY_SELECT)
  );
});

/**
 * Previsualización para crear un borrador desde un ticket resuelto.
 *
 * REGLA DE ORO: este endpoint NO escribe nada y devuelve una lista blanca
 * explícita de columnas. Nunca `t.*`, para que una columna sensible que se añada
 * a `tickets` en el futuro no pueda colarse por descuido.
 *
 * NO devuelve: notas internas (ticket_comments.is_internal = 1), adjuntos
 * (incluidos los de notas internas), correo/usuario/teléfono del reportante,
 * motivos de pendiente, reapertura o cancelación, historial ni valoración CSAT.
 *
 * `description` sí se incluye: es la descripción del problema y es el punto de
 * partida natural del artículo. Es texto libre que la persona que reporta pudo
 * escribir, así que el autor DEBE revisarlo antes de publicar; por eso el
 * resultado es siempre un borrador que nadie más ve.
 */
router.get('/from-ticket/:ticketId', requirePermission('kb.create'), (req, res) => {
  const ticketId = parseIntSafe(req.params.ticketId);
  const ticket = ticketId
    ? db
        .prepare(
          `SELECT t.id, t.ticket_number, t.title, t.description, t.resolution,
                  t.resolution_category, t.root_cause, t.category_id,
                  t.status, t.resolved_at, t.closed_at, t.reporter_id
           FROM tickets t WHERE t.id = ?`
        )
        .get(ticketId)
    : null;

  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  // Un ticket reabierto conserva la resolución anterior (tickets.js lo hace
  // explícito al limpiar), así que el filtro por estado es obligatorio: sin él
  // se podría publicar una solución obsoleta.
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return res.status(400).json({ error: 'Solo se puede crear un artículo desde un ticket resuelto o cerrado' });
  }
  if (!String(ticket.resolution ?? '').trim()) {
    return res.status(400).json({ error: 'El ticket no tiene una solución registrada' });
  }

  res.json({
    preview: {
      title: ticket.title,
      description: ticket.description,
      solution: ticket.resolution,
      keywords: '',
      category_id: ticket.category_id,
      ticket_number: ticket.ticket_number,
      ticket_id: ticket.id,
      resolution_category: ticket.resolution_category,
      root_cause: ticket.root_cause,
    },
  });
});

/** Listado público: solo artículos publicados. */
router.get('/', requirePermission('kb.view'), (req, res) => {
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  // Se fuerza el estado PUBLICADO aunque venga ?status= en la URL: el listado
  // público no es un canal para leer borradores ajenos.
  const clauses = ["a.status = 'PUBLISHED'", ...filters.clauses];
  const { page, perPage, offset } = pagination(req);
  res.json(runList(clauses, filters.params, sortClause(req.query.sort), { page, perPage, offset }, SUMMARY_SELECT));
});

router.get('/:id', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const article = readableArticle(req.user, id);
  // 404 (no 403) para no confirmar la existencia de un borrador ajeno.
  if (!article) return res.status(404).json({ error: 'Artículo no encontrado' });

  // El contador de visitas solo lo mueve el servidor, solo sobre artículos
  // publicados y nunca cuando el autor relee su propio trabajo.
  if (article.status === 'PUBLISHED' && article.author_id !== req.user.id) {
    db.prepare('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?').run(article.id);
    article.view_count += 1;
  }

  res.json({ article });
});

/**
 * Crea un artículo. SIEMPRE como DRAFT.
 *
 * `status`, `author_id`, `view_count`, `published_at` e `is_featured` arriving en
 * el cuerpo se IGNORAN: el autor sale de la sesión y el estado se cambia solo
 * mediante los endpoints de transición. No hay ninguna publicación automática.
 */
router.post('/', requirePermission('kb.create'), (req, res) => {
  const body = req.body || {};
  const title = safeStr(body.title);
  const summary = safeStr(body.summary);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const solution = typeof body.solution === 'string' ? body.solution.trim() : '';
  const keywords = normalizeKeywords(body.keywords);

  const check = validateArticleFields({ title, summary, description, solution });
  if (!check.ok) return res.status(400).json({ error: 'Datos inválidos', fields: check.fields });

  const category = resolveCategoryId(body.category_id === undefined ? null : body.category_id);
  if (!category.ok) return res.status(400).json({ error: category.error });

  if (duplicateExists({ title, authorId: req.user.id })) {
    return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
  }

  const info = db
    .prepare(
      `INSERT INTO kb_articles (title, summary, description, solution, keywords, category_id, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    // author_id SIEMPRE de la sesión. status queda en su DEFAULT 'DRAFT'.
    .run(title, summary, description, solution, keywords, category.categoryId, req.user.id);

  recordHistory(info.lastInsertRowid, req.user.id, 'CREATED', null, null, title);
  res.status(201).json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(info.lastInsertRowid) });
});

const FIELD_LABELS = {
  title: 'Título',
  summary: 'Resumen',
  description: 'Descripción',
  solution: 'Solución',
  keywords: 'Palabras clave',
  category_id: 'Categoría',
};

/**
 * Edita el contenido de un artículo.
 *
 * Lista blanca estricta: aunque el cuerpo traiga author_id, status, view_count,
 * published_at o is_featured, se ignoran. El estado solo cambia por /publish,
 * /unpublish y /archive.
 */
router.patch('/:id', requirePermission('kb.create'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id);
  // 404 en lugar de 403: no revelamos que existe un artículo ajeno.
  if (!existing || !canEdit(req.user, existing)) {
    return res.status(404).json({ error: 'Artículo no encontrado' });
  }

  const body = req.body || {};
  const title = body.title === undefined ? existing.title : safeStr(body.title);
  const summary = body.summary === undefined ? existing.summary : safeStr(body.summary);
  const description = body.description === undefined ? existing.description : String(body.description).trim();
  const solution = body.solution === undefined ? existing.solution : String(body.solution).trim();
  const keywords = body.keywords === undefined ? existing.keywords : normalizeKeywords(body.keywords);

  const check = validateArticleFields({ title, summary, description, solution });
  if (!check.ok) return res.status(400).json({ error: 'Datos inválidos', fields: check.fields });

  let categoryId = existing.category_id;
  if (body.category_id !== undefined) {
    const category = resolveCategoryId(body.category_id);
    if (!category.ok) return res.status(400).json({ error: category.error });
    categoryId = category.categoryId;
  }

  if (title !== existing.title && duplicateExists({ title, authorId: existing.author_id, excludeId: id })) {
    return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
  }

  db.prepare(
    `UPDATE kb_articles
     SET title = ?, summary = ?, description = ?, solution = ?, keywords = ?, category_id = ?, updated_at = ?
     WHERE id = ?`
  ).run(title, summary, description, solution, keywords, categoryId, nowIso(), id);

  // Un cambio de contenido sobre un artículo publicado NO lo despublica: sigue
  // visible con la versión anterior hasta que el autor vuelva a publicarlo.
  for (const field of ['title', 'summary', 'description', 'solution', 'keywords', 'category_id']) {
    if (String(existing[field] ?? '') !== String({ title, summary, description, solution, keywords, category_id }[field] ?? '')) {
      recordHistory(id, req.user.id, 'UPDATED', FIELD_LABELS[field], existing[field], { title, summary, description, solution, keywords, category_id }[field]);
    }
  }

  res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
});

/** Transiciones de estado. Un único helper para las cuatro rutas siguientes. */
function transition(handler, action, { from, to }) {
  return (req, res) => {
    const id = parseIntSafe(req.params.id);
    const existing = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id);
    if (!existing || !canTransition(req.user, existing)) {
      return res.status(404).json({ error: 'Artículo no encontrado' });
    }
    if (from && !from.includes(existing.status)) {
      return res.status(400).json({ error: `El artículo está en estado ${existing.status} y no admite esta acción` });
    }
    handler(existing, req, res, id, action, to);
  };
}

router.post(
  '/:id/publish',
  requirePermission('kb.create'),
  transition(
    (existing, req, res, id) => {
      if (duplicateExists({ title: existing.title, authorId: existing.author_id, excludeId: id })) {
        return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
      }
      const stamp = nowIso();
      db.prepare('UPDATE kb_articles SET status = ?, published_at = ?, updated_at = ? WHERE id = ?').run(
        'PUBLISHED', stamp, stamp, id
      );
      recordHistory(id, req.user.id, 'PUBLISHED', 'Estado', existing.status, 'PUBLISHED');
      return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
    },
    'PUBLISHED',
    { from: ['DRAFT', 'ARCHIVED'], to: 'PUBLISHED' }
  )
);

router.post(
  '/:id/unpublish',
  requirePermission('kb.create'),
  transition(
    (existing, req, res, id) => {
      db.prepare('UPDATE kb_articles SET status = ?, updated_at = ? WHERE id = ?').run('DRAFT', nowIso(), id);
      recordHistory(id, req.user.id, 'UNPUBLISHED', 'Estado', existing.status, 'DRAFT');
      return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
    },
    'DRAFT',
    { from: ['PUBLISHED'], to: 'DRAFT' }
  )
);

router.post(
  '/:id/archive',
  requirePermission('kb.create'),
  transition(
    (existing, req, res, id) => {
      db.prepare('UPDATE kb_articles SET status = ?, updated_at = ? WHERE id = ?').run('ARCHIVED', nowIso(), id);
      recordHistory(id, req.user.id, 'ARCHIVED', 'Estado', existing.status, 'ARCHIVED');
      return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
    },
    'ARCHIVED',
    { from: ['DRAFT', 'PUBLISHED'], to: 'ARCHIVED' }
  )
);

router.post('/:id/feature', requirePermission('kb.create'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id);
  if (!existing || !canTransition(req.user, existing)) {
    return res.status(404).json({ error: 'Artículo no encontrado' });
  }
  const featured = existing.is_featured ? 0 : 1;
  db.prepare('UPDATE kb_articles SET is_featured = ? WHERE id = ?').run(featured, id);
  recordHistory(id, req.user.id, featured ? 'FEATURED' : 'UNFEATURED', 'Destacado', existing.is_featured, featured);
  res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
});

router.get('/:id/history', requirePermission('kb.create'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id, author_id FROM kb_articles WHERE id = ?').get(id);
  if (!existing || !canEdit(req.user, existing)) {
    return res.status(404).json({ error: 'Artículo no encontrado' });
  }
  const rows = db
    .prepare(
      `SELECT h.*, u.name || ' ' || u.last_name AS user_name
       FROM kb_article_history h
       LEFT JOIN users u ON u.id = h.user_id
       WHERE h.article_id = ?
       ORDER BY h.id ASC`
    )
    .all(id);
  res.json({ data: rows });
});

// ------------------------------------------------------- relación con tickets

/**
 * Tickets enlazados a un artículo, filtrados por lo que el usuario puede ver.
 * `reporter_id` se usa para canViewTicket pero NUNCA se devuelve: se extrae
 * antes de responder.
 */
router.get('/:id/tickets', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_number, t.title, t.status, t.created_at, t.reporter_id,
              kba.created_at AS linked_at
       FROM kb_ticket_articles kba
       JOIN tickets t ON t.id = kba.ticket_id
       WHERE kba.article_id = ?
       ORDER BY kba.created_at DESC`
    )
    .all(id);

  const data = rows.filter((t) => canViewTicket(req.user, t)).map(({ reporter_id, ...rest }) => rest);
  res.json({ data, total: data.length });
});

router.post('/:id/tickets/:ticketId', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticketId = parseIntSafe(req.params.ticketId);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const ticket = ticketId ? db.prepare('SELECT id, reporter_id FROM tickets WHERE id = ?').get(ticketId) : null;
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  if (db.prepare('SELECT 1 AS x FROM kb_ticket_articles WHERE article_id = ? AND ticket_id = ?').get(id, ticketId)) {
    return res.status(409).json({ error: 'El artículo ya está enlazado a este ticket' });
  }
  db.prepare('INSERT INTO kb_ticket_articles (article_id, ticket_id, created_by) VALUES (?, ?, ?)').run(
    id, ticketId, req.user.id
  );
  res.status(201).json({ data: { article_id: id, ticket_id: ticketId } });
});

router.delete('/:id/tickets/:ticketId', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticketId = parseIntSafe(req.params.ticketId);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const ticket = ticketId ? db.prepare('SELECT id, reporter_id FROM tickets WHERE id = ?').get(ticketId) : null;
  if (!ticket || !canViewTicket(req.user, ticket)) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  db.prepare('DELETE FROM kb_ticket_articles WHERE article_id = ? AND ticket_id = ?').run(id, ticketId);
  res.json({ ok: true });
});

/**
 * Artículos publicados enlazados a un ticket. Se exporta para que
 * routes/tickets.js lo reutilice en GET /:id/articles aplicando la MISMA regla
 * de visibilidad, en vez de duplicar la consulta.
 */
export function visibleArticlesForTicket(user, ticketId) {
  return db
    .prepare(
      `${SUMMARY_SELECT}
       JOIN kb_ticket_articles kba ON kba.article_id = a.id
       WHERE kba.ticket_id = ? AND a.status = 'PUBLISHED'`
    )
    .all(ticketId);
}

// No existe DELETE /:id: archivar es la baja, para no destruir view_count ni el
// historial. Tampoco existe ninguna operación que modifique author_id,
// view_count o published_at desde el cuerpo de una petición.

export default router;
