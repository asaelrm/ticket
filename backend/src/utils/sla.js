import db, { contract as defaultContract } from '../db.js';

// Regla de SLA por defecto (horas para resolver según prioridad).
// Se puede sobrescribir desde Configuración (tabla settings, claves sla_*_hours).
const DEFAULT_SLA_HOURS = { CRITICAL: 4, HIGH: 24, MEDIUM: 48, LOW: 72 };

const SLA_KEYS = {
  sla_critical_hours: 'CRITICAL',
  sla_high_hours: 'HIGH',
  sla_medium_hours: 'MEDIUM',
  sla_low_hours: 'LOW',
};

function mergeHours(rows, keyOf) {
  const hours = { ...DEFAULT_SLA_HOURS };
  for (const row of rows) {
    const key = SLA_KEYS[keyOf(row)];
    const value = parseInt(String(row.value), 10);
    if (key && Number.isFinite(value) && value >= 0) hours[key] = value;
  }
  return hours;
}

export function getSlaHours() {
  const rows = db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(SLA_KEYS).map(() => '?').join(',')})`)
    .all(...Object.keys(SLA_KEYS));
  return mergeHours(rows, (row) => row.key);
}

/**
 * Misma lectura por el contrato async, para el camino MSSQL: `db.prepare` no
 * existe con DB_CLIENT=mssql y esta función se llama dentro de la rama que sí
 * usa el contrato. `[key]` es obligatorio en SQL Server (KEY es palabra
 * reservada); SQLite acepta igualmente la cita entre corchetes.
 */
export async function getSlaHoursAsync(dataContract = defaultContract) {
  const keys = Object.keys(SLA_KEYS);
  const rows = await dataContract.queryMany(
    `SELECT [key] AS key_name, value FROM settings WHERE [key] IN (${keys.map((_, i) => `@k${i}`).join(', ')})`,
    Object.fromEntries(keys.map((key, i) => [`k${i}`, key])),
  );
  return mergeHours(rows, (row) => row.key_name);
}

export const DEFAULT_SLA = { ...DEFAULT_SLA_HOURS };

/**
 * Fecha límite (ISO) con las horas ya resueltas. Compartida por ambas
 * variantes de `computeSlaDue` para que la regla (y su fallback a MEDIUM)
 * viva en un solo sitio; el camino MSSQL no puede llamar a `getSlaHours()`
 * porque esa lectura síncrona revienta con DB_CLIENT=mssql.
 */
export function computeSlaDueWithHours(priority, hours, from = new Date()) {
  const effHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SLA_HOURS.MEDIUM;
  return new Date(from.getTime() + effHours * 60 * 60 * 1000).toISOString();
}

// Devuelve la fecha límite (ISO) calculada desde `from` según la prioridad.
export function computeSlaDue(priority, from = new Date()) {
  return computeSlaDueWithHours(priority, getSlaHours()[priority], from);
}

export const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

// Ventana de "próximo a vencer" (SLA_DUE_SOON / `?sla=due_soon`). Es una sola
// constante compartida porque el mismo concepto se calcula en tres sitios:
// /api/dashboard/sla, /api/dashboard/needs-attention y el filtro `?sla=due_soon`
// de /api/tickets. Con el número repetido en cada uno, cambiarlo en un sitio
// dejaba el tablero diciendo una cosa y el listado otra, sin que ningún test
// fallara. Importarla desde aquí es lo que hace que no puedan divergir.
export const SLA_AT_RISK_HOURS = 24;

// Fecha ISO límite de esa ventana, en el instante actual.
export function slaAtRiskUntilIso(now = Date.now()) {
  return new Date(now + SLA_AT_RISK_HOURS * 3600000).toISOString();
}