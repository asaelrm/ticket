import {
  DEFAULT_RESOLUTION_CATEGORIES,
  DEFAULT_ROOT_CAUSES,
  DEFAULT_PENDING_REASONS,
} from './options.js';
import { DEFAULT_SLA } from './sla.js';

// Catalog and policy for multi-organization settings. This module deliberately
// has no database dependency. A future repository supplies values to resolveSetting.
// Future SQLite legacy -> MSSQL parity will locate UCE by stable identity, copy
// only ORG_KEYS, and never overwrite existing overrides.
export const GLOBAL_KEYS = ['app_name', 'ticket_prefix'];

export const ORG_KEYS = [
  'company_name', 'footer_text', 'sla_critical_hours', 'sla_high_hours',
  'sla_medium_hours', 'sla_low_hours', 'resolution_categories', 'root_causes',
  'pending_reasons', 'require_resolution_to_close', 'notify_on_assign',
  'notify_on_comment', 'notify_on_resolve', 'notify_on_create', 'notify_on_status',
  'notify_on_close', 'enable_csat', 'rule_unassigned_hours',
  'rule_unassigned_priority', 'rule_critical_hours',
];

export const ALL_KEYS = [...GLOBAL_KEYS, ...ORG_KEYS];

export function isGlobalSetting(key) {
  return GLOBAL_KEYS.includes(key);
}

export function isOrgSetting(key) {
  return ORG_KEYS.includes(key);
}

export function isKnownSetting(key) {
  return isGlobalSetting(key) || isOrgSetting(key);
}

export const DEFAULT_SETTINGS = {
  app_name: '', ticket_prefix: 'TCK', company_name: '', footer_text: '',
  sla_critical_hours: String(DEFAULT_SLA.CRITICAL),
  sla_high_hours: String(DEFAULT_SLA.HIGH),
  sla_medium_hours: String(DEFAULT_SLA.MEDIUM),
  sla_low_hours: String(DEFAULT_SLA.LOW),
  resolution_categories: JSON.stringify(DEFAULT_RESOLUTION_CATEGORIES),
  root_causes: JSON.stringify(DEFAULT_ROOT_CAUSES),
  pending_reasons: JSON.stringify(DEFAULT_PENDING_REASONS),
  require_resolution_to_close: '1', notify_on_assign: '1', notify_on_comment: '1',
  notify_on_resolve: '1', notify_on_create: '1', notify_on_status: '1',
  notify_on_close: '1', enable_csat: '1', rule_unassigned_hours: '8',
  rule_unassigned_priority: 'HIGH', rule_critical_hours: '12',
};

export function settingDefault(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) ? DEFAULT_SETTINGS[key] : null;
}

// organizationId must derive from trusted server context. null/undefined never
// enables an organization override. Global keys always ignore organizationValue.
export function resolveSetting({ organizationId, key, organizationValue = null, globalValue = null } = {}) {
  if (isOrgSetting(key)) {
    if (organizationId !== null && organizationId !== undefined && organizationValue !== null && organizationValue !== undefined) {
      return organizationValue;
    }
    if (globalValue !== null && globalValue !== undefined) return globalValue;
    return settingDefault(key);
  }
  if (isGlobalSetting(key)) {
    if (globalValue !== null && globalValue !== undefined) return globalValue;
    return settingDefault(key);
  }
  return null;
}
