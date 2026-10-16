import { getSetting } from './settingsStore.js';
import { getSlaHours } from './sla.js';
import {
  DEFAULT_RESOLUTION_CATEGORIES,
  DEFAULT_ROOT_CAUSES,
  DEFAULT_PENDING_REASONS,
} from './settings.js';

export { DEFAULT_RESOLUTION_CATEGORIES, DEFAULT_ROOT_CAUSES, DEFAULT_PENDING_REASONS };

// V1: todas las lecturas reciben la organización a la que se aplican. El
// parámetro es SIEMPRE contexto de servidor (la organización del ticket o la
// del usuario en sesión), nunca un dato de la petición. Sin organización
// (SUPERADMIN global) se resuelve la capa global, que es el comportamiento
// previo a la multiempresa.
async function listSetting(key, defaults, organizationId) {
  const raw = await getSetting(key, organizationId);
  if (!raw) return [...defaults];
  let parts = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parts = parsed;
  } catch {
    parts = [];
  }
  if (!parts.length) parts = String(raw).split(',');
  const clean = parts.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : [...defaults];
}

export async function getResolutionCategories(organizationId = null) {
  return listSetting('resolution_categories', DEFAULT_RESOLUTION_CATEGORIES, organizationId);
}

export async function getRootCauses(organizationId = null) {
  return listSetting('root_causes', DEFAULT_ROOT_CAUSES, organizationId);
}

export async function getPendingReasons(organizationId = null) {
  return listSetting('pending_reasons', DEFAULT_PENDING_REASONS, organizationId);
}

export async function requireResolutionToClose(organizationId = null) {
  const raw = await getSetting('require_resolution_to_close', organizationId);
  if (raw === null || raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

// Configuración de reglas de escalación automática (con valores por defecto).
export async function getRuleSettings(organizationId = null) {
  const num = async (key, fallback) => {
    const n = parseInt(String((await getSetting(key, organizationId)) ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    rule_unassigned_hours: await num('rule_unassigned_hours', 8),
    rule_unassigned_priority: String(
      (await getSetting('rule_unassigned_priority', organizationId)) || 'HIGH',
    ).toUpperCase(),
    rule_critical_hours: await num('rule_critical_hours', 12),
  };
}

export async function isCsatEnabled(organizationId = null) {
  const raw = await getSetting('enable_csat', organizationId);
  if (raw === null || raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

export async function getWorkflowOptions(organizationId = null) {
  return {
    resolution_categories: await getResolutionCategories(organizationId),
    root_causes: await getRootCauses(organizationId),
    pending_reasons: await getPendingReasons(organizationId),
    require_resolution_to_close: await requireResolutionToClose(organizationId),
    csat_enabled: await isCsatEnabled(organizationId),
    rules: await getRuleSettings(organizationId),
    sla_hours: await getSlaHours(organizationId),
  };
}
