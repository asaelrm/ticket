// Catálogo de variables de las respuestas rápidas y sustitución de una sola pasada.
//
// Debe mantenerse en sincronía con backend/src/utils/templateVars.js: ambas
// listas están cubiertas por pruebas. La sustitución ocurre aquí, en el
// navegador, sobre el ticket que el usuario ya tiene en memoria: el servidor
// nunca expande plantillas ni consulta datos de otros tickets.

import { STATUS_LABEL, PRIORITY_LABEL } from './api';

export const MAX_TEMPLATE_BODY = 2000;
export const MAX_COMMENT_LENGTH = 4000;
export const MAX_VARIABLE_VALUE = 200;

export const TEMPLATE_VARIABLES = [
  { key: 'ticket_number', label: 'Número de ticket', example: 'TCK-000123' },
  { key: 'ticket_title', label: 'Título del ticket', example: 'No imprime' },
  { key: 'reporter_name', label: 'Nombre de quien reporta', example: 'Ana Ruiz' },
  { key: 'ticket_status', label: 'Estado del ticket', example: 'En proceso' },
  { key: 'ticket_priority', label: 'Prioridad del ticket', example: 'Alta' },
  { key: 'category_name', label: 'Categoría', example: 'Hardware' },
  { key: 'department_name', label: 'Departamento', example: 'Operaciones' },
  { key: 'team_name', label: 'Equipo asignado', example: 'Soporte Nivel 1' },
  { key: 'technician_name', label: 'Nombre del técnico', example: 'Luis Pérez' },
  { key: 'sla_due', label: 'Vencimiento de SLA', example: '2026-09-30T18:00:00Z' },
];

export const TEMPLATE_VARIABLE_KEYS = TEMPLATE_VARIABLES.map((v) => v.key);

const ALLOWED = new Set(TEMPLATE_VARIABLE_KEYS);

// Identificadores simples en minúsculas. No hay evaluación de expresiones ni
// acceso a objetos del prototipo: `{{constructor}}` no está en la allowlist y
// queda como texto literal.
const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_VARIABLE_VALUE);
}

/**
 * Construye el contexto de sustitución a partir del ticket ya cargado y del
 * usuario de la sesión. Si falta un dato, la variable queda como cadena vacía.
 */
export function buildVariableContext({ ticket, user } = {}) {
  const t = ticket || {};
  return {
    ticket_number: normalize(t.ticket_number),
    ticket_title: normalize(t.title),
    reporter_name: normalize(t.reporter_name),
    ticket_status: normalize(STATUS_LABEL[t.status] || t.status),
    ticket_priority: normalize(PRIORITY_LABEL[t.priority] || t.priority),
    category_name: normalize(t.category_name),
    department_name: normalize(t.department_name),
    team_name: normalize(t.team_name),
    technician_name: normalize([user?.name, user?.last_name].filter(Boolean).join(' ')),
    sla_due: normalize(t.sla_due_at),
  };
}

/** Variables usadas y desconocidas presentes en el texto de la plantilla. */
export function extractVariables(text) {
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
 * Sustituye las variables del catálogo en una sola pasada.
 *
 * Los valores insertados NO se vuelven a escanear, de modo que un título que
 * contenga `{{...}}` no expande nada y no es posible encadenar sustituciones.
 * Una variable desconocida se deja literal para que el técnico la vea y corrija.
 *
 * @returns {{ text: string, unknown: string[] }}
 */
export function expandTemplate(text, context = {}) {
  const unknown = [];
  const expanded = String(text ?? '').replace(TOKEN_RE, (match, key) => {
    if (!ALLOWED.has(key)) {
      if (!unknown.includes(key)) unknown.push(key);
      return match;
    }
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
  return { text: expanded, unknown };
}
