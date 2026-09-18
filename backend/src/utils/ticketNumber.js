import db, { transaction } from '../db.js';

// Prefijo configurable desde Configuración (clave ticket_prefix). Por defecto TCK.
function getPrefix() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ticket_prefix'").get();
  const prefix = row ? String(row.value || '').trim() : '';
  return (prefix || 'TCK').toUpperCase();
}

export function nextTicketNumber() {
  return transaction(() => {
    const row = db.prepare("SELECT value FROM sequences WHERE name = 'ticket_number'").get();
    const value = (row ? row.value : 0) + 1;
    db.prepare(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
    ).run('ticket_number', value);
    return `${getPrefix()}-${String(value).padStart(6, '0')}`;
  });
}