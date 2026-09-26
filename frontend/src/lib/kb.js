// Contrato del cliente de la base de conocimiento.
//
// Este archivo es el ÚNICO sitio donde se decide qué acción puede ver un
// usuario. Replica las reglas de backend/src/routes/kbArticles.js:
//
//   canRead       artículo publicado para cualquiera con kb.view; un borrador o
//                 un archivado solo para su autor o para quien tenga kb.manage.
//   canEdit       kb.create Y (es el autor O kb.manage).
//   canTransition kb.manage O (es el autor Y kb.publish).
//
// IMPORTANTE: esto es una comodidad de la interfaz, NO una barrera de
// seguridad. Ocultar un botón no protege un recurso: el servidor vuelve a
// comprobar el permiso en cada petición y responde 404 a un borrador ajeno.
// Sirve para no ofrecer acciones que el servidor va a rechazar.

export const ARTICLE_STATUS_LABEL = {
  DRAFT: 'Borrador',
  PUBLISHED: 'Publicado',
  ARCHIVED: 'Archivado',
};

export const ARTICLE_STATUS_COLOR = {
  DRAFT: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  PUBLISHED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  ARCHIVED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

/** Órdenes aceptados por GET /api/kb-articles (SORTS en kbArticles.js). */
export const ARTICLE_SORTS = [
  ['recent', 'Más recientes'],
  ['popular', 'Más consultados'],
  ['title', 'Título (A-Z)'],
];

// Tamaño de página por defecto del cliente. NO coincide con el 15 de
// pagination() en kbArticles.js: por eso toQuery() lo envía SIEMPRE de forma
// explícita y la URL solo lo guarda cuando el usuario lo cambia. Así el
// selector de la interfaz (10/25/50/100) nunca muestra un valor que el
// servidor no está aplicando.
export const DEFAULT_KB_PERPAGE = 10;

/**
 * Límites de longitud. Deben coincidir con MAX_ARTICLE_* de
 * backend/src/utils/articleLimits.js y con los CHECK de schema.sql: son la
 * misma constante en el esquema, en el servidor y en los formularios. El
 * `maxLength` evita el error tonto; la validación del servidor sigue siendo la
 * que manda, porque el límite del HTML no se puede eludir.
 */
export const ARTICLE_LIMITS = {
  title: 200,
  summary: 500,
  description: 20000,
  solution: 20000,
  keywords: 200,
};

function has(user, code) {
  return !!user && !!user.permissions?.includes(code);
}

/** ¿Puede este usuario leer este artículo? (mismo criterio que el servidor) */
export function canReadArticle(user, article) {
  if (!article) return false;
  if (article.status === 'PUBLISHED') return true;
  return article.author_id === user?.id || has(user, 'kb.manage');
}

/** ¿Puede editar el contenido? Exige kb.create, igual que PATCH /:id. */
export function canEditArticle(user, article) {
  if (!article) return false;
  if (!has(user, 'kb.create')) return false;
  return article.author_id === user?.id || has(user, 'kb.manage');
}

/** ¿Puede cambiar el estado? Exige kb.manage, o ser autor con kb.publish. */
export function canTransitionArticle(user, article) {
  if (!article) return false;
  if (has(user, 'kb.manage')) return true;
  return article.author_id === user?.id && has(user, 'kb.publish');
}

/**
 * Transiciones de estado que tienen sentido desde el estado actual, ya filtradas
 * por permiso. Los estados de origen son los mismos que exige el servidor:
 * publicar desde DRAFT/ARCHIVED, despublicar desde PUBLISHED, archivar desde
 * DRAFT/PUBLISHED. El destacado funciona en cualquier estado.
 * @returns {Array<{ key: string, label: string, path: string, kind: 'primary'|'secondary'|'danger' }>}
 */
export function availableTransitions(user, article) {
  if (!article || !canTransitionArticle(user, article)) return [];
  const out = [];
  if (article.status === 'DRAFT' || article.status === 'ARCHIVED') {
    out.push({ key: 'publish', label: 'Publicar', path: `/api/kb-articles/${article.id}/publish`, kind: 'primary' });
  }
  if (article.status === 'PUBLISHED') {
    out.push({ key: 'unpublish', label: 'Volver a borrador', path: `/api/kb-articles/${article.id}/unpublish`, kind: 'secondary' });
  }
  if (article.status === 'DRAFT' || article.status === 'PUBLISHED') {
    out.push({ key: 'archive', label: 'Archivar', path: `/api/kb-articles/${article.id}/archive`, kind: 'danger' });
  }
  out.push({
    key: 'feature',
    label: article.is_featured ? 'Quitar destacado' : 'Destacar',
    path: `/api/kb-articles/${article.id}/feature`,
    kind: 'secondary',
  });
  return out;
}

/** Etiqueta de estado para la lista y la ficha. */
export function statusLabel(status) {
  return ARTICLE_STATUS_LABEL[status] || status;
}

/**
 * Convierte los filtros de la URL en la cadena de consulta de la API.
 * Se descartan los valores vacíos para no ensuciar la URL ni las claves de
 * caché de React Query.
 * @param {{ q?: string, category?: string|number, sort?: string, page?: number, perPage?: number }} filters
 * @returns {string}
 */
export function toQuery(filters = {}) {
  const sp = new URLSearchParams();
  if (filters.q) sp.set('q', filters.q);
  if (filters.category) sp.set('category', String(filters.category));
  if (filters.sort && filters.sort !== 'recent') sp.set('sort', filters.sort);
  if (filters.page && Number(filters.page) > 1) sp.set('page', String(Number(filters.page)));
  sp.set('perPage', String(Number(filters.perPage) || DEFAULT_KB_PERPAGE));
  return sp.toString();
}

/** Valores que ofrece el selector de "Mostrar" de Pagination. */
export const KB_PERPAGE_CHOICES = [10, 25, 50, 100];

/** Lee los filtros desde la URL aplicando los valores por defecto. */
export function parseFilters(params) {
  const get = (k) => params.get(k) || '';
  // Un perPage escrito a mano se ajusta al valor por defecto si no es uno de los
  // que ofrece el selector: el servidor lo limitaría a 100 y el `<select>` se
  // quedaría sin opción coincidente.
  const asked = Number(get('perPage'));
  const perPage = KB_PERPAGE_CHOICES.includes(asked) ? asked : DEFAULT_KB_PERPAGE;
  return {
    q: get('q'),
    category: get('category'),
    sort: get('sort') || 'recent',
    page: Math.max(Number(get('page')) || 1, 1),
    perPage,
  };
}

/**
 * Convierte un error de validación del servidor ({ fields }) en algo que se
 * pueda pintar junto a cada campo del formulario. Las claves son las etiquetas
 * en español que devuelve validateArticleFields().
 */
export function fieldErrors(err) {
  if (!err) return {};
  return err.fields || {};
}
