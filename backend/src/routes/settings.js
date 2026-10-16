import express from 'express';
import db from '../db/runtime.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { currentOrgId, rejectClientOrg } from '../middleware/org.js';
import {
  getResolutionCategories,
  getRootCauses,
  getPendingReasons,
} from '../utils/options.js';
import { getMailConfig } from '../utils/mailer.js';
import { getSetting, setGlobalSetting, setOrgSetting } from '../utils/settingsStore.js';
import { GLOBAL_KEYS, isGlobalSetting } from '../utils/settings.js';

const router = express.Router();
router.use(requireAuth, requirePermission('settings.manage'));

const KEYS = {
  app_name: 'Nombre del sistema',
  company_name: 'Nombre de la empresa',
  ticket_prefix: 'Prefijo de tickets',
  footer_text: 'Texto del pie de página',
  sla_critical_hours: 'SLA crítica (horas)',
  sla_high_hours: 'SLA alta (horas)',
  sla_medium_hours: 'SLA media (horas)',
  sla_low_hours: 'SLA baja (horas)',
  resolution_categories: 'Categorías de solución',
  root_causes: 'Causas raíz',
  pending_reasons: 'Motivos de ticket pendiente',
  require_resolution_to_close: 'Exigir resolución antes de cerrar',
  notify_on_assign: 'Correo al asignar un ticket',
  notify_on_comment: 'Correo con comentarios nuevos',
  notify_on_resolve: 'Correo al resolver un ticket',
  notify_on_create: 'Correo de confirmación al crear un ticket',
  notify_on_status: 'Correo al cambiar el estado de un ticket',
  notify_on_close: 'Correo al cerrar un ticket',
  enable_csat: 'Encuesta de satisfacción (CSAT) al cerrar',
  rule_unassigned_hours: 'Horas antes de escalar ticket sin asignar',
  rule_unassigned_priority: 'Prioridad de escalación por falta de asignación',
  rule_critical_hours: 'Horas de ticket crítico abierto antes de alertar',
};

// Claves que se guardan como lista (JSON) en la tabla settings.
const LIST_KEYS = ['resolution_categories', 'root_causes', 'pending_reasons'];
const BOOL_KEYS = ['require_resolution_to_close', 'notify_on_assign', 'notify_on_comment', 'notify_on_resolve', 'notify_on_create', 'notify_on_status', 'notify_on_close', 'enable_csat'];
const NUM_KEYS = ['sla_critical_hours', 'sla_high_hours', 'sla_medium_hours', 'sla_low_hours', 'rule_unassigned_hours', 'rule_critical_hours'];
const PRIORITY_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const PREFIX_RE = /^[A-Za-z0-9]{1,8}$/;
const DEFAULT_PREFIX = 'TCK';

// Valores por defecto para las claves numéricas y de texto.
const DEFAULTS = {
  ticket_prefix: 'TCK',
  rule_unassigned_hours: '8',
  rule_unassigned_priority: 'HIGH',
  rule_critical_hours: '12',
};

// Mensaje cuando un administrador de organización intenta cambiar una clave que
// pertenece a TODAS las empresas (V1: app_name y ticket_prefix son globales).
const GLOBAL_FORBIDDEN =
  'El nombre del sistema y el prefijo de tickets son configuración global: solo un superadministrador puede cambiarlos';

