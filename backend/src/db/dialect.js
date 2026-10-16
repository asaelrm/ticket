/**
 * Traductor de dialecto SQLite → T-SQL.
 *
 * Las consultas del código se escriben en SQLite y, cuando el motor activo es
 * MSSQL, pasan por aquí antes de enviarse al servidor. El módulo trabaja sobre
 * un tokenizado que distingue cadenas, comentarios e identificadores, de modo
 * que NUNCA se reescribe texto dentro de una cadena (un LIKE '%?%' o un
 * comentario con "LIMIT" no se toca).
 *
 * Tres reglas rigen el diseño:
 *
 *  1. Si al final queda una construcción específica de SQLite, se lanza un
 *     error explícito. Es preferible un fallo ruidoso en la traducción que
 *     mandar SQL inválido o interpretar mal los datos.
 *  2. Cada transformación es pequeña, comprobable y cubierta por
 *     test/db-dialect.test.js con los patrones REALES del repositorio.
 *  3. Los cambios que afectan al resultado (expansión de GROUP BY, AVG sobre
 *     enteros, claves de conflicto) preservan la semántica de SQLite y están
 *     documentados punto a punto.
 */

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------

const WORD_START = /[A-Za-z_@#$]/;
const WORD_BODY = /[A-Za-z0-9_$#@]/;

export function tokenize(sql) {
  const tokens = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      tokens.push({ t: 'ws', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') j++;
      tokens.push({ t: 'comment', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      tokens.push({ t: 'comment', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ t: 'string', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ t: 'dq', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i);
      const j = end < 0 ? n : end + 1;
      tokens.push({ t: 'bracket', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '?') {
      tokens.push({ t: 'question', v: '?' });
      i++;
      continue;
    }
    if (c === '|' && sql[i + 1] === '|') {
      tokens.push({ t: 'op', v: '||' });
      i += 2;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i;
      while (j < n && WORD_BODY.test(sql[j])) j++;
      tokens.push({ t: 'word', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ t: 'punct', v: c });
    i++;
  }
  return tokens;
}

const text = (tokens) => tokens.map((tok) => tok.v).join('');
const isWord = (tok, name) => Boolean(tok) && tok.t === 'word' && tok.v.toLowerCase() === name;

// Normalización para comparar expresiones: sin espacios, en minúsculas y sin
// paréntesis envolventes (el alias expandido llega como `(expr)` y el del
// SELECT como `expr`). El barrido es sobre texto porque los alias se insertan
// como tokens `raw`.
function norm(tokens) {
  let s = text(tokens).replace(/\s+/g, '').toLowerCase();
  while (s.length > 2 && s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let envolvente = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i !== s.length - 1) {
          envolvente = false;
          break;
        }
      }
    }
    if (!envolvente) break;
    s = s.slice(1, -1);
  }
  return s;
}

function parenDepthAt(tokens, upTo) {
  let depth = 0;
  for (let i = 0; i < upTo; i++) {
    if (tokens[i].t === 'punct' && tokens[i].v === '(') depth++;
    else if (tokens[i].t === 'punct' && tokens[i].v === ')') depth--;
  }
  return depth;
}

function matchingParen(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].t === 'punct' && tokens[i].v === '(') depth++;
    else if (tokens[i].t === 'punct' && tokens[i].v === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(tokens, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'punct' && tok.v === '(') depth++;
    else if (tok.t === 'punct' && tok.v === ')') depth--;
    else if (depth === 0 && tok.t === 'punct' && tok.v === separator) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts;
}

function trim(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && (tokens[start].t === 'ws' || tokens[start].t === 'comment')) start++;
  while (end > start && (tokens[end - 1].t === 'ws' || tokens[end - 1].t === 'comment')) end--;
  return tokens.slice(start, end);
}

function raw(value) {
  return { t: 'raw', v: value };
}

// Primer token significativo (ni espacio ni comentario) desde `from`.
function nextSignificant(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    if (tokens[i].t !== 'ws' && tokens[i].t !== 'comment') return i;
  }
  return -1;
}

// Índices de palabras clave a profundidad 0 (no dentro de paréntesis).
function topLevelIndexes(tokens, names) {
  const wanted = new Set(names);
  const found = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'punct' && tok.v === '(') depth++;
    else if (tok.t === 'punct' && tok.v === ')') depth--;
    else if (depth === 0 && tok.t === 'word' && wanted.has(tok.v.toLowerCase())) found.push(i);
  }
  return found;
}

