import db from '../db.js';
import { getSlaHours } from './sla.js';

// Valores por defecto de las listas configurables del flujo de resolución.
export const DEFAULT_RESOLUTION_CATEGORIES = [
  'Configuración',
  'Reparación',
  'Reemplazo',
  'Instalación',
  'Actualización',
  'Capacitación',
  'Otro',
];

export const DEFAULT_ROOT_CAUSES = [
  'Falla de hardware',
  'Configuración',
  'Error de usuario',
  'Problema de red',
  'Software',
  'Permisos',
  'Desconocida',
  'Otra',
];

export const DEFAULT_PENDING_REASONS = [
  'Esperando usuario',
  'Esperando proveedor',
  'Esperando pieza/equipo',
  'Esperando autorización',
  'Otro',
];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function listSetting(key, defaults) {
  const raw = getSetting(key);
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

export function getResolutionCategories() {
  return listSetting('resolution_categories', DEFAULT_RESOLUTION_CATEGORIES);
}

export function getRootCauses() {
  return listSetting('root_causes', DEFAULT_ROOT_CAUSES);
}

export function getPendingReasons() {
  return listSetting('pending_reasons', DEFAULT_PENDING_REASONS);
}

export function requireResolutionToClose() {
  const raw = getSetting('require_resolution_to_close');
  if (raw === null || raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

// Configuración de reglas de escalación automática (con valores por defecto).
export function getRuleSettings() {
  const num = (key, fallback) => {
    const n = parseInt(String(getSetting(key) ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    rule_unassigned_hours: num('rule_unassigned_hours', 8),
    rule_unassigned_priority: String(getSetting('rule_unassigned_priority') || 'HIGH').toUpperCase(),
    rule_critical_hours: num('rule_critical_hours', 12),
  };
}

export function isCsatEnabled() {
  const raw = getSetting('enable_csat');
  if (raw === null || raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

export function getWorkflowOptions() {
  return {
    resolution_categories: getResolutionCategories(),
    root_causes: getRootCauses(),
    pending_reasons: getPendingReasons(),
    require_resolution_to_close: requireResolutionToClose(),
    csat_enabled: isCsatEnabled(),
    rules: getRuleSettings(),
    sla_hours: getSlaHours(),
  };
}
