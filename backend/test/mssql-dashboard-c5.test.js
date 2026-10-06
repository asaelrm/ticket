// C5 · Los diez endpoints del panel sobre el contrato async (DB_CLIENT=mssql).
//
// La suite corre con SQLite, así que se comprueba lo que es comprobable sin un
// SQL Server real:
//
//   1. Fuente: los diez manejadores eligen la rama mssql, el bloque no toca la
//      fachada `db` ni el SQL de SQLite, y TODA comparación contra datetime2
//      pasa por CONVERT(..., 127) —el patrón que ya usa C4 y que la
//      integración C1 validó contra el servidor—.
//   2. Comportamiento: cada `*Mssql` se llama con un contrato falso que
//      registra SQL y parámetros, y se verifican los mismos JSON que devuelve
//      SQLite (conteos como número, indicadores BIT como 1/0, `reasons` y
//      `urgency` en el mismo orden).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  byCategoryMssql,
  byDepartmentMssql,
  byPriorityMssql,
  byStatusMssql,
  byTechnicianMssql,
  needsAttentionMssql,
  recentMssql,
  slaMssql,
  summaryMssql,
  trendMssql,
} from '../src/routes/dashboard.js';

function entre(fuente, inicioMarca, finMarca) {
  const i = fuente.indexOf(inicioMarca);
  assert.ok(i > -1, `falta la marca de inicio: ${inicioMarca}`);
  const j = fuente.indexOf(finMarca, i + 1);
  assert.ok(j > i, `falta la marca de fin: ${finMarca}`);
  return fuente.slice(i, j);
}

function sinComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

function fakeContract(reglas = []) {
  const calls = [];
  async function run(kind, sql, params) {
    calls.push({ kind, sql, params: params ?? {} });
    for (const [re, respuesta] of reglas) {
      if (!re.test(sql)) continue;
      return typeof respuesta === 'function' ? respuesta({ kind, sql, params }) : respuesta;
    }
    if (kind === 'queryMany') return [];
    if (kind === 'insert') return { id: 1, rowsAffected: 1 };
    if (kind === 'execute') return { rowsAffected: 1 };
    return null;
  }
  const contract = {
    calls,
    queryOne: (sql, params) => run('queryOne', sql, params),
    queryMany: (sql, params) => run('queryMany', sql, params),
    execute: (sql, params) => run('execute', sql, params),
    insertAndGetId: (sql, params) => run('insert', sql, params),
    async transactionAsync(callback) {
      return callback(contract);
    },
  };
  return contract;
}

const buscar = (c, re) => c.calls.filter((call) => re.test(call.sql));