function indexOfWord(tokens, name, from = 0) {
  return topLevelIndexes(tokens, [name]).find((i) => i >= from);
}

function statementEnd(tokens) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t === 'punct' && tokens[i].v === '(') depth++;
    else if (tokens[i].t === 'punct' && tokens[i].v === ')') depth--;
    else if (depth === 0 && tokens[i].t === 'punct' && tokens[i].v === ';') return i;
  }
  return tokens.length;
}

// ---------------------------------------------------------------------------
// Lotes: una cadena puede contener varias sentencias separadas por ";"
// ---------------------------------------------------------------------------

function splitStatements(tokens) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'punct' && tok.v === '(') depth++;
    else if (tok.t === 'punct' && tok.v === ')') depth--;
    else if (depth === 0 && tok.t === 'punct' && tok.v === ';') {
      out.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  out.push(tokens.slice(start));
  return out.filter((s) => trim(s).length > 0);
}

// ---------------------------------------------------------------------------
// 1. Parámetros posicionales ? → @pN
// ---------------------------------------------------------------------------

export function translatePlaceholders(tokens, state = { n: 0 }) {
  return tokens.map((tok) => (tok.t === 'question' ? { t: 'word', v: `@p${state.n++}` } : tok));
}

export function placeholderCount(sql) {
  return tokenize(sql).filter((tok) => tok.t === 'question').length;
}

// ---------------------------------------------------------------------------
// 2. Concatenación || → +   (T-SQL no conoce ||)
// ---------------------------------------------------------------------------

export function translateConcat(tokens) {
  return tokens.map((tok) => (tok.t === 'op' && tok.v === '||' ? { t: 'punct', v: '+' } : tok));
}

// ---------------------------------------------------------------------------
// 3. COLLATE NOCASE → colación CI de SQL Server
// ---------------------------------------------------------------------------

