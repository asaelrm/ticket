// Contrato de longitudes y validación de los artículos de la base de conocimiento.
//
// Estos límites son la misma fuente de verdad que valida el cliente y que
// replican los CHECK de schema.sql. Si se cambia alguno hay que actualizar los
// tres sitios: la constante de aquí, el CHECK de la tabla y el `maxLength` del
// formulario.
//
// El contenido se almacena VERBATIM. El servidor no escapa ni interpreta el
// Markdown: el escapado ocurre al renderizar en el navegador, igual que en
// canned_responses.body. Guardar el texto crudo es lo que permite que el cliente
// muestre exactamente lo que el autor escribió.

export const MAX_ARTICLE_TITLE = 200;
export const MAX_ARTICLE_SUMMARY = 500;
export const MAX_ARTICLE_DESCRIPTION = 20000;
export const MAX_ARTICLE_SOLUTION = 20000;
export const MAX_ARTICLE_KEYWORDS = 200;

export const ARTICLE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/** Estados en los que el artículo tiene efecto público (lo ven quienes tienen kb.view). */
export const PUBLIC_STATUSES = ['PUBLISHED'];

/**
 * Normaliza las palabras clave: recorta, colapsa espacios y limita la longitud.
 * Se guardan como texto plano separado por comas; no hay tabla de tags en esta
 * versión porque el filtro por palabra clave es una búsqueda LIKE.
 * @param {string} raw
 * @returns {string} cadena normalizada, o '' si no queda nada
 */
export function normalizeKeywords(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text
    .split(',')
    .map((k) => k.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
  return cleaned.slice(0, MAX_ARTICLE_KEYWORDS);
}

/**
 * Valida los campos de contenido de un artículo.
 * Devuelve el mismo contrato que validateTemplateBody() ({ ok, fields }) para
 * que ambas rutas puedan reportar el error de la misma manera.
 * @param {{ title?: string, summary?: string, description?: string, solution?: string }} fields
 * @returns {{ ok: boolean, fields?: Record<string,string> }}
 */
export function validateArticleFields(fields) {
  const errors = {};

  const check = (value, max, label) => {
    const text = String(value ?? '');
    if (!text.trim()) errors[label] = `${label} es obligatorio`;
    else if (text.length > max) errors[label] = `${label} no debe exceder ${max} caracteres`;
  };

  check(fields.title, MAX_ARTICLE_TITLE, 'El título');
  check(fields.summary, MAX_ARTICLE_SUMMARY, 'El resumen');
  check(fields.description, MAX_ARTICLE_DESCRIPTION, 'La descripción');
  check(fields.solution, MAX_ARTICLE_SOLUTION, 'La solución');

  if (Object.keys(errors).length) return { ok: false, fields: errors };
  return { ok: true };
}