describe('C5 · fuente de la rama MSSQL', () => {
  const fuente = readFileSync(new URL('../src/routes/dashboard.js', import.meta.url), 'utf8');
  const bloque = entre(fuente, 'Rama MSSQL del panel', 'export default router');
  const codigo = sinComentarios(bloque);

  it('el bloque MSSQL no toca la fachada legacy `db` ni el SQL de SQLite', () => {
    assert.doesNotMatch(codigo, /\bdb\./, '`db` es un Proxy que lanza con DB_CLIENT=mssql');
    assert.doesNotMatch(codigo, /\.prepare\(/);
    assert.doesNotMatch(codigo, /strftime\(/, 'strftime no existe en SQL Server');
    assert.doesNotMatch(codigo, /\bLIMIT\s+\d/, 'SQL Server usa TOP/OFFSET-FETCH');
    assert.doesNotMatch(codigo, /lastInsertRowid/);
    assert.doesNotMatch(codigo, /\|\|\s*'\s'\s*\|\|/, 'la concatenación de SQLite debe ser CONCAT');
    assert.match(codigo, /CONCAT\(/);
  });

  it('los diez manejadores eligen la rama mssql', () => {
    const ramas = fuente.match(/config\.dbClient === 'mssql'/g) || [];
    assert.equal(ramas.length, 10, 'los diez endpoints deben tener su rama');

    const llamadas = fuente.match(/\w+Mssql\(defaultContract/g) || [];
    assert.equal(new Set(llamadas).size, 10, 'cada rama llama a su *Mssql con el contrato');
    assert.ok(llamadas.includes('summaryMssql(defaultContract'));
    assert.ok(llamadas.includes('recentMssql(defaultContract'));
  });

  it('toda fecha ISO viaja con CONVERT(..., 127) antes de compararse', () => {
    // Un parámetro nvarchar terminado en Z no es un literal válido de datetime2
    // (yyyy-MM-ddTHH:mm:ss[.nnnnnnn]): la conversión implícita puede fallar.
    assert.doesNotMatch(
      codigo,
      /(?:sla_due_at|created_at|resolved_at)\s*(?:<|>|<=|>=)\s*@/,
      'cada comparación contra datetime2 debe envolver el parámetro en CONVERT(..., 127)',
    );
    assert.match(codigo, /const asDateTime = \(placeholder\) => `CONVERT\(datetime2\(3\), \$\{placeholder\}, 127\)`/);
    assert.match(codigo, /asDateTime\('@now'\)/);
    assert.match(codigo, /asDateTime\('@in24'\)/);
    assert.match(codigo, /asDateTime\('@start'\)/);
    assert.match(codigo, /asDateTime\('@end'\)/);
  });

  it('usa TOP/OFFSET, alias reservados escapados y CASE encadenado (no MIN)', () => {
    assert.match(codigo, /SELECT TOP \(6\)/);
    assert.match(codigo, /SELECT TOP \(8\)/);
    assert.match(codigo, /SELECT TOP \(10\)/);
    assert.match(codigo, /OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY/);
    assert.match(codigo, /AS \[open\]/, 'OPEN es palabra reservada: hay que escaparlo');
    assert.doesNotMatch(codigo, /\bMIN\(/, 'MIN(a, b, c, d) no existe en T-SQL: es una función de agregado');
    assert.match(codigo, /CASE WHEN f\.is_overdue = 1 THEN 0/);
    assert.doesNotMatch(codigo, /date\(|strftime\('%Y-%m'/);
  });
});

describe('C5 · /api/dashboard/summary', () => {
  it('cuenta por estado y devuelve números, no strings de la BD', async () => {
    const c = fakeContract([
      [/priority = 'CRITICAL'/, { n: '1' }],
      [/resolved_at >=/, { n: '4' }],
      [/created_at >=/, { n: '5' }],
      [/^SELECT COUNT\(\*\) AS n FROM tickets$/, { n: '9' }],
      [/GROUP BY status/, [{ status: 'OPEN', n: '2' }, { status: 'PENDING', n: '1' }, { status: 'CLOSED', n: '3' }]],
    ]);

    const res = await summaryMssql(c);

    assert.deepEqual(res.counts, {
      OPEN: 2, ASSIGNED: 0, IN_PROGRESS: 0, PENDING: 1, RESOLVED: 0, CLOSED: 3, CANCELLED: 0,
    });
    assert.equal(res.openTotal, 3);
    assert.equal(res.critical, 1);
    assert.equal(res.createdMonth, 5);
    assert.equal(res.resolvedMonth, 4);
    assert.equal(res.total, 9);

    const [mes] = buscar(c, /created_at >=/);
    assert.match(mes.sql, /CONVERT\(datetime2\(3\), @start, 127\)/);
    assert.match(mes.sql, /CONVERT\(datetime2\(3\), @end, 127\)/);
    assert.match(mes.sql, /created_at < CONVERT\(datetime2\(3\), @end, 127\)/);
    assert.match(mes.params.start, /^\d{4}-\d{2}-01T00:00:00\.000Z$/, 'el mes empieza en su primer día UTC');
    assert.ok(mes.params.end > mes.params.start);

    const [critico] = buscar(c, /priority = 'CRITICAL'/);
    assert.match(critico.sql, /status IN \(@s0, @s1, @s2, @s3\)/);
    assert.deepEqual(
      { s0: critico.params.s0, s1: critico.params.s1, s2: critico.params.s2, s3: critico.params.s3 },
      { s0: 'OPEN', s1: 'ASSIGNED', s2: 'IN_PROGRESS', s3: 'PENDING' },
    );
  });
});

describe('C5 · /api/dashboard/by-status y by-priority', () => {
  it('by-status normaliza los conteos', async () => {
    const c = fakeContract([[/GROUP BY status/, [{ status: 'OPEN', n: '7' }, { status: 'CLOSED', n: '2' }]]]);
    const res = await byStatusMssql(c);
    assert.deepEqual(res, { data: [{ status: 'OPEN', n: 7 }, { status: 'CLOSED', n: 2 }] });
    assert.match(buscar(c, /GROUP BY status/)[0].sql, /ORDER BY n DESC/);
  });

  it('by-priority cuenta solo abiertos y suma `open`', async () => {
    const c = fakeContract([[/GROUP BY priority/, [{ priority: 'HIGH', n: '3' }, { priority: 'LOW', n: '4' }]]]);
    const res = await byPriorityMssql(c);
    assert.deepEqual(res, { data: [{ priority: 'HIGH', n: 3 }, { priority: 'LOW', n: 4 }], open: 7 });

    const [q] = buscar(c, /GROUP BY priority/);
    assert.match(q.sql, /WHERE status IN \(@s0, @s1, @s2, @s3\)/);
    assert.equal(q.params.s3, 'PENDING');
    assert.doesNotMatch(q.sql, /LIMIT|\?|db\.prepare/);
  });
});

describe('C5 · /api/dashboard/sla', () => {
  const reglas = [
    [/TOP \(6\)/, [{ id: 1, ticket_number: 'TCK-000001', title: 'x', status: 'OPEN', priority: 'HIGH', sla_due_at: '2026-01-01T00:00:00.000Z', is_overdue: true, reporter_name: 'Ada L' }]],
    [/sla_due_at >= CONVERT\(datetime2\(3\), @in24/, { n: '11' }],
    [/sla_due_at >= CONVERT\(datetime2\(3\), @now/, { n: '2' }],
    [/sla_due_at < CONVERT\(datetime2\(3\), @now/, { n: '7' }],
  ];

  it('separa vencidos / por vencer / sanos y normaliza is_overdue', async () => {
    const c = fakeContract(reglas);
    const res = await slaMssql(c);

    assert.deepEqual({ overdue: res.overdue, atRisk: res.atRisk, healthy: res.healthy }, { overdue: 7, atRisk: 2, healthy: 11 });
    assert.equal(res.top.length, 1);
    assert.equal(res.top[0].is_overdue, 1, 'BIT debe volver 1, no true');

    const [top] = buscar(c, /TOP \(6\)/);
    assert.match(top.sql, /CONCAT\(r\.name, ' ', r\.last_name\) AS reporter_name/);
    assert.match(top.sql, /ORDER BY is_overdue DESC, t\.sla_due_at ASC/);
    assert.match(top.params.now, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.doesNotMatch(top.sql, /strftime|LIMIT|`\?`/);

    for (const [i, nombre] of ['overdue', 'atRisk', 'healthy'].entries()) {
      assert.equal(typeof res[nombre], 'number', `${nombre} debe ser número`);
      assert.ok(buscar(c, /SELECT COUNT\(\*\) AS n FROM tickets WHERE status IN/)[i]);
    }
  });
});

describe('C5 · /api/dashboard/by-category y by-department', () => {
  it('by-category escapa `open` y normaliza los dos conteos', async () => {
    const c = fakeContract([[ /FROM categories c/, [{ id: 1, name: 'Hardware', color: '#f00', n: '5', open: true }]]]);
    const res = await byCategoryMssql(c);
    assert.deepEqual(res, { data: [{ id: 1, name: 'Hardware', color: '#f00', n: 5, open: 1 }] });

    const [q] = buscar(c, /FROM categories c/);
    assert.match(q.sql, /AS \[open\]/);
    assert.match(q.sql, /SUM\(CASE WHEN t\.status IN \(@st0, @st1, @st2, @st3\)/);
    assert.equal(q.params.st0, 'OPEN');
    assert.match(q.sql, /LEFT JOIN tickets t ON t\.category_id = c\.id/);
  });

  it('by-department escapa `open` igual', async () => {
    const c = fakeContract([[ /FROM departments d/, [{ id: 2, name: 'TI', n: '3', open: '1' }]]]);
    const res = await byDepartmentMssql(c);
    assert.deepEqual(res, { data: [{ id: 2, name: 'TI', n: 3, open: 1 }] });

    const [q] = buscar(c, /FROM departments d/);
    assert.match(q.sql, /AS \[open\]/);
    assert.match(q.sql, /LEFT JOIN tickets t ON t\.department_id = d\.id/);
    assert.equal(q.params.st3, 'PENDING');
  });
});

describe('C5 · /api/dashboard/by-technician', () => {
  it('normaliza las seis columnas y arma `totals` y `unassigned`', async () => {
    const c = fakeContract([
      [/TOP \(10\)/, [{
        id: 1, name: 'Ana', last_name: 'Lovelace', position: 'Técnico',
        technician: 'Ana Lovelace', active: '4', open: '1', assigned: '2',
        in_progress: '1', pending: '0', overdue: true,
      }]],
      [/COUNT\(DISTINCT t\.assigned_to_id\)/, { technicians: '3', active: '12', overdue: '2' }],
      [/assigned_to_id IS NULL/, { n: '6' }],
    ]);

    const res = await byTechnicianMssql(c);

    assert.deepEqual(res.data, [{
      id: 1, name: 'Ana', last_name: 'Lovelace', position: 'Técnico',
      technician: 'Ana Lovelace', active: 4, open: 1, assigned: 2,
      in_progress: 1, pending: 0, overdue: 1,
    }]);
    assert.deepEqual(res.totals, { technicians: 3, active: 12, overdue: 2 });
    assert.equal(res.unassigned, 6);

    const [lista] = buscar(c, /TOP \(10\)/);
    assert.match(lista.sql, /GROUP BY u\.id, u\.name, u\.last_name, u\.position/);
    assert.match(lista.sql, /CONCAT\(u\.name, ' ', u\.last_name\) AS technician/);
    assert.doesNotMatch(lista.sql, /strftime|LIMIT/);
  });
});

describe('C5 · /api/dashboard/needs-attention', () => {
  const filas = [
    {
      id: 1, ticket_number: 'TCK-000001', title: 'Vencido', status: 'OPEN', priority: 'HIGH',
      sla_due_at: '2026-01-01T00:00:00.000Z', assigned_to_id: 2, created_at: '2025-12-01T00:00:00.000Z',
      is_overdue: true, is_critical: false, is_due_soon: false, is_unassigned: false,
      urgency: 0, technician_name: 'Tec Uno', category_name: 'Hardware',
    },
    {
      id: 2, ticket_number: 'TCK-000002', title: 'Crítico sin asignar', status: 'OPEN', priority: 'CRITICAL',
      sla_due_at: null, assigned_to_id: null, created_at: '2026-01-02T00:00:00.000Z',
      is_overdue: false, is_critical: true, is_due_soon: false, is_unassigned: true,
      urgency: 1, technician_name: null, category_name: null,
    },
    {
      id: 3, ticket_number: 'TCK-000003', title: 'Por vencer', status: 'OPEN', priority: 'LOW',
      sla_due_at: '2026-02-01T00:00:00.000Z', assigned_to_id: 3, created_at: '2026-01-03T00:00:00.000Z',
      is_overdue: false, is_critical: false, is_due_soon: true, is_unassigned: false,
      urgency: 2, technician_name: 'Tec Dos', category_name: 'Software',
    },
  ];

  it('arma reasons y urgency en el mismo orden que SQLite y normaliza totales', async () => {
    const c = fakeContract([
      [/SELECT COUNT\(\*\) AS total/, { total: '3', overdue: '1', critical: '1', dueSoon: '1', unassigned: '1' }],
      [/SELECT f\.id/, filas],
    ]);

    const res = await needsAttentionMssql(c);

    assert.equal(res.data.length, 3);
    assert.deepEqual(res.data[0].reasons, ['SLA_OVERDUE']);
    assert.deepEqual(res.data[1].reasons, ['CRITICAL', 'UNASSIGNED']);
    assert.deepEqual(res.data[2].reasons, ['SLA_DUE_SOON']);
    assert.deepEqual(res.data.map((r) => r.urgency), [0, 1, 2]);
    assert.deepEqual(res.totals, { total: 3, overdue: 1, critical: 1, dueSoon: 1, unassigned: 1 });

    const [lista] = buscar(c, /SELECT f\.id/);
    assert.match(lista.sql, /WITH flagged AS \(/);
    assert.match(lista.sql, /CASE WHEN f\.is_overdue = 1 THEN 0\s+WHEN f\.is_critical = 1 THEN 1\s+WHEN f\.is_due_soon = 1 THEN 2\s+WHEN f\.is_unassigned = 1 THEN 3/);
    assert.doesNotMatch(lista.sql, /\bMIN\(/, 'MIN de cuatro argumentos no existe en T-SQL');
    assert.match(lista.sql, /OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY/);
    assert.match(lista.sql, /CONVERT\(datetime2\(3\), @now, 127\)/);
    assert.equal(lista.params.limit, 8, 'por defecto ocho filas');
    assert.ok(lista.params.now.endsWith('Z') && lista.params.in24.endsWith('Z'));
  });

  it('recorta el límite al rango 1..50', async () => {
    const grande = fakeContract([[ /SELECT COUNT\(\*\) AS total/, { total: 0 }], [/SELECT f\.id/, []]]);
    await needsAttentionMssql(grande, { limit: '999' });
    assert.equal(buscar(grande, /SELECT f\.id/)[0].params.limit, 50);

    const chico = fakeContract([[ /SELECT COUNT\(\*\) AS total/, { total: 0 }], [/SELECT f\.id/, []]]);
    await needsAttentionMssql(chico, { limit: '0' });
    assert.equal(buscar(chico, /SELECT f\.id/)[0].params.limit, 1);
  });
});

describe('C5 · /api/dashboard/trend', () => {
  const etiquetas = () => {
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };

  it('día: 14 cubos y agrupa con CONVERT(char(10), …, 126)', async () => {
    const labels = etiquetas();
    const creados = labels.map((label, i) => ({ bucket: label, n: i }));
    const resueltos = labels.map((label, i) => ({ bucket: label, n: 14 - i }));

    const c = fakeContract([
      [/WHERE created_at/, creados],
      [/WHERE resolved_at/, resueltos],
    ]);

    const res = await trendMssql(c, { range: 'day' });

    assert.equal(res.data.length, 14, 'el gráfico de día muestra dos semanas');
    assert.deepEqual(res.data.map((r) => r.label), labels);
    assert.deepEqual(res.data.map((r) => r.created), labels.map((_, i) => i));
    assert.deepEqual(res.data.map((r) => r.resolved), labels.map((_, i) => 14 - i));

    const [creadosQ] = buscar(c, /WHERE created_at/);
    assert.match(creadosQ.sql, /CONVERT\(char\(10\), created_at, 126\) AS bucket/);
    assert.match(creadosQ.sql, /CONVERT\(datetime2\(3\), @start, 127\)/);
    assert.match(creadosQ.sql, /CONVERT\(datetime2\(3\), @end, 127\)/);
    assert.doesNotMatch(creadosQ.sql, /date\(|strftime\(/);
    assert.match(creadosQ.params.start, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    assert.ok(creadosQ.params.end > creadosQ.params.start);
  });

  it('mes: 12 cubos etiquetados YYYY-MM y agrupados con char(7)', async () => {
    const labels = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      labels.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }

    const c = fakeContract([
      [/WHERE created_at/, labels.map((bucket, i) => ({ bucket, n: i }))],
      [/WHERE resolved_at/, []],
    ]);

    const res = await trendMssql(c, { range: 'month' });

    assert.equal(res.data.length, 12);
    assert.deepEqual(res.data.map((r) => r.label), labels);
    assert.deepEqual(res.data.map((r) => r.created), labels.map((_, i) => i));
    assert.match(buscar(c, /WHERE created_at/)[0].sql, /CONVERT\(char\(7\), created_at, 126\)/);
  });

  it('un rango desconocido cae en `day`', async () => {
    const c = fakeContract([[ /WHERE created_at/, []], [/WHERE resolved_at/, []]]);
    const res = await trendMssql(c, { range: 'raro' });
    assert.equal(res.data.length, 14);
  });
});

describe('C5 · /api/dashboard/recent', () => {
  it('trae los últimos ocho con TOP y CONCAT', async () => {
    const fila = {
      id: 1, ticket_number: 'TCK-000009', title: 'Reciente', status: 'OPEN', priority: 'MEDIUM',
      created_at: '2026-01-05T10:00:00.000Z', category_name: 'Hardware',
      reporter_name: 'Ana Lovelace', assigned_name: '',
    };
    const c = fakeContract([[ /SELECT TOP \(8\)/, [fila]]]);

    const res = await recentMssql(c);
    assert.deepEqual(res, { data: [fila] });

    const [q] = buscar(c, /SELECT TOP \(8\)/);
    assert.match(q.sql, /CONCAT\(r\.name, ' ', r\.last_name\) AS reporter_name/);
    assert.match(q.sql, /CONCAT\(a\.name, ' ', a\.last_name\) AS assigned_name/);
    assert.match(q.sql, /ORDER BY t\.created_at DESC/);
    assert.doesNotMatch(q.sql, /LIMIT|\|\|/);
    assert.equal(Object.keys(q.params).length, 0, 'recent no necesita parámetros');
  });
});