export function translateCollate(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = nextSignificant(tokens, i + 1);
    if (isWord(tokens[i], 'collate') && word > -1 && isWord(tokens[word], 'nocase')) {
      out.push(raw('COLLATE Latin1_General_CI_AS'));
      i = word;
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Palabras reservadas de T-SQL usadas como identificadores → [nombre]
//
// El esquema usa `key` (settings/org_settings) y el código usa `open` como
// alias de agregado (dashboard/reports); ambas son palabras reservadas en
// SQL Server. La lista solo incluye palabras que en este código base aparecen
// SIEMPRE como identificador, nunca como palabra sintáctica.
// ---------------------------------------------------------------------------

const RESERVED_IDENTIFIERS = new Set([
  'key', 'value', 'user', 'check', 'comment', 'language', 'option', 'level',
  'file', 'rule', 'plan', 'percent', 'row', 'rows', 'index', 'trigger',
  'procedure', 'open', 'close',
  // Partes de fecha usadas como alias (day/month): en T-SQL son palabras
  // clave de fecha y en SQLite son identificadores corrientes.
  'day', 'month', 'year', 'hour', 'minute', 'second', 'week', 'quarter',
]);

export function quoteReservedIdentifiers(tokens) {
  return tokens.map((tok) => (
    tok.t === 'word' && RESERVED_IDENTIFIERS.has(tok.v.toLowerCase())
      ? { t: 'bracket', v: `[${tok.v}]` }
      : tok
  ));
}

// Nombre de identificador en minúsculas, tanto si es palabra como si ya está
// entre corchetes ([day]). Devuelve null si no es un identificador.
function identifierName(tok) {
  if (!tok) return null;
  if (tok.t === 'word') return tok.v.toLowerCase();
  if (tok.t === 'bracket') return tok.v.slice(1, -1).toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// 5. Funciones de fecha/json específicas de SQLite
// ---------------------------------------------------------------------------

function replaceCall(tokens, name, replacer) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (isWord(tok, name)) {
      const open = nextSignificant(tokens, i + 1);
      if (open > -1 && tokens[open].t === 'punct' && tokens[open].v === '(') {
        const close = matchingParen(tokens, open);
        if (close > 0) {
          const args = splitTopLevel(tokens.slice(open + 1, close)).map(trim);
          const replacement = replacer(args);
          if (replacement !== null && replacement !== undefined) {
            out.push(raw(replacement));
            i = close + 1;
            continue;
          }
        }
      }
    }
    out.push(tok);
    i++;
  }
  return out;
}

// `args` es una lista de argumentos (cada uno, una lista de tokens).
function literalString(arg) {
  const tok = Array.isArray(arg) ? arg[0] : arg;
  if (!tok || (Array.isArray(arg) && arg.length !== 1)) return null;
  if (tok.t === 'string') return tok.v.slice(1, -1).replace(/''/g, "'");
  if (tok.t === 'dq') return tok.v.slice(1, -1).replace(/""/g, '"');
  return null;
}

// Nombre de alias tras un `AS` (salta espacios y comentarios).
function aliasNameAfter(piece, asIdx) {
  const nameIdx = nextSignificant(piece, asIdx + 1);
  if (nameIdx < 0) return null;
  return piece[nameIdx];
}

// Reduce una marca temporal a "yyyy-mm" conservando la zona horaria tal cual
// se almacenó (UTC en ambos motores).
function monthPrefix(inner) {
  return `LEFT(CONVERT(VARCHAR(33), ${inner}, 126), 7)`;
}

export function translateFunctions(tokens) {
  let out = tokens;

  // strftime('%Y-%m-%dT%H:%M:%fZ', 'now') → SYSUTCDATETIME()
  // strftime('%Y-%m', col)                 → LEFT(CONVERT(...,126), 7)
  out = replaceCall(out, 'strftime', (args) => {
    const format = literalString(args[0]);
    if (!format) return null;
    const second = literalString(args[1]);
    if (second !== null && second.toLowerCase() === 'now') {
      if (format !== '%Y-%m-%dT%H:%M:%fZ') {
        throw new Error(`strftime con formato sobre "now" no soportado: ${format}`);
      }
      return 'SYSUTCDATETIME()';
    }
    if (format === '%Y-%m') return monthPrefix(text(args[1]));
    throw new Error(`strftime no soportado en T-SQL: ${format}`);
  });

  // date(col) → CAST(col AS DATE)  (recorta la hora igual que SQLite)
  out = replaceCall(out, 'date', (args) => {
    if (args.length !== 1) return null;
    return `CAST((${text(args[0])}) AS DATE)`;
  });

  // substr(col, 1, 7) → recorte a "yyyy-mm"; cualquier otra llamada pasa a
  // SUBSTRING, que es el equivalente estándar de T-SQL.
  out = replaceCall(out, 'substr', (args) => {
    if (args.length === 3 && text(args[1]).trim() === '1' && text(args[2]).trim() === '7') {
      return monthPrefix(text(args[0]));
    }
    if (args.length === 3) return `SUBSTRING(${text(args[0])}, ${text(args[1])}, ${text(args[2])})`;
    return null;
  });

  // json_extract(sess, '$.userId') → CAST(JSON_VALUE(sess, '$.userId') AS INT)
  out = replaceCall(out, 'json_extract', (args) => {
    if (args.length !== 2) return null;
    const path = literalString(args[1]);
    if (!path) return null;
    return `CAST(JSON_VALUE(${text(args[0])}, '${path.replace(/'/g, "''")}') AS INT)`;
  });

  // julianday(col) → días desde una época fija con coma flotante. Solo se usan
  // DIFERENCIAS de julianday, así que la constante de época es irrelevante y
  // el resultado conserva la resolución decimal que da SQLite.
  out = replaceCall(out, 'julianday', (args) => {
    if (args.length !== 1) return null;
    return `(DATEDIFF_BIG(SECOND, '2000-01-01', (${text(args[0])})) / 86400.0)`;
  });

  // AVG sobre enteros trunca en T-SQL y devuelve real en SQLite: se fuerza
  // FLOAT para conservar el promedio con decimales.
  out = replaceCall(out, 'avg', (args) => {
    if (args.length !== 1) return null;
    return `AVG(CAST((${text(args[0])}) AS FLOAT))`;
  });

  // ifnull(a, b) → ISNULL(a, b)
  out = replaceCall(out, 'ifnull', (args) => {
    if (args.length !== 2) return null;
    return `ISNULL(${text(args[0])}, ${text(args[1])})`;
  });

  return out;
}

// ---------------------------------------------------------------------------
// 6. INSERT ... ON CONFLICT / INSERT OR IGNORE → MERGE
// ---------------------------------------------------------------------------

// Conflictos declarados sin cláusula ON CONFLICT (INSERT OR IGNORE). Cada
// entrada debe corresponder a un índice único REAL de src/db/mssql/schema.sql:
// es la única forma de reproducir "ignorar duplicados" sin conocer las
// restricciones de la tabla.
const IGNORE_CONFLICT_COLUMNS = {
  permissions: ['code'],
  role_permissions: ['role_id', 'permission_id'],
  team_members: ['team_id', 'user_id'],
};

// En SQLite varias tablas declaran `name TEXT NOT NULL UNIQUE` (unicidad
// global), mientras que MSSQL declara UNIQUE(organization_id, name). El
// MERGE debe anclarse al índice que EXISTE en SQL Server; el código que usa
// estos upserts siempre lleva organization_id en el INSERT.
const CONFLICT_KEY_OVERRIDES = {
  categories: ['organization_id', 'name'],
  departments: ['organization_id', 'name'],
  kb_categories: ['organization_id', 'name'],
  teams: ['organization_id', 'name'],
};

function parseConflictTarget(tokens) {
  const onIdx = topLevelIndexes(tokens, ['on']).find((i) => {
    const word = nextSignificant(tokens, i + 1);
    return word > -1 && isWord(tokens[word], 'conflict');
  });
  if (onIdx === undefined) return null;

  // cursor: sobre "conflict", y después el token que lo sigue (paréntesis o DO).
  let cursor = nextSignificant(tokens, onIdx + 1);
  cursor = nextSignificant(tokens, cursor + 1);

  let columns = null;
  if (tokens[cursor] && tokens[cursor].t === 'punct' && tokens[cursor].v === '(') {
    const close = matchingParen(tokens, cursor);
    if (close < 0) throw new Error('ON CONFLICT con paréntesis sin cerrar.');
    columns = splitTopLevel(tokens.slice(cursor + 1, close)).map((part) => text(trim(part)));
    cursor = nextSignificant(tokens, close + 1);
  } else if (tokens[cursor] && isWord(tokens[cursor], 'do')) {
    columns = null; // ON CONFLICT DO ... sin columna: solo válido en tablas con clave única obvia
  }

  if (!isWord(tokens[cursor], 'do')) {
    throw new Error(`ON CONFLICT sin cláusula DO: "${text(tokens.slice(onIdx)).slice(0, 80)}"`);
  }

  const afterDo = nextSignificant(tokens, cursor + 1);
  const afterDo2 = nextSignificant(tokens, afterDo + 1);
  if (isWord(tokens[afterDo], 'nothing')) {
    return { columns, mode: 'nothing', assignments: [], start: onIdx };
  }
  if (isWord(tokens[afterDo], 'update') && isWord(tokens[afterDo2], 'set')) {
    return {
      columns,
      mode: 'update',
      assignments: parseAssignments(tokens.slice(afterDo2 + 1)),
      start: onIdx,
    };
  }
  throw new Error(`Cláusula DO no soportada: "${text(tokens.slice(afterDo, afterDo + 3))}"`);
}

function parseAssignments(tokens) {
  return splitTopLevel(tokens).map((part) => {
    const piece = trim(part);
    const eq = piece.findIndex((tok, i) => tok.t === 'punct' && tok.v === '=' && parenDepthAt(piece, i) === 0);
    if (eq < 0) throw new Error(`Asignación de ON CONFLICT sin "=": "${text(piece).slice(0, 60)}"`);
    return { column: text(trim(piece.slice(0, eq))), value: trim(piece.slice(eq + 1)) };
  });
}

// `excluded.col` → `source.col`; `MAX(a, excluded.b)` (escalar de SQLite) →
// el CASE equivalente en T-SQL.
function renderAssignmentValue(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    if (isWord(tokens[i], 'max')) {
      const open = nextSignificant(tokens, i + 1);
      if (open > -1 && tokens[open].t === 'punct' && tokens[open].v === '(') {
        const close = matchingParen(tokens, open);
        if (close > 0) {
          const args = splitTopLevel(tokens.slice(open + 1, close)).map(trim);
          if (args.length === 2) {
            const a = text(renderAssignmentValue(args[0]));
            const b = text(renderAssignmentValue(args[1]));
            out.push(raw(`CASE WHEN (${a}) >= (${b}) THEN (${a}) ELSE (${b}) END`));
            i = close + 1;
            continue;
          }
        }
      }
    }
    if (isWord(tokens[i], 'excluded')) {
      out.push(raw('source'));
      i += 1;
      const dot = nextSignificant(tokens, i);
      if (dot > -1 && tokens[dot].t === 'punct' && tokens[dot].v === '.') {
        out.push(tokens[dot]);
        i = nextSignificant(tokens, dot + 1);
        if (i > -1) {
          out.push(tokens[i]);
          i += 1;
        }
      }
      continue;
    }
    out.push(tokens[i]);
    i++;
  }
  return out;
}

