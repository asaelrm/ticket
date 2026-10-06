import db, { contract, transaction } from '../db.js';

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

/**
 * Formatea la secuencia común sin depender del motor. Se exporta para que la
 * variante MSSQL y sus pruebas compartan exactamente el contrato TCK-000001.
 */
export function formatTicketNumber(prefix, value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error('La secuencia ticket_number devolvió un valor inválido.');
  }
  const cleanPrefix = String(prefix || '').trim().toUpperCase() || 'TCK';
  return `${cleanPrefix}-${String(n).padStart(6, '0')}`;
}

/**
 * Reserva el próximo número mediante el contrato async. En SQL Server el
 * bloqueo de actualización y retención hace que dos creadores concurrentes no
 * puedan leer el mismo valor. El callback de transactionAsync permite que el
 * INSERT del ticket use el mismo `tx`, de modo que un rollback también revierte
 * el incremento.
 */
export async function nextTicketNumberAsync(dataContract = contract, callback = null) {
  if (!dataContract || typeof dataContract.transactionAsync !== 'function') {
    throw new TypeError('nextTicketNumberAsync necesita un contrato con transactionAsync.');
  }

  return dataContract.transactionAsync(async (tx) => {
    const row = await tx.queryOne(
      `UPDATE dbo.sequences WITH (UPDLOCK, HOLDLOCK)
       SET value = value + 1
       OUTPUT INSERTED.value AS value
       WHERE name = @name`,
      { name: 'ticket_number' },
    );
    if (!row) throw new Error('No existe la secuencia requerida ticket_number. Ejecute el seed C2.');

    const setting = await tx.queryOne(
      'SELECT value FROM settings WHERE [key] = @key',
      { key: 'ticket_prefix' },
    );
    const ticketNumber = formatTicketNumber(setting?.value, row.value);
    return callback ? callback({ tx, ticketNumber, sequenceValue: Number(row.value) }) : ticketNumber;
  });
}
