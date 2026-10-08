import { AsyncLocalStorage } from 'node:async_hooks';
import db from '../db/runtime.js';
import { nowIso } from '../db.js';
import {
  GLOBAL_KEYS,
  ORG_KEYS,
  ALL_KEYS,
  isGlobalSetting,
  isOrgSetting,
  resolveSetting,
  settingDefault,
} from './settings.js';

// V1: repositorio de la configuración multiempresa.
//
// `utils/settings.js` es sólo el catálogo y la política (qué es global, qué es
// por organización y cómo se resuelve); este módulo es la única parte que toca
// las tablas. Las reglas que sostiene son:
//
//   - `settings`       -> capa GLOBAL (plataforma). Solo la escribe un
//                        SUPERADMIN. Es además el valor legacy que hereda
//                        cualquier organización que aún no tenga sobrescritura,
//                        así que una instalación existente no pierde nada.
//   - `org_settings`   -> sobrescritura POR ORGANIZACIÓN de las ORG_KEYS. Solo
//                        la escribe el administrador de ESA organización, con
//                        la organización tomada del contexto de sesión, nunca
//                        del cuerpo de la petición.
//
// Los GLOBAL_KEYS (app_name, ticket_prefix) jamás se leen de `org_settings`:
// resolveSetting los resuelve siempre contra el valor global, con lo que una
// organización no puede ni leer ni escribir una configuración que no es suya.

/** Valor global crudo de `key` (tabla `settings`). */
async function readGlobalValue(key) {
  const row = await db.queryOne('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}

/** Sobrescritura de `key` para la organización (tabla `org_settings`). */
async function readOrgValue(organizationId, key) {
  if (organizationId === null || organizationId === undefined) return null;
  const row = await db.queryOne(
    'SELECT value FROM org_settings WHERE organization_id = ? AND key = ?',
    organizationId,
    key,
  );
  return row ? row.value : null;
}

// Caché de lectura para una única pasada de mantenimiento (los jobs
// programados).
//
// V3/rendimiento: una vuelta de mantenimiento puede recorrer cientos de tickets
// y cada uno consulta las reglas de escalación y el SLA de SU organización.
// Sin caché eso son 6-14 SELECT por ticket sólo para repetir las mismas claves.
//
// Reglas de seguridad de la caché:
//   - Vive en un AsyncLocalStorage: solo la ve el flujo que abrió
//     `withSettingsCache` (incluidos los awaits dentro de su bloque), nunca
//     otra petición HTTP ni otro job que se intercale mientras dura la vuelta.
//   - Ningún código de escritura pasa por aquí (setGlobalSetting/setOrgSetting
//     no leen), por lo que una escritura dentro del bloque no queda enmascarada.
//   - Se limpia automáticamente al salir del flujo, aunque el bloque lance.
const settingsCacheContext = new AsyncLocalStorage();

export async function withSettingsCache(fn) {
  if (settingsCacheContext.getStore()) return fn();
  return settingsCacheContext.run(new Map(), fn);
}

/**
 * Valor efectivo de una clave para una organización.
 *
 * `organizationId` es SIEMPRE contexto de servidor (`currentOrgId(req.user)` o
 * `ticket.organization_id`): null significa "sin contexto", lo que en la
 * práctica sólo le pasa a un SUPERADMIN global y que nunca active sobrescritura
 * de la que no existe.
 */
export async function getSetting(key, organizationId = null) {
  if (!isOrgSetting(key) && !isGlobalSetting(key)) return null;
  const cache = settingsCacheContext.getStore();
  const cacheKey = (organizationId == null ? '' : String(organizationId)) + '|' + key;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
  const value = resolveSetting({
    organizationId,
    key,
    organizationValue: await readOrgValue(organizationId, key),
    globalValue: await readGlobalValue(key),
  });
  if (cache) cache.set(cacheKey, value);
  return value;
}

/** Mapa completo { key: valor efectivo } para la organización indicada. */
export async function getAllSettings(organizationId = null) {
  const out = {};
  for (const key of ALL_KEYS) out[key] = await getSetting(key, organizationId);
  return out;
}

/** Sólo los valores globales crudos, para el administrador global. */
export async function getGlobalSettings() {
  const rows = await db.queryMany('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Escribe una clave en la capa global. Uso reservado a SUPERADMIN: cambiar aquí
 * `sla_high_hours`, `enable_csat` o cualquier ORG_KEY afecta a toda organización
 * que no tenga su propia sobrescritura.
 */
export async function setGlobalSetting(key, value, updatedBy = null) {
  if (!isGlobalSetting(key) && !isOrgSetting(key)) return false;
  await db.execute(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key,
    value,
    updatedBy,
    nowIso(),
  );
  return true;
}

/**
 * Escribe una sobrescritura de `key` para UNA organización. Nunca se acepta un
 * organizationId que no venga del contexto de sesión.
 */
export async function setOrgSetting(organizationId, key, value, updatedBy = null) {
  if (organizationId === null || organizationId === undefined) {
    throw new Error('setOrgSetting requiere una organización de contexto');
  }
  if (!isOrgSetting(key)) {
    throw new Error(`La clave ${key} no es configurable por organización`);
  }
  await db.execute(
    `INSERT INTO org_settings (organization_id, key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, key) DO UPDATE SET
       value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    organizationId,
    key,
    value,
    updatedBy,
    nowIso(),
  );
  return true;
}

/**
 * ¿La organización tiene sobrescritura propia de esta clave? Lo usa la
 * configuración para distinguir "heredado de la plataforma" de "fijado por la
 * organización" sin exponer las tablas.
 */
export async function hasOrgOverride(organizationId, key) {
  if (organizationId === null || organizationId === undefined) return false;
  return (await readOrgValue(organizationId, key)) !== null;
}

export { settingDefault, isGlobalSetting, isOrgSetting };
