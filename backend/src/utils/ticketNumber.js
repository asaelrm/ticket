import db, { transaction } from '../db.js';

// Prefijo configurable desde Configuración (clave ticket_prefix). Por defecto TCK.
function getPrefix() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ticket_prefix'").get();
  const prefix = row ? String(row.value || '').trim() : '';
  return (prefix || 'TCK').toUpperCase();
}

// ETAPA 3: la secuencia es POR ORGANIZACIÓN (clave `ticket_number:<orgId>`), de
// modo que cada organización arranca su propia numeración en 000001. La clave
// legacy `ticket_number` queda intacta (seed.js copia su valor a la clave por
// organización de UCE para que la numeración continúe tras la migración).
// El prefijo (settings.ticket_prefix) permanece global: es configuración del
// sistema, decisión documentada para la etapa MSSQL.
export function nextTicketNumber(organizationId = null) {
  return transaction(() => {
    const key = organizationId == null ? 'ticket_number' : `ticket_number:${organizationId}`;
    const row = db.prepare('SELECT value FROM sequences WHERE name = ?').get(key);
    const value = (row ? row.value : 0) + 1;
    db.prepare(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
    ).run(key, value);
    return `${getPrefix()}-${String(value).padStart(6, '0')}`;
  });
}