function renderMerge({ table, columns, sourceTokens, conflictColumns, assignments, mode }) {
  const colList = columns.join(', ');
  const match = conflictColumns.map((col) => `target.${col} = source.${col}`).join(' AND ');
  const matched = mode === 'update' && assignments.length
    ? `WHEN MATCHED THEN UPDATE SET ${assignments
        .map((a) => `${a.column} = ${text(renderAssignmentValue(a.value))}`)
        .join(', ')}\n  `
    : '';
  const source = text(sourceTokens).trim();
  return `MERGE ${table} WITH (HOLDLOCK) AS target
  USING (${source}) AS source (${colList})
  ON (${match})
  ${matched}WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${columns.map((c) => `source.${c}`).join(', ')})
  ;`;
}

function resolveConflictColumns(table, columns, declared) {
  const override = CONFLICT_KEY_OVERRIDES[table];
  if (override && declared.every((col) => override.includes(col))) {
    const missing = override.filter((col) => !columns.includes(col));
    if (missing.length) {
      throw new Error(
        `Upsert de "${table}": la clave real de MSSQL (${override.join(', ')}) necesita las ` +
          `columnas ${missing.join(', ')} en el INSERT.`
      );
    }
    return override;
  }
  const missing = declared.filter((col) => !columns.includes(col));
  if (missing.length) {
    throw new Error(`Upsert de "${table}": columna de conflicto ausente en el INSERT: ${missing.join(', ')}`);
  }
  return declared;
}

