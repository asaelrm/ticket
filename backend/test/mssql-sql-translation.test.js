import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTsql, findSqliteOnly } from '../src/db/dialect.js';

// Prueba de regresión de compatibilidad MSSQL.
//
// Recorre TODAS las sentencias SQL estáticas de backend/src (las que NO
// contienen interpolación `${...}`, es decir, las que se enviarían tal cual al
// motor) y las hace pasar por el traductor SQLite -> T-SQL. Falla si alguna:
//   - lanza al traducir (construcción no soportada), o
//   - deja restos de SQLite sin traducir (LIMIT, ON CONFLICT, strftime...).
//
// Se excluyen los módulos específicos de SQLite (db.js, db/sqlite.js, el propio
// dialecto y el contrato mssql); se incluye db/mssql/schemaValidator.js porque
// sus SELECT de catálogo también viajan por la fachada de runtime en modo MSSQL.

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', 'src');

function listSourceFiles() {
  return fs.readdirSync(srcRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith('.js'))
    .map((entry) => path.join(srcRoot, entry))
    .filter((full) => {
      const rel = path.relative(srcRoot, full).split(path.sep).join('/');
      if (rel === 'db/mssql/schemaValidator.js') return true;
      if (rel === 'db.js' || rel.startsWith('db/')) return false;
      return true;
    });
}

const STATEMENT_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
const LITERAL_PATTERNS = [
  /`([^`]*)`/gs,
  /"((?:[^"\\]|\\.)*)"/g,
  /'((?:[^'\\]|\\.)*)'/g,
];

function collectStatements() {
  const statements = [];
  for (const file of listSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of LITERAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const sql = match[1];
        if (sql.includes('${')) continue; // SQL dinámica: no es validable de forma estática
        if (!STATEMENT_START.test(sql)) continue;
        statements.push({ file: path.relative(srcRoot, file), sql });
      }
    }
  }
  return statements;
}

describe('MSSQL: toda la SQL estática de src se traduce a T-SQL sin restos de SQLite', () => {
  const statements = collectStatements();

  it('encuentra un conjunto representativo de sentencias (el escáner no está vacío)', () => {
    assert.ok(statements.length >= 150, `solo se encontraron ${statements.length} sentencias`);
  });

  it('ninguna sentencia estática lanza ni deja construcciones SQLite', () => {
    const failures = [];
    for (const { file, sql } of statements) {
      const label = `${file}: ${sql.slice(0, 100).replace(/\s+/g, ' ')}`;
      try {
        const out = toTsql(sql);
        const leftovers = findSqliteOnly(out);
        if (leftovers.length) failures.push(`${label} -> restos: ${leftovers.join(', ')}`);
      } catch (error) {
        failures.push(`${label} -> ${error.message}`);
      }
    }
    assert.deepEqual(failures, [], `Sentencias incompatibles con MSSQL:\n${failures.join('\n')}`);
  });
});
