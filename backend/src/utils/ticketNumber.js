import db, { transaction } from '../db.js';

export function nextTicketNumber() {
  return transaction(() => {
    const row = db.prepare("SELECT value FROM sequences WHERE name = 'ticket_number'").get();
    const value = (row ? row.value : 0) + 1;
    db.prepare(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
    ).run('ticket_number', value);
    return `TCK-${String(value).padStart(6, '0')}`;
  });
}