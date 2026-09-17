import db from '../db.js';

// Regla de SLA por defecto (horas para resolver según prioridad).
// Se puede sobrescribir desde Configuración (tabla settings, claves sla_*_hours).
const DEFAULT_SLA_HOURS = { CRITICAL: 4, HIGH: 24, MEDIUM: 48, LOW: 72 };

const SLA_KEYS = {
  sla_critical_hours: 'CRITICAL',
  sla_high_hours: 'HIGH',
  sla_medium_hours: 'MEDIUM',
  sla_low_hours: 'LOW',
};

export function getSlaHours() {
  const rows = db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${Object.keys(SLA_KEYS).map(() => '?').join(',')})`)
    .all(...Object.keys(SLA_KEYS));
  const hours = { ...DEFAULT_SLA_HOURS };
  for (const row of rows) {
    const key = SLA_KEYS[row.key];
    const value = parseInt(String(row.value), 10);
    if (key && Number.isFinite(value) && value >= 0) hours[key] = value;
  }
  return hours;
}

export const DEFAULT_SLA = { ...DEFAULT_SLA_HOURS };

// Devuelve la fecha límite (ISO) calculada desde `from` según la prioridad.
export function computeSlaDue(priority, from = new Date()) {
  const hours = getSlaHours()[priority];
  const effHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SLA_HOURS.MEDIUM;
  return new Date(from.getTime() + effHours * 60 * 60 * 1000).toISOString();
}

export const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];