function boolSetting(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback ? '1' : '0';
  return ['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase()) ? '0' : '1';
}

/**
 * Lee la configuración visible para una organización.
 *
 * V1: las ORG_KEYS se resuelven con la sobrescritura de ESA organización (y en
 * su defecto con el global legacy); las GLOBAL_KEYS salen siempre del valor
 * global. `organizationId` viene de `currentOrgId(req.user)`, jamás del cuerpo
 * de la petición.
 */
async function readSettings(organizationId) {
  const settings = {};
  for (const key of Object.keys(KEYS)) {
    if (LIST_KEYS.includes(key)) continue;
    const value = await getSetting(key, organizationId);
    if (BOOL_KEYS.includes(key)) settings[key] = boolSetting(value, true);
    else settings[key] = value || DEFAULTS[key] || '';
  }
  settings.resolution_categories = (await getResolutionCategories(organizationId)).join(', ');
  settings.root_causes = (await getRootCauses(organizationId)).join(', ');
  settings.pending_reasons = (await getPendingReasons(organizationId)).join(', ');
  if (!settings.ticket_prefix) settings.ticket_prefix = DEFAULT_PREFIX;
  return settings;
}

/**
 * Valida y normaliza el valor recibido para una clave.
 * Devuelve `{ value }`, `{ skip: true }` (no hay nada que guardar) o `{ error }`.
 */
function parseSetting(key, raw) {
  if (LIST_KEYS.includes(key)) {
    const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const clean = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
    return { value: JSON.stringify(clean) };
  }
  if (BOOL_KEYS.includes(key)) {
    const on = ['1', 'true', 'on', 'si', 'sí', 'yes'].includes(String(raw).toLowerCase());
    return { value: on ? '1' : '0' };
  }
  if (NUM_KEYS.includes(key)) {
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 0 || n > 8760) {
      return { error: `${KEYS[key]} debe ser un número entre 0 y 8760` };
    }
    return { value: String(n) };
  }
  if (key === 'ticket_prefix') {
    const prefix = String(raw ?? '').trim().toUpperCase();
    if (!PREFIX_RE.test(prefix)) {
      return { error: 'El prefijo de tickets debe tener entre 1 y 8 caracteres alfanuméricos' };
    }
    return { value: prefix };
  }
  if (key === 'rule_unassigned_priority') {
    const priority = String(raw ?? '').trim().toUpperCase();
    if (!PRIORITY_VALUES.includes(priority)) {
      return { error: 'Prioridad de escalación inválida' };
    }
    return { value: priority };
  }
  const value = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
  if (!value) return { skip: true };
  return { value };
}

router.get('/', async (req, res) => {
  const organizationId = currentOrgId(req.user);
  res.json({
    data: await readSettings(organizationId),
    meta: KEYS,
    // Las claves que sólo un SUPERADMIN puede cambiar. El frontend las pinta en
    // solo lectura para un administrador de organización; la garantía real es
    // la comprobación de abajo.
    global_keys: GLOBAL_KEYS,
  });
});

// Bitácora de correos enviados/intentados (últimas 50 entradas).
// ETAPA 3: los registros se acotan DURAMENTE a la organización del
// administrador que consulta (la cola con ticket debe pertenecer a su org).
// Un SUPERADMIN sin contexto (org NULL) obtiene una lista vacía: ningún
// `? IS NULL OR ...` que destape correos de otras organizaciones.
router.get('/emails', async (req, res) => {
  const org = currentOrgId(req.user);
  const rows = await db.queryMany(
    `SELECT el.*, t.ticket_number
     FROM email_logs el
     LEFT JOIN tickets t ON t.id = el.ticket_id
     WHERE t.organization_id = ?
     ORDER BY el.id DESC LIMIT 50`,
    org,
  );
  res.json({ data: rows });
});

// Estado de la configuración de correo (sin credenciales).
router.get('/mail', (req, res) => {
  const cfg = getMailConfig();
  res.json({
    data: {
      enabled: cfg.enabled,
      useSmtp: cfg.useSmtp,
      host: cfg.host,
      port: cfg.port,
      from: cfg.from,
      fromName: cfg.fromName,
      hasUser: Boolean(cfg.user),
    },
  });
});

router.patch('/', async (req, res) => {
  const body = req.body || {};

  // V1: la organización no se acepta del cliente. Sale del contexto de sesión.
  const orgError = rejectClientOrg(body);
  if (orgError) return res.status(400).json({ error: orgError });

  const organizationId = currentOrgId(req.user);
  const isSuperadmin = Boolean(req.user.is_superadmin);

  for (const key of Object.keys(KEYS)) {
    if (!(key in body)) continue;

    const parsed = parseSetting(key, body[key]);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.skip) continue;
    const value = parsed.value;

    if (isGlobalSetting(key)) {
      if (!isSuperadmin) {
        // Sólo se rechaza un CAMBIO real: el formulario envía siempre todos los
        // campos, y reenviar el valor vigente no es un intento de tocar lo
        // global. Si el valor difiere, ahí sí hay 403.
        const current = await getSetting(key, organizationId);
        if (String(current ?? '') !== value) {
          return res.status(403).json({ error: GLOBAL_FORBIDDEN });
        }
        continue;
      }
      await setGlobalSetting(key, value, req.user.id);
      continue;
    }

    // ORG_KEYS: el administrador de una organización sólo escribe la SUYA. Un
    // SUPERADMIN global no tiene contexto de organización, así que actualiza el
    // valor por defecto de la plataforma (el que heredan las organizaciones
    // sin sobrescritura).
    if (organizationId != null) await setOrgSetting(organizationId, key, value, req.user.id);
    else await setGlobalSetting(key, value, req.user.id);
  }

  res.json({ data: await readSettings(organizationId) });
});

export default router;