export function translateInsert(tokens) {
  const insertIdx = topLevelIndexes(tokens, ['insert'])[0];
  if (insertIdx === undefined) return tokens;

  let cursor = nextSignificant(tokens, insertIdx + 1);
  let ignoreMode = false;
  if (isWord(tokens[cursor], 'or')) {
    const mode = nextSignificant(tokens, cursor + 1);
    if (isWord(tokens[mode], 'ignore')) {
      ignoreMode = true;
      cursor = nextSignificant(tokens, mode + 1);
    }
  }
  if (!isWord(tokens[cursor], 'into')) return tokens;
  cursor = nextSignificant(tokens, cursor + 1);

  // Tabla (admite esquema: dbo . tabla).
  const tableTokens = [];
  while (tokens[cursor] && (tokens[cursor].t === 'word' || (tableTokens.length && (
    (tokens[cursor].t === 'punct' && tokens[cursor].v === '.') ||
    (tableTokens[tableTokens.length - 1].t === 'punct' && tableTokens[tableTokens.length - 1].v === '.')
  )))) {
    tableTokens.push(tokens[cursor]);
    cursor++;
  }
  const table = text(tableTokens).trim();
  if (!table) return tokens;
  cursor = nextSignificant(tokens, cursor);

  if (!tokens[cursor] || tokens[cursor].t !== 'punct' || tokens[cursor].v !== '(') return tokens;
  const colsClose = matchingParen(tokens, cursor);
  if (colsClose < 0) throw new Error(`INSERT INTO ${table}: lista de columnas sin cerrar.`);
  const columns = splitTopLevel(tokens.slice(cursor + 1, colsClose)).map((part) => text(trim(part)));
  cursor = nextSignificant(tokens, colsClose + 1);

  if (!isWord(tokens[cursor], 'values') && !isWord(tokens[cursor], 'select')) return tokens;
  const sourceKeyword = cursor;
  const conflict = parseConflictTarget(tokens.slice(sourceKeyword));
  if (!conflict && !ignoreMode) return tokens; // INSERT simple: se deja tal cual.

  let conflictColumns;
  let mode;
  let assignments = [];
  if (conflict) {
    if (!conflict.columns) {
      throw new Error(`ON CONFLICT sobre "${table}" sin columna de conflicto.`);
    }
    conflictColumns = resolveConflictColumns(table, columns, conflict.columns);
    mode = conflict.mode;
    assignments = conflict.assignments;
  } else {
    conflictColumns = IGNORE_CONFLICT_COLUMNS[table];
    if (!conflictColumns) {
      throw new Error(
        `INSERT OR IGNORE sobre "${table}" sin columna de conflicto conocida. ` +
          'Añádala a IGNORE_CONFLICT_COLUMNS en src/db/dialect.js (debe coincidir con un índice único de MSSQL).'
      );
    }
    conflictColumns = resolveConflictColumns(table, columns, conflictColumns);
    mode = 'nothing';
  }

  const sourceTokens = conflict
    ? tokens.slice(sourceKeyword, sourceKeyword + conflict.start)
    : tokens.slice(sourceKeyword);

  const merge = renderMerge({ table, columns, sourceTokens, conflictColumns, assignments, mode });
  return [...tokens.slice(0, insertIdx), raw(merge)];
}

