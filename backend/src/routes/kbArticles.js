import express from 'express';
import db, { nowIso } from '../db.js';
import { safeStr, parseIntSafe } from '../utils/validation.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg, requireOrg } from '../middleware/org.js';
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

/** kb.manage: administra artículos de cualquier autor y en cualquier estado. */
function canModerate(user) {
  return hasPerm(user, 'kb.manage');
}

/**
 * ¿Puede este usuario leer este artículo?
 *
 * PUBLISHED   -> cualquiera con kb.view (garantizado por el middleware de ruta).
 * DRAFT/ARCHIVED -> solo su autor, o quien tenga kb.manage.
 *
 * Un borrador es privado por definición: ninguna ruta pública lo devuelve y
 * /:id responde 404 (nunca 403) para no confirmar que existe.
 */
function canRead(user, article) {
  if (!article) return false;
  // ETAPA 3: un artículo de otra organización no existe para el actor. La
  // barrera principal es el fetch por :id (`organization_id = ?`); esta
  // segunda comprobación cubre a quien importe un artículo por otra vía.
  const org = currentOrgId(user);
  if (!org || !article.organization_id) return false;
  if (Number(article.organization_id) !== Number(org)) return false;
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
 * El autor necesita kb.publish sobre SU artículo; sobre el de otro hace falta
 * kb.manage. Así un técnico nunca publica material ajeno sin un administrador.
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
 * claves heredadas de Object.prototype (constructor, toString, __proto__), que
 * son verdaderas y acabarían concatenadas en el ORDER BY provocando un 500.
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
  SELECT a.*, u.name || ' ' || u.last_name AS author_name,
         c.name AS category_name, c.color AS category_color
  FROM kb_articles a
  LEFT JOIN users u ON u.id = a.author_id
  LEFT JOIN kb_categories c ON c.id = a.category_id
`;

/** Búsqueda libre sobre los cinco campos de texto del artículo. */
function searchClause(alias, value) {
  const pattern = likePattern(value);
  const fields = ['title', 'summary', 'description', 'solution', 'keywords'];
  const parts = fields.map((f) => `LOWER(${alias}.${f}) LIKE ? ${SEARCH_ESCAPE}`);
  return { sql: `(${parts.join(' OR ')})`, params: fields.map(() => pattern) };
}

/** Normaliza page/perPage con los mismos topes que routes/tickets.js. */
function pagination(req) {
  const page = Math.max(parseIntSafe(req.query.page) || 1, 1);
  const perPage = Math.min(Math.max(parseIntSafe(req.query.perPage) || 15, 1), 100);
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Filtros compartidos por los tres listados (público, propio y de gestión).
 * Devuelve { clauses, params } o { error } si un valor no es válido.
 *
 * ETAPA 3: los artículos se listan SIEMPRE dentro de la organización del
 * contexto de sesión. Un SUPERADMIN global (org null) obtiene listas vacías.
 */
function filterClauses(req) {
  const clauses = ['a.organization_id = ?'];
  const params = [currentOrgId(req.user)];

  const q = safeStr(req.query.q);
  if (q) {
    const search = searchClause('a', q);
    clauses.push(search.sql);
    params.push(...search.params);
  }

  const categoryId = parseIntSafe(req.query.category);
  if (categoryId) {
    clauses.push('a.category_id = ?');
    params.push(categoryId);
  }

  if (req.query.featured === '1' || req.query.featured === 'true') {
    clauses.push('a.is_featured = 1');
  }

  const status = req.query.status ? String(req.query.status).toUpperCase() : '';
  if (status) {
    if (!ARTICLE_STATUSES.includes(status)) return { error: 'Estado no válido' };
    clauses.push('a.status = ?');
    params.push(status);
  }

  const authorId = parseIntSafe(req.query.author);
  if (authorId) {
    clauses.push('a.author_id = ?');
    params.push(authorId);
  }

  return { clauses, params };
}

/**
 * Cuenta y devuelve la página usando el MISMO where, para que el total nunca
 * incluya filas que el listado va a filtrar (fuga por paginación).
 */
function runList(clauses, params, order, { page, perPage, offset }) {
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM kb_articles a ${where}`).get(...params).n;
  const data = db
    .prepare(`${SUMMARY_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset);
  return { data, total, page, perPage, pages: Math.ceil(total / perPage) };
}

// ------------------------------------------------------------------ historial

/** Recorte legible para el historial: nunca el cuerpo completo del artículo. */
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
 * igual que is_active libera el de una plantilla. No se comprueba entre autores
 * distintos: dos técnicos documentando problemas parecidos con títulos parecidos
 * es legítimo; la base de conocimiento se orienta a la reutilización, no a la
 * deduplicación forzada.
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
 * Resuelve la categoría. Acepta null (sin categoría) y rechaza con 400 una
 * categoría inexistente o desactivada —o de otra organización—, para no dejar
 * artículos apuntando a un catálogo que el usuario no ve en los filtros.
 * ETAPA 3: la categoría debe pertenecer a la organización (del actor al crear,
 * del artículo al editar).
 */
function resolveCategoryId(value, organizationId) {
  if (value === null) return { ok: true, categoryId: null };
  const id = parseIntSafe(value);
  if (!id) return { ok: false, error: 'Categoría de conocimiento no válida' };
  const row = db.prepare('SELECT id FROM kb_categories WHERE id = ? AND active = 1 AND organization_id = ?').get(id, organizationId);
  if (!row) return { ok: false, error: 'La categoría de conocimiento no existe, está desactivada o no pertenece a su organización' };
  return { ok: true, categoryId: id };
}

// ------------------------------------------------------------------- artículos

/** Carga un artículo legible por el usuario, o null (el llamante responde 404). */
function readableArticle(user, id) {
  const row = db.prepare(`${DETAIL_SELECT} WHERE a.id = ? AND a.organization_id = ?`).get(id, currentOrgId(user));
  return canRead(user, row) ? row : null;
}

router.get('/mine', requirePermission('kb.create'), (req, res) => {
  // Artículos propios en cualquier estado, incluidos los archivados: es la
  // vista de trabajo del autor.
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  const clauses = ['a.author_id = ?', ...filters.clauses];
  const params = [req.user.id, ...filters.params];
  const page = pagination(req);
  res.json(runList(clauses, params, 'a.updated_at DESC, a.id DESC', page));
});

router.get('/manage', requirePermission('kb.manage'), (req, res) => {
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  res.json(runList(filters.clauses, filters.params, sortClause(req.query.sort), pagination(req)));
});

/**
 * Previsualización para crear un borrador desde un ticket resuelto.
 *
 * REGLA DE ORO: este endpoint NO escribe nada y devuelve una lista blanca
 * explícita de columnas. Nunca `t.*`, para que una columna sensible añadida a
 * `tickets` en el futuro no pueda colarse por descuido.
 *
 * NO devuelve: notas internas (ticket_comments.is_internal = 1), adjuntos
 * (tampoco los de notas internas), correo/usuario/teléfono del reportante,
 * motivos de pendiente, reapertura o cancelación, historial ni valoración CSAT.
 *
 * `description` sí se incluye: es la descripción del problema y el punto de
 * partida natural del artículo. Es texto libre que quien reportó pudo escribir,
 * así que el autor DEBE revisarlo antes de publicar; por eso el resultado es
 * siempre un borrador que nadie más ve.
 */
router.get('/from-ticket/:ticketId', requirePermission('kb.create'), (req, res) => {
  const ticketId = parseIntSafe(req.params.ticketId);
  const ticket = ticketId
    ? db
        .prepare(
          `SELECT t.id, t.ticket_number, t.title, t.description, t.resolution,
                  t.resolution_category, t.root_cause, t.category_id,
                  t.status, t.resolved_at, t.closed_at, t.reporter_id,
                  t.organization_id
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
      // `tickets.category_id` apunta a `categories` (tipo de incidencia), no a
      // `kb_categories` (tema de documentación): son dominios distintos y sus
      // identificadores no significan lo mismo. Prefijar aquí sugeriría una
      // equivalencia que no existe y publicaría el artículo en la categoría
      // equivocada, así que el autor elige la suya en el formulario.
      category_id: null,
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      // Datos de contexto, nunca asignables a un artículo.
      ticket_category_id: ticket.category_id,
      resolution_category: ticket.resolution_category,
      root_cause: ticket.root_cause,
    },
  });
});

