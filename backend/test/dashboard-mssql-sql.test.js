import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toTsql, findSqliteOnly } from '../src/db/dialect.js';
import { attentionFlaggedSql, ATTENTION_FILTER, slaTopSql } from '../src/routes/dashboard.js';

// Estas pruebas construyen las mismas sentencias dinámicas de los endpoints
// del dashboard y las pasan por la fachada SQLite -> T-SQL. Así se cubren
// consultas que el escáner de SQL estática no puede ver por sus interpolaciones.
const openPh = '?, ?, ?, ?';
const ticketCond = 't.organization_id = ?';

function assertTsql(sql) {
  const translated = toTsql(sql);
  assert.deepEqual(findSqliteOnly(translated), []);
  return translated;
}

describe('Dashboard: SQL dinámica compatible con MSSQL', () => {
  it('/sla proyecta is_overdue con CASE y se traduce a T-SQL', () => {
    const sql = slaTopSql(ticketCond, `status IN (${openPh}) AND sla_due_at IS NOT NULL`);
    assert.match(sql, /CASE WHEN t\.sla_due_at < \? THEN 1 ELSE 0 END AS is_overdue/);

    const translated = assertTsql(sql);
    assert.match(translated, /CASE WHEN t\.sla_due_at < @p0 THEN 1 ELSE 0 END AS is_overdue/);
    assert.match(translated, /OFFSET 0 ROWS FETCH NEXT 6 ROWS ONLY/);
  });

  it('/needs-attention materializa y evalúa indicadores con comparaciones explícitas', () => {
    const flagged = attentionFlaggedSql(openPh, ticketCond);
    assert.match(flagged, /CASE WHEN t\.sla_due_at IS NOT NULL AND t\.sla_due_at < \? THEN 1 ELSE 0 END AS is_overdue/);
    assert.match(flagged, /CASE WHEN t\.priority = 'CRITICAL' THEN 1 ELSE 0 END AS is_critical/);
    assert.equal(ATTENTION_FILTER, 'WHERE is_overdue = 1 OR is_critical = 1 OR is_due_soon = 1 OR is_unassigned = 1');

    const rowsSql = `${flagged}
      SELECT f.id,
             CASE WHEN f.is_overdue = 1 THEN 0
                  WHEN f.is_critical = 1 THEN 1
                  WHEN f.is_due_soon = 1 THEN 2
                  WHEN f.is_unassigned = 1 THEN 3
                  ELSE 9 END AS urgency
      FROM flagged f ${ATTENTION_FILTER}
      ORDER BY urgency ASC LIMIT ?`;
    const totalsSql = `${flagged}
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN is_overdue = 1 THEN 1 ELSE 0 END), 0) AS overdue,
             COALESCE(SUM(CASE WHEN is_critical = 1 THEN 1 ELSE 0 END), 0) AS critical,
             COALESCE(SUM(CASE WHEN is_due_soon = 1 THEN 1 ELSE 0 END), 0) AS dueSoon,
             COALESCE(SUM(CASE WHEN is_unassigned = 1 THEN 1 ELSE 0 END), 0) AS unassigned
      FROM flagged ${ATTENTION_FILTER}`;

    assert.match(assertTsql(rowsSql), /WHERE is_overdue = 1 OR is_critical = 1 OR is_due_soon = 1 OR is_unassigned = 1/);
    assert.match(assertTsql(totalsSql), /SUM\(CASE WHEN is_overdue = 1 THEN 1 ELSE 0 END\)/);
  });
});