// ---------------------------------------------------------------------------
// 7. Expansión de alias en GROUP BY / HAVING
//
// SQL Server no admite alias en GROUP BY/HAVING (a diferencia de SQLite), así
// que cada alias se sustituye por la expresión del SELECT.
// ---------------------------------------------------------------------------

function selectList(tokens) {
  const selectIdx = topLevelIndexes(tokens, ['select'])[0];
  if (selectIdx === undefined) return null;
  let cursor = selectIdx + 1;
  const distinct = nextSignificant(tokens, cursor);
  if (distinct > -1 && (isWord(tokens[distinct], 'distinct') || isWord(tokens[distinct], 'all'))) {
    cursor = distinct + 1;
  }
  const fromIdx = indexOfWord(tokens, 'from', cursor);
  if (fromIdx === -1) return null;
  return { start: cursor, end: fromIdx };
}

function selectListAliases(tokens) {
  const range = selectList(tokens);
  if (!range) return new Map();
  const aliases = new Map();
  for (const part of splitTopLevel(tokens.slice(range.start, range.end))) {
    const piece = trim(part);
    const asIdx = piece.findIndex((tok, i) => isWord(tok, 'as') && parenDepthAt(piece, i) === 0);
    if (asIdx < 0) continue;
    const name = identifierName(aliasNameAfter(piece, asIdx));
    if (!name) continue;
    const expr = trim(piece.slice(0, asIdx));
    if (expr.length) aliases.set(name, expr);
  }
  return aliases;
}

function expandAliasesInRegion(tokens, start, end, aliases) {
  const out = [];
  for (let i = start; i < end; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const dotted = (prev && prev.t === 'punct' && prev.v === '.') || (next && next.t === 'punct' && next.v === '.');
    const expr = dotted ? null : aliases.get(identifierName(tok));
    if (expr) {
      out.push(raw(`(${text(expr)})`));
      continue;
    }
    out.push(tok);
  }
  return out;
}

