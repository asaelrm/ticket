import { getSetting } from './settingsStore.js';
import { DEFAULT_SLA } from './settings.js';

// Regla de SLA por defecto (horas para resolver según prioridad).
// Se puede sobrescribir desde Configuración: claves sla_*_hours, ahora POR
// ORGANIZACIÓN (V1). `organizationId` es contexto de servidor: la organización
// del ticket que se está creando/modificando, nunca un dato del cliente.
//
// Los valores por defecto viven en utils/settings.js (hoja sin importaciones)
// para no cerrar el ciclo settings → sla → settingsStore → settings.
export { DEFAULT_SLA };

const SLA_KEYS = {
  sla_critical_hours: 'CRITICAL',
  sla_high_hours: 'HIGH',
  sla_medium_hours: 'MEDIUM',
  sla_low_hours: 'LOW',
};

export async function getSlaHours(organizationId = null) {
  const hours = { ...DEFAULT_SLA };
  for (const [key, priority] of Object.entries(SLA_KEYS)) {
    const value = parseInt(String((await getSetting(key, organizationId)) ?? ''), 10);
    if (Number.isFinite(value) && value >= 0) hours[priority] = value;
  }
  return hours;
}

// Devuelve la fecha límite (ISO) calculada desde `from` según la prioridad y
// las horas SLA de la organización del ticket.
export async function computeSlaDue(priority, from = new Date(), organizationId = null) {
  const hours = (await getSlaHours(organizationId))[priority];
  const effHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SLA.MEDIUM;
  return new Date(from.getTime() + effHours * 60 * 60 * 1000).toISOString();
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