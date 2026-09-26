// Catálogo de variables y contrato de longitudes de las respuestas rápidas.
//
// La sustitución de variables ocurre EXCLUSIVAMENTE en el navegador, sobre el
// ticket que el usuario ya tiene cargado en memoria. El servidor nunca expande
// una plantilla ni consulta datos de otros tickets: aquí solo se define el
// catálogo (allowlist), la detección de variables desconocidas y los límites de
// longitud, que son las mismas reglas que valida el cliente.

export const MAX_TEMPLATE_BODY = 2000;
export const MAX_TEMPLATE_TITLE = 100;
// Mismo límite que aplica processComment() al mensaje del comentario.
export const MAX_COMMENT_LENGTH = 4000;
// Tope por valor interpolado: evita que un título largo desborde el comentario.
export const MAX_VARIABLE_VALUE = 200;

export const TEMPLATE_VARIABLES = [
  { key: 'ticket_number', label: 'Número de ticket' },
  { key: 'ticket_title', label: 'Título del ticket' },
  { key: 'reporter_name', label: 'Nombre de quien reporta' },
  { key: 'ticket_status', label: 'Estado del ticket' },
  { key: 'ticket_priority', label: 'Prioridad del ticket' },
  { key: 'category_name', label: 'Categoría' },
  { key: 'department_name', label: 'Departamento' },
  { key: 'team_name', label: 'Equipo asignado' },
  { key: 'technician_name', label: 'Nombre del técnico' },
  { key: 'sla_due', label: 'Vencimiento de SLA' },
];

export const TEMPLATE_VARIABLE_KEYS = TEMPLATE_VARIABLES.map((v) => v.key);

const ALLOWED = new Set(TEMPLATE_VARIABLE_KEYS);

// Solo se aceptan identificadores simples en minúsculas. No hay evaluación de
// expresiones ni acceso a objetos: `{{constructor}}` o `{{__proto__}}` no
// aparecen en la allowlist y quedan como texto literal.
const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;

/**
 * Separa las variables usadas de las desconocidas en el cuerpo de una plantilla.
 * @param {string} text
 * @returns {{ used: string[], unknown: string[] }}
 */
export function extractTemplateVariables(text) {
  const used = [];
  const unknown = [];
  const raw = String(text ?? '');
  for (const match of raw.matchAll(TOKEN_RE)) {
    const key = match[1];
    const bucket = ALLOWED.has(key) ? used : unknown;
    if (!bucket.includes(key)) bucket.push(key);
  }
  return { used, unknown };
}

/**
 * Valida el cuerpo de una plantilla: no vacío, dentro del máximo y sin
 * variables fuera del catálogo.
 * @param {string} body
 * @returns {{ ok: boolean, error?: string, fields?: Record<string,string>, unknown?: string[] }}
 */
export function validateTemplateBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) {
    return { ok: false, fields: { body: 'El cuerpo de la plantilla es obligatorio' } };
  }
  if (text.length > MAX_TEMPLATE_BODY) {
    return {
      ok: false,
      fields: { body: `El cuerpo no debe exceder ${MAX_TEMPLATE_BODY} caracteres` },
    };
  }
  return { ok: true, unknown: extractTemplateVariables(text).unknown };
}