export function translateAliasClauses(tokens) {
  const aliases = selectListAliases(tokens);
  if (!aliases.size) return tokens;
  const groupIdx = indexOfWord(tokens, 'group');
  const havingIdx = indexOfWord(tokens, 'having');
  const orderIdx = indexOfWord(tokens, 'order');
  const limitIdx = indexOfWord(tokens, 'limit') ?? indexOfWord(tokens, 'offset');

  const regions = [];
  if (groupIdx !== undefined && isWord(tokens[nextSignificant(tokens, groupIdx + 1)], 'by')) {
    const start = nextSignificant(tokens, groupIdx + 2);
    const ends = [havingIdx, orderIdx, limitIdx].filter((i) => i !== undefined && i > groupIdx);
    regions.push([start, ends.length ? Math.min(...ends) : tokens.length]);
  }
  if (havingIdx !== undefined) {
    const start = nextSignificant(tokens, havingIdx + 1);
    const ends = [orderIdx, limitIdx].filter((i) => i !== undefined && i > havingIdx);
    regions.push([start, ends.length ? Math.min(...ends) : tokens.length]);
  }
  if (!regions.length) return tokens;

  let out = tokens;
  for (const [start, end] of regions) {
    out = [...out.slice(0, start), ...expandAliasesInRegion(out, start, end, aliases), ...out.slice(end)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Expansión de GROUP BY para SQL Server
//
// SQLite agrupa y devuelve cualquier columna del grupo; SQL Server exige que
// toda columna del SELECT esté en GROUP BY o dentro de un agregado. Aquí se
// añaden al GROUP BY las expresiones no agregadas que falten. Solo cambia el
// resultado si la expresión NO dependía funcionalmente de las claves de
// agrupación originales; en todas las consultas de este repositorio las
// columnas añadidas (nombres, colores, posiciones) pertenecen a la tabla
// cuya clave ya agrupa, así que el número de grupos no varía.
// ---------------------------------------------------------------------------

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

function hasAggregate(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // Las funciones ya traducidas llegan como tokens `raw`; se inspecciona su
    // texto para no perder el carácter de agregado (p. ej. AVG(CAST(...))).
    if (tok.t === 'raw') {
      if (/\b(count|sum|avg|min|max)\s*\(/i.test(tok.v)) return true;
      continue;
    }
    if (tok.t === 'word' && AGGREGATES.has(tok.v.toLowerCase())) {
      const open = nextSignificant(tokens, i + 1);
      if (open > -1 && tokens[open].t === 'punct' && tokens[open].v === '(') return true;
    }
  }
  return false;
}

function isStar(tokens) {
  const first = tokens[0];
  if (!first) return false;
  if (first.t === 'punct' && first.v === '*') return true;
  if (first.t === 'word' && tokens[1] && tokens[1].t === 'punct' && tokens[1].v === '.'
      && tokens[2] && tokens[2].t === 'punct' && tokens[2].v === '*') return true;
  return false;
}

export function expandGroupBy(tokens) {
  const groupIdx = indexOfWord(tokens, 'group');
  if (groupIdx === undefined) return tokens;
  const byWord = nextSignificant(tokens, groupIdx + 1);
  if (!isWord(tokens[byWord], 'by')) return tokens;

  const start = nextSignificant(tokens, byWord + 1);
  const havingIdx = indexOfWord(tokens, 'having');
  const orderIdx = indexOfWord(tokens, 'order');
  const limitIdx = indexOfWord(tokens, 'limit') ?? indexOfWord(tokens, 'offset');
  const ends = [havingIdx, orderIdx, limitIdx].filter((i) => i !== undefined && i > groupIdx);
  const end = ends.length ? Math.min(...ends) : tokens.length;

  const groupItems = splitTopLevel(tokens.slice(start, end)).map(trim);
  const groupKeys = new Set(groupItems.filter((g) => g.length).map(norm));

  const range = selectList(tokens);
  if (!range) return tokens;

  const additions = [];
  for (const part of splitTopLevel(tokens.slice(range.start, range.end))) {
    const piece = trim(part);
    if (!piece.length) continue;
    const asIdx = piece.findIndex((tok, i) => isWord(tok, 'as') && parenDepthAt(piece, i) === 0);
    const expr = asIdx >= 0 ? trim(piece.slice(0, asIdx)) : piece;
    if (!expr.length || isStar(expr) || hasAggregate(expr)) continue;
    const key = norm(expr);
    if (groupKeys.has(key)) continue;
    groupKeys.add(key);
    additions.push(expr);
  }
  if (!additions.length) return tokens;

  // Se recorta el espacio que quedó al final de la región para que las
  // expresiones añadidas no se peguen a la cláusula siguiente.
  let head = tokens.slice(0, end);
  while (head.length && (head[head.length - 1].t === 'ws' || head[head.length - 1].t === 'comment')) {
    head.pop();
  }
  const tail = tokens.slice(end);
  const hasItems = groupItems.some((g) => g.length);
  const inserted = [];
  for (const expr of additions) {
    if (inserted.length || hasItems) inserted.push({ t: 'punct', v: ',' });
    inserted.push({ t: 'ws', v: ' ' }, ...expr);
  }
  const separator = tail.length && tail[0].t === 'ws' ? [] : [{ t: 'ws', v: ' ' }];
  return [...head, ...inserted, ...separator, ...tail];
}

// ---------------------------------------------------------------------------
// 9. LIMIT / OFFSET → OFFSET ... ROWS FETCH NEXT ... ROWS ONLY
// ---------------------------------------------------------------------------

export function translateLimit(tokens) {
  const limitIdx = indexOfWord(tokens, 'limit');
  if (limitIdx === undefined) {
    if (indexOfWord(tokens, 'offset') !== undefined) {
      throw new Error('OFFSET sin LIMIT no está soportado en T-SQL: usa LIMIT y OFFSET juntos.');
    }
    return tokens;
  }

  const end = statementEnd(tokens);
  const offsetIdx = indexOfWord(tokens, 'offset', limitIdx);

  const argsStart = nextSignificant(tokens, limitIdx + 1);
  const argsEnd = offsetIdx !== undefined && offsetIdx < end ? offsetIdx : end;
  const limitArgs = trim(tokens.slice(argsStart, argsEnd));
  const offsetArgs = offsetIdx === undefined
    ? []
    : trim(tokens.slice(nextSignificant(tokens, offsetIdx + 1), end));
  if (!limitArgs.length) throw new Error('LIMIT sin argumentos.');

  const orderBefore = topLevelIndexes(tokens.slice(0, limitIdx), ['order']).some(
    (i) => isWord(tokens[nextSignificant(tokens, i + 1)], 'by')
  );
  const orderClause = orderBefore ? '' : 'ORDER BY (SELECT NULL) ';
  const offsetClause = offsetArgs.length ? `OFFSET ${text(offsetArgs)} ROWS` : 'OFFSET 0 ROWS';
  const fetchClause = ` FETCH NEXT ${text(limitArgs)} ROWS ONLY`;
  const replacement = raw(`${orderClause}${offsetClause}${fetchClause}`);

  return [...tokens.slice(0, limitIdx), replacement, ...tokens.slice(end)];
}

// ---------------------------------------------------------------------------
// 10. Sentencias que NO se traducen: fallar ruidosamente
// ---------------------------------------------------------------------------

const SQLITE_ONLY = [
  ['LIMIT', /\bLIMIT\b/i],
  ['ON CONFLICT', /\bON\s+CONFLICT\b/i],
  ['INSERT OR IGNORE', /\bINSERT\s+OR\s+IGNORE\b/i],
  ['REPLACE INTO', /\bREPLACE\s+INTO\b/i],
  ['RETURNING', /\bRETURNING\b/i],
  ['strftime(', /\bstrftime\s*\(/i],
  ['julianday(', /\bjulianday\s*\(/i],
  ['datetime(', /\bdatetime\s*\(/i],
  ['json_extract(', /\bjson_extract\s*\(/i],
  ['substr(', /\bsubstr\s*\(/i],
  ['ifnull(', /\bifnull\s*\(/i],
  ['random(', /\brandom\s*\(/i],
  ['printf(', /\bprintf\s*\(/i],
  ['instr(', /\binstr\s*\(/i],
  ['last_insert_rowid()', /\blast_insert_rowid\s*\(/i],
  ['group_concat(', /\bgroup_concat\s*\(/i],
  ['PRAGMA', /\bPRAGMA\b/i],
  ['sqlite_master / sqlite_sequence', /\bsqlite_/i],
  ['AUTOINCREMENT', /\bAUTOINCREMENT\b/i],
  ['WITHOUT ROWID', /\bWITHOUT\s+ROWID\b/i],
  ['COLLATE NOCASE', /\bCOLLATE\s+NOCASE\b/i],
  ['literales TRUE/FALSE', /\b(TRUE|FALSE)\b/i],
  ['GLOB', /\bGLOB\b/i],
  ['operador ||', /\|\|/],
];

export function findSqliteOnly(sql) {
  const found = [];
  const stripped = tokenize(sql)
    .filter((tok) => tok.t !== 'string' && tok.t !== 'dq' && tok.t !== 'comment')
    .map((tok) => tok.v)
    .join(' ');
  for (const [label, pattern] of SQLITE_ONLY) {
    if (pattern.test(stripped)) found.push(label);
  }
  return found;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function translateStatement(tokens, state) {
  let out = tokens;
  out = translatePlaceholders(out, state);
  out = translateConcat(out);
  out = translateCollate(out);
  out = quoteReservedIdentifiers(out);
  out = translateFunctions(out);
  out = translateInsert(out);
  out = translateAliasClauses(out);
  out = expandGroupBy(out);
  out = translateLimit(out);
  return out;
}

/**
 * Traduce una sentencia SQLite a T-SQL.
 *
 * @param {string} sql Sentencia (o lote separado por ";") con parámetros `?`.
 * @param {object} [options]
 * @param {boolean} [options.insertId] Si la sentencia es un INSERT del que se
 *   necesita el id generado, añade `SELECT CAST(SCOPE_IDENTITY() AS INT) AS id`.
 * @returns {string} Sentencia lista para SQL Server.
 */
export function toTsql(sql, { insertId = false } = {}) {
  if (!/^\s*(select|insert|update|delete|with)\b/i.test(sql)) {
    throw new Error(`Sentencia no soportada por el traductor: ${sql.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  const statements = splitStatements(tokenize(sql));
  if (!statements.length) throw new Error('Sentencia vacía.');
  if (insertId && statements.length > 1) {
    throw new Error('insertId solo se admite con una única sentencia INSERT.');
  }

  const state = { n: 0 };
  const rendered = statements.map((statement) => {
    const out = text(translateStatement(statement, state)).trim();
    const leftovers = findSqliteOnly(out);
    if (leftovers.length) {
      throw new Error(
        `La sentencia aún contiene construcciones de SQLite no traducidas (${leftovers.join(', ')}). ` +
          `Traducirla en src/db/dialect.js antes de usarla con DB_CLIENT=mssql.\nSQL: ${out.slice(0, 300)}`
      );
    }
    return out;
  }).join('; ');

  if (insertId) {
    if (!/^\s*insert\b/i.test(rendered)) {
      throw new Error('insertId solo se admite con INSERT.');
    }
    return `${rendered}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`;
  }
  return rendered;
}
