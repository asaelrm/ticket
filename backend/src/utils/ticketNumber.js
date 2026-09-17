import db, { transaction } from '../db.js';

export function nextTicketNumber() {
  return transaction(() => {
    const row = db
      .prepare(
        "UPDATE sequences SET value = value + 1 WHERE name = 'ticket_number' RETURNING value"
      )
      .get();
    let value = row ? row.value : null;
    if (value === null) {
      db.prepare('INSERT INTO sequences (name, value) VALUES (?, 1)').run('ticket_number', 1);
      value = 1;
    }
    return `TCK-${String(value).padStart(6, '0')}`;
  });
}