/** Listado público: solo artículos publicados. */
router.get('/', requirePermission('kb.view'), (req, res) => {
  const filters = filterClauses(req);
  if (filters.error) return res.status(400).json({ error: filters.error });
  // Se fuerza PUBLISHED aunque venga ?status= en la URL: el listado público no
  // es un canal para leer borradores ajenos.
  const clauses = ["a.status = 'PUBLISHED'", ...filters.clauses];
  res.json(runList(clauses, filters.params, sortClause(req.query.sort), pagination(req)));
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
 * status, author_id, view_count, published_at e is_featured que lleguen en el
 * cuerpo se IGNORAN: el autor sale de la sesión y el estado solo cambia por los
 * endpoints de transición. No hay ninguna publicación automática.
 */
router.post('/', requirePermission('kb.create'), requireOrg, (req, res) => {
  const body = req.body || {};
  const rejected = rejectClientOrg(body);
  if (rejected) return res.status(400).json({ error: rejected });
  const organizationId = currentOrgId(req.user);
  const title = safeStr(body.title);
  const summary = safeStr(body.summary);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const solution = typeof body.solution === 'string' ? body.solution.trim() : '';
  const keywords = normalizeKeywords(body.keywords);

  const check = validateArticleFields({ title, summary, description, solution });
  if (!check.ok) return res.status(400).json({ error: 'Datos inválidos', fields: check.fields });

  const category = resolveCategoryId(body.category_id === undefined ? null : body.category_id, organizationId);
  if (!category.ok) return res.status(400).json({ error: category.error });

  if (duplicateExists({ title, authorId: req.user.id })) {
    return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
  }

  const info = db
    .prepare(
      `INSERT INTO kb_articles (title, summary, description, solution, keywords, category_id, author_id, organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // author_id y organization_id SIEMPRE de la sesión; status queda en su DEFAULT 'DRAFT'.
    .run(title, summary, description, solution, keywords, category.categoryId, req.user.id, organizationId);

  recordHistory(info.lastInsertRowid, req.user.id, 'CREATED', null, null, title);
  res.status(201).json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(info.lastInsertRowid) });
});

const EDITABLE_FIELDS = ['title', 'summary', 'description', 'solution', 'keywords', 'category_id'];

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
  const existing = db.prepare('SELECT * FROM kb_articles WHERE id = ? AND organization_id = ?').get(id, currentOrgId(req.user));
  // 404 en lugar de 403: no revelamos que existe un artículo ajeno.
  if (!existing || !canEdit(req.user, existing)) {
    return res.status(404).json({ error: 'Artículo no encontrado' });
  }

  const body = req.body || {};
  const rejected = rejectClientOrg(body);
  if (rejected) return res.status(400).json({ error: rejected });
  const next = {
    title: body.title === undefined ? existing.title : safeStr(body.title),
    summary: body.summary === undefined ? existing.summary : safeStr(body.summary),
    description: body.description === undefined ? existing.description : String(body.description).trim(),
    solution: body.solution === undefined ? existing.solution : String(body.solution).trim(),
    keywords: body.keywords === undefined ? existing.keywords : normalizeKeywords(body.keywords),
  };

  const check = validateArticleFields(next);
  if (!check.ok) return res.status(400).json({ error: 'Datos inválidos', fields: check.fields });

  if (body.category_id !== undefined) {
    const category = resolveCategoryId(body.category_id, existing.organization_id);
    if (!category.ok) return res.status(400).json({ error: category.error });
    next.category_id = category.categoryId;
  } else {
    next.category_id = existing.category_id;
  }

  if (next.title !== existing.title && duplicateExists({ title: next.title, authorId: existing.author_id, excludeId: id })) {
    return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
  }

  db.prepare(
    `UPDATE kb_articles
     SET title = ?, summary = ?, description = ?, solution = ?, keywords = ?, category_id = ?, updated_at = ?
     WHERE id = ?`
  ).run(next.title, next.summary, next.description, next.solution, next.keywords, next.category_id, nowIso(), id);

  // Un cambio de contenido sobre un artículo publicado NO lo despublica: sigue
  // visible hasta que el autor vuelva a publicarlo.
  for (const field of EDITABLE_FIELDS) {
    if (String(existing[field] ?? '') !== String(next[field] ?? '')) {
      recordHistory(id, req.user.id, 'UPDATED', FIELD_LABELS[field], existing[field], next[field]);
    }
  }

  res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
});

/** Guard común de las transiciones: valida permiso y estado de origen. */
function transition(fromStatuses, action, apply) {
  return (req, res) => {
    const id = parseIntSafe(req.params.id);
    const existing = db.prepare('SELECT * FROM kb_articles WHERE id = ? AND organization_id = ?')
      .get(id, currentOrgId(req.user));
    if (!existing || !canTransition(req.user, existing)) {
      return res.status(404).json({ error: 'Artículo no encontrado' });
    }
    if (fromStatuses && !fromStatuses.includes(existing.status)) {
      return res.status(400).json({ error: `El artículo está en estado ${existing.status} y no admite esta acción` });
    }
    apply(existing, req, res, id, action);
  };
}

const TRANSITION_GUARD = requireAnyPermission(['kb.publish', 'kb.manage']);

router.post(
  '/:id/publish',
  TRANSITION_GUARD,
  transition(['DRAFT', 'ARCHIVED'], 'PUBLISHED', (existing, req, res, id, action) => {
    if (duplicateExists({ title: existing.title, authorId: existing.author_id, excludeId: id })) {
      return res.status(409).json({ error: 'Ya tienes un artículo con ese título' });
    }
    const stamp = nowIso();
    db.prepare('UPDATE kb_articles SET status = ?, published_at = ?, updated_at = ? WHERE id = ?').run(
      'PUBLISHED', stamp, stamp, id
    );
    recordHistory(id, req.user.id, action, 'Estado', existing.status, 'PUBLISHED');
    return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
  })
);

router.post(
  '/:id/unpublish',
  TRANSITION_GUARD,
  transition(['PUBLISHED'], 'UNPUBLISHED', (existing, req, res, id, action) => {
    db.prepare('UPDATE kb_articles SET status = ?, updated_at = ? WHERE id = ?').run('DRAFT', nowIso(), id);
    recordHistory(id, req.user.id, action, 'Estado', existing.status, 'DRAFT');
    return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
  })
);

router.post(
  '/:id/archive',
  TRANSITION_GUARD,
  transition(['DRAFT', 'PUBLISHED'], 'ARCHIVED', (existing, req, res, id, action) => {
    db.prepare('UPDATE kb_articles SET status = ?, updated_at = ? WHERE id = ?').run('ARCHIVED', nowIso(), id);
    recordHistory(id, req.user.id, action, 'Estado', existing.status, 'ARCHIVED');
    return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
  })
);

router.post(
  '/:id/feature',
  TRANSITION_GUARD,
  transition(null, null, (existing, req, res, id) => {
    const featured = existing.is_featured ? 0 : 1;
    db.prepare('UPDATE kb_articles SET is_featured = ? WHERE id = ?').run(featured, id);
    recordHistory(id, req.user.id, featured ? 'FEATURED' : 'UNFEATURED', 'Destacado', existing.is_featured, featured);
    return res.json({ article: db.prepare(`${DETAIL_SELECT} WHERE a.id = ?`).get(id) });
  })
);

router.get('/:id/history', requireAnyPermission(['kb.create', 'kb.manage']), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const existing = db.prepare('SELECT id, author_id FROM kb_articles WHERE id = ? AND organization_id = ?').get(id, currentOrgId(req.user));
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
 * reporter_id se usa para canViewTicket pero NUNCA se devuelve: se elimina
 * antes de responder.
 */
router.get('/:id/tickets', requirePermission('kb.view'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const rows = db
    .prepare(
      `SELECT t.id, t.ticket_number, t.title, t.status, t.created_at, t.reporter_id,
              t.organization_id, kba.created_at AS linked_at
       FROM kb_ticket_articles kba
       JOIN tickets t ON t.id = kba.ticket_id
       WHERE kba.article_id = ?
       ORDER BY kba.created_at DESC`
    )
    .all(id);

  const data = rows.filter((t) => canViewTicket(req.user, t)).map(({ reporter_id, ...rest }) => rest);
  res.json({ data, total: data.length });
});

/**
 * Enlazar y desenlazar ES una escritura, no una lectura: exige kb.create.
 * Con kb.view bastaba para que un empleado de solo lectura modificara el
 * contenido de un ticket, lo que contradice el resto del módulo (editar exige
 * kb.create, publicar exige kb.publish).
 */
router.post('/:id/tickets/:ticketId', requirePermission('kb.create'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticketId = parseIntSafe(req.params.ticketId);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const ticket = ticketId ? db.prepare('SELECT id, reporter_id, organization_id FROM tickets WHERE id = ?').get(ticketId) : null;
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

router.delete('/:id/tickets/:ticketId', requirePermission('kb.create'), (req, res) => {
  const id = parseIntSafe(req.params.id);
  const ticketId = parseIntSafe(req.params.ticketId);
  if (!readableArticle(req.user, id)) return res.status(404).json({ error: 'Artículo no encontrado' });

  const ticket = ticketId ? db.prepare('SELECT id, reporter_id, organization_id FROM tickets WHERE id = ?').get(ticketId) : null;
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
      `SELECT a.id, a.title, a.summary, a.keywords, a.status, a.category_id,
              a.author_id, a.is_featured, a.view_count, a.published_at,
              a.created_at, a.updated_at,
              u.name || ' ' || u.last_name AS author_name,
              c.name AS category_name, c.color AS category_color
       FROM kb_ticket_articles kba
       JOIN kb_articles a ON a.id = kba.article_id
       LEFT JOIN users u ON u.id = a.author_id
       LEFT JOIN kb_categories c ON c.id = a.category_id
       WHERE kba.ticket_id = ? AND a.status = 'PUBLISHED'
         AND a.organization_id = ?`
    )
    .all(ticketId, currentOrgId(user));
}

// No existe DELETE /:id: archivar es la baja, para no destruir view_count ni el
// historial. Tampoco existe ninguna operación que modifique author_id,
// view_count o published_at desde el cuerpo de una petición.

export default router;
