import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTicketNumber, nextTicketNumberAsync } from '../src/utils/ticketNumber.js';

function fakeContract({ value = 0, prefix = 'TCK', fail = false, missing = false } = {}) {
  let current = value;
  let committed = value;
  const statements = [];
  return {
    statements,
    value: () => current,
    async transactionAsync(callback) {
      const before = current;
      const tx = {
        async queryOne(sql, params) {
          statements.push({ sql, params });
          if (/UPDATE dbo\.sequences/.test(sql)) {
            if (fail) throw new Error('fallo de escritura');
            if (missing) return null;
            current += 1;
            return { value: current };
          }
          if (/SELECT value FROM settings/.test(sql)) return prefix === null ? null : { value: prefix };
          throw new Error(`SQL inesperado: ${sql}`);
        },
      };
      try {
        const result = await callback(tx);
        committed = current;
        return result;
      } catch (error) {
        current = before;
        throw error;
      }
    },
    committed: () => committed,
  };
}

test('C3 · reserva ticket_number de forma atómica y conserva el formato', async () => {
  const db = fakeContract({ value: 41, prefix: 'inc' });
  assert.equal(await nextTicketNumberAsync(db), 'INC-000042');
  assert.equal(await nextTicketNumberAsync(db), 'INC-000043');
  assert.equal(db.committed(), 43);
  assert.match(db.statements[0].sql, /UPDATE dbo\.sequences WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(db.statements[0].sql, /OUTPUT INSERTED\.value AS value/);
  assert.deepEqual(db.statements[0].params, { name: 'ticket_number' });
});

test('C3 · el incremento se revierte si el creador del ticket falla', async () => {
  const db = fakeContract({ value: 7 });
  await assert.rejects(
    () => nextTicketNumberAsync(db, async () => { throw new Error('falló el INSERT del ticket'); }),
    /falló el INSERT/,
  );
  assert.equal(db.value(), 7);
  assert.equal(db.committed(), 7);
});

test('C3 · falla claramente si el seed C2 todavía no creó la secuencia', async () => {
  const db = fakeContract({ missing: true });
  await assert.rejects(() => nextTicketNumberAsync(db), /No existe la secuencia/);
});

test('C3 · el formato mantiene fallback TCK y rechaza valores inválidos', () => {
  assert.equal(formatTicketNumber('', 1), 'TCK-000001');
  assert.equal(formatTicketNumber('abc', 999999), 'ABC-999999');
  assert.throws(() => formatTicketNumber('TCK', 0), /inválido/);
});
