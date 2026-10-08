import db from '../db/runtime.js';

// Prefijo configurable desde Configuración (clave ticket_prefix). Por defecto TCK.
async function getPrefix() {
  const row = await db.queryOne("SELECT value FROM settings WHERE key = 'ticket_prefix'");
  const prefix = row ? String(row.value || '').trim() : '';
  return (prefix || 'TCK').toUpperCase();
}

// ETAPA 3: la secuencia es POR ORGANIZACIÓN (clave `ticket_number:<orgId>`), de
// modo que cada organización arranca su propia numeración en 000001. La clave
// legacy `ticket_number` queda intacta (seed.js copia su valor a la clave por
// organización de UCE para que la numeración continúe tras la migración).
// El prefijo (settings.ticket_prefix) permanece global: es configuración del
// sistema, decisión documentada para la etapa MSSQL.
export async function nextTicketNumber(organizationId = null) {
  return db.transaction(async () => {
    const key = organizationId == null ? 'ticket_number' : `ticket_number:${organizationId}`;
    const row = await db.queryOne('SELECT value FROM sequences WHERE name = ?', key);
    const value = (row ? row.value : 0) + 1;
    await db.execute(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
    return `${await getPrefix()}-${String(value).padStart(6, '0')}`;
  });
}
