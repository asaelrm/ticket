import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toTsql, tokenize, placeholderCount, findSqliteOnly } from '../src/db/dialect.js';

// Colapsa espacios para comparar SQL multilínea sin depender del formato.
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

describe('dialect: parámetros y cadenas', () => {
  it('convierte ? posicionales en @pN respetando el orden', () => {
    assert.equal(
      toTsql('SELECT id FROM tickets WHERE title LIKE ? AND status = ?'),
      'SELECT id FROM tickets WHERE title LIKE @p0 AND status = @p1'
    );
    assert.equal(placeholderCount('SELECT * FROM t WHERE a = ? AND b = ?'), 2);
  });

  it('NUNCA toca ? ni comentarios dentro de cadenas o comentarios', () => {
    const sql = "SELECT id FROM t WHERE a LIKE '%?%' -- LIMIT 6\n AND b = ?";
    const out = toTsql(sql);
    assert.match(out, /'%\?%'/);
    assert.match(out, /-- LIMIT 6/);
    assert.match(out, /b = @p0/);
  });

  it('|| pasa a + sin alterar cadenas', () => {
    const out = toTsql(`SELECT r.name || ' ' || r.last_name AS reporter FROM users r`);
    assert.equal(out, `SELECT r.name + ' ' + r.last_name AS reporter FROM users r`);
  });

  it('tokeniza cadenas escapadas, corchetes y comentarios multilínea', () => {
    const tokens = tokenize("SELECT 'a''b', [key], /* c */ x -- fin");
    assert.ok(tokens.some((t) => t.t === 'string' && t.v === "'a''b'"));
    assert.ok(tokens.some((t) => t.t === 'bracket' && t.v === '[key]'));
    assert.ok(tokens.some((t) => t.t === 'comment' && t.v === '/* c */'));
  });
});

describe('dialect: funciones de fecha y json', () => {
  it("strftime('%Y-%m-%dT%H:%M:%fZ', 'now') → SYSUTCDATETIME()", () => {
    const out = toTsql(`SELECT id FROM tickets WHERE t.sla_due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
    assert.match(out, /t\.sla_due_at < SYSUTCDATETIME\(\)/);
    assert.doesNotMatch(out, /strftime/i);
  });

  it("strftime('%Y-%m', col) recorta a yyyy-mm", () => {
    const out = toTsql(`SELECT COUNT(*) AS n FROM tickets WHERE strftime('%Y-%m', created_at) = ?`);
    assert.match(out, /LEFT\(CONVERT\(VARCHAR\(33\), created_at, 126\), 7\) = @p0/);
  });

  it('date(col) → CAST(col AS DATE)', () => {
    const out = toTsql(
      `SELECT date(COALESCE(t.resolved_at, t.closed_at)) AS day, COUNT(*) AS n FROM tickets t GROUP BY day`
    );
    assert.match(out, /CAST\(\(COALESCE\(t\.resolved_at, t\.closed_at\)\) AS DATE\) AS \[day\]/);
    assert.doesNotMatch(out, /\bdate\s*\(/i);
  });

  it('substr(col, 1, 7) recorta a yyyy-mm y substr genérico pasa a SUBSTRING', () => {
    const out = toTsql(
      `SELECT substr(COALESCE(t.csat_answered_at, t.updated_at), 1, 7) AS month FROM tickets t`
    );
    assert.match(out, /LEFT\(CONVERT\(VARCHAR\(33\), COALESCE\(t\.csat_answered_at, t\.updated_at\), 126\), 7\) AS \[month\]/);
    const gen = toTsql(`SELECT substr(username, 1, 3) FROM users`);
    assert.equal(gen, 'SELECT SUBSTRING(username, 1, 3) FROM users');
  });

  it('julianday() → DATEDIFF_BIG en días con decimales', () => {
    const out = toTsql(
      `SELECT AVG((julianday(COALESCE(t.resolved_at, t.closed_at)) - julianday(t.created_at)) * 24) AS hours FROM tickets t`
    );
    assert.match(out, /AVG\(CAST\(\(/);
    assert.match(out, /DATEDIFF_BIG\(SECOND, '2000-01-01', \(COALESCE\(t\.resolved_at, t\.closed_at\)\)\) \/ 86400\.0/);
    assert.doesNotMatch(out, /julianday/i);
  });

  it('json_extract numérico → CAST(JSON_VALUE(...) AS INT)', () => {
    const out = toTsql(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`);
    assert.equal(out, `DELETE FROM sessions WHERE CAST(JSON_VALUE(sess, '$.userId') AS INT) = @p0`);
  });

  it('AVG sobre enteros se fuerza a FLOAT (SQLite devuelve real)', () => {
    const out = toTsql(`SELECT AVG(t.csat_rating) AS average FROM tickets t`);
    assert.equal(out, 'SELECT AVG(CAST((t.csat_rating) AS FLOAT)) AS average FROM tickets t');
  });
});

describe('dialect: paginación y orden', () => {
  it('LIMIT sin ORDER BY añade un orden estable y OFFSET 0', () => {
    const out = toTsql(`SELECT id FROM tickets WHERE a = ? ORDER BY id LIMIT 6`);
    assert.equal(out, 'SELECT id FROM tickets WHERE a = @p0 ORDER BY id OFFSET 0 ROWS FETCH NEXT 6 ROWS ONLY');
    const noOrder = toTsql(`SELECT id FROM tickets LIMIT 6`);
    assert.equal(noOrder, 'SELECT id FROM tickets ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 6 ROWS ONLY');
  });

  it('LIMIT ? OFFSET ? numera los argumentos en orden de aparición', () => {
    const out = toTsql(`SELECT id FROM t ORDER BY id LIMIT ? OFFSET ?`);
    assert.equal(out, 'SELECT id FROM t ORDER BY id OFFSET @p1 ROWS FETCH NEXT @p0 ROWS ONLY');
  });

  it('COLLATE NOCASE → colación CI de SQL Server', () => {
    const out = toTsql('SELECT id FROM departments d ORDER BY d.name COLLATE NOCASE');
    assert.equal(out, 'SELECT id FROM departments d ORDER BY d.name COLLATE Latin1_General_CI_AS');
  });

  it('las palabras reservadas usadas como identificadores se entrecomillan', () => {
    const out = toTsql(`SELECT key, value FROM settings WHERE key = ?`);
    assert.equal(out, 'SELECT [key], [value] FROM settings WHERE [key] = @p0');
    const alias = toTsql(`SELECT COUNT(*) AS open FROM tickets`);
    assert.equal(alias, 'SELECT COUNT(*) AS [open] FROM tickets');
  });
});

describe('dialect: GROUP BY y HAVING', () => {
  it('sustituye alias de GROUP BY por la expresión del SELECT', () => {
    const out = toTsql(
      `SELECT date(COALESCE(t.resolved_at, t.closed_at)) AS day, COUNT(*) AS n
       FROM tickets t GROUP BY day ORDER BY day DESC LIMIT 30`
    );
    assert.match(out, /GROUP BY \(CAST\(\(COALESCE\(t\.resolved_at, t\.closed_at\)\) AS DATE\)/);
    assert.match(out, /ORDER BY \[day\] DESC OFFSET 0 ROWS FETCH NEXT 30 ROWS ONLY/);
  });

  it('sustituye alias de HAVING y conserva ORDER BY sobre alias', () => {
    const out = toTsql(
      `SELECT c.name AS label, COUNT(*) AS responses, AVG(t.csat_rating) AS average
       FROM tickets t GROUP BY c.id HAVING responses > 0 ORDER BY responses DESC, average DESC`
    );
    assert.match(out, /HAVING \(COUNT\(\*\)\) > 0/);
    assert.match(out, /ORDER BY responses DESC, average DESC/);
  });

  it('añade al GROUP BY las columnas no agregadas que SQL Server exige', () => {
    const out = toTsql(
      `SELECT c.id, c.name, c.color, COUNT(t.id) AS n,
        SUM(CASE WHEN t.status IN (?, ?) THEN 1 ELSE 0 END) AS open
       FROM categories c LEFT JOIN tickets t ON t.category_id = c.id
       GROUP BY c.id ORDER BY n DESC, c.name ASC`
    );
    assert.match(out, /GROUP BY c\.id, c\.name, c\.color ORDER BY n DESC, c\.name ASC/);
    // El agregado NO se añade y el alias reservado queda entrellavado.
    assert.match(out, /AS \[open\]/);
    assert.doesNotMatch(out, /GROUP BY c\.id, c\.name, c\.color, COUNT/);
  });

  it('añade las expresiones compuestas (by-technician / by-reporter)', () => {
    const out = toTsql(
      `SELECT u.id, u.name || ' ' || u.last_name AS technician, COUNT(*) AS active
       FROM tickets t JOIN users u ON u.id = t.assigned_to_id
       GROUP BY u.id ORDER BY active DESC LIMIT 10`
    );
    assert.match(
      out,
      /GROUP BY u\.id, u\.name \+ ' ' \+ u\.last_name ORDER BY active DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY/
    );
  });

  it('no toca GROUP BY cuando el SELECT solo lleva agregados', () => {
    const out = toTsql(`SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC`);
    assert.equal(out, 'SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC');
  });
});

describe('dialect: upserts', () => {
  it('INSERT OR IGNORE → MERGE anclado al índice único real', () => {
    const out = toTsql('INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)');
    assert.match(out, /MERGE permissions WITH \(HOLDLOCK\) AS target/);
    assert.match(out, /USING \(VALUES \(@p0, @p1\)\) AS source \(code, description\)/);
    assert.match(out, /ON \(target\.code = source\.code\)/);
    assert.match(out, /WHEN NOT MATCHED THEN INSERT \(code, description\) VALUES \(source\.code, source\.description\)/);
    // DO NOTHING: no debe generar cláusula WHEN MATCHED.
    assert.doesNotMatch(out, /WHEN MATCHED/);
  });

  it('ON CONFLICT ... DO UPDATE → MERGE con excluded reescrito a source', () => {
    const out = toTsql(
      `INSERT INTO roles (code, name, description) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description`
    );
    assert.match(out, /ON \(target\.code = source\.code\)/);
    assert.match(out, /WHEN MATCHED THEN UPDATE SET name = source\.name, description = source\.description/);
    assert.doesNotMatch(out, /excluded/i);
    assert.doesNotMatch(out, /ON CONFLICT/i);
  });

  it('las tablas con UNIQUE global en SQLite usan la clave compuesta de MSSQL', () => {
    const out = toTsql(
      `INSERT INTO categories (name, description, color, organization_id) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, color = excluded.color`
    );
    assert.match(out, /ON \(target\.organization_id = source\.organization_id AND target\.name = source\.name\)/);
    assert.match(out, /VALUES \(source\.name, source\.description, source\.color, source\.organization_id\)/);
  });

  it('MAX(a, excluded.b) (escalar de SQLite) → CASE equivalente', () => {
    const out = toTsql(
      `INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`
    );
    assert.match(out, /\[value\] = CASE WHEN \(\[value\]\) >= \(source\.\[value\]\) THEN \(\[value\]\) ELSE \(source\.\[value\]\) END/);
  });

  it('respetan las claves declaradas: settings.key, org_settings, sessions, team_members', () => {
    const settings = toTsql(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    );
    assert.match(settings, /MERGE settings WITH \(HOLDLOCK\)/);
    assert.match(settings, /target\.\[key\] = source\.\[key\]/);
    assert.match(settings, /AS source \(\[key\], \[value\], updated_by, updated_at\)/);

    const orgSettings = toTsql(
      `INSERT INTO org_settings (organization_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value`
    );
    assert.match(orgSettings, /ON \(target\.organization_id = source\.organization_id AND target\.\[key\] = source\.\[key\]\)/);

    const sessions = toTsql(
      `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`
    );
    assert.match(sessions, /ON \(target\.sid = source\.sid\)/);
    assert.match(sessions, /SET sess = source\.sess, expire = source\.expire/);

    const members = toTsql('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)');
    assert.match(members, /ON \(target\.team_id = source\.team_id AND target\.user_id = source\.user_id\)/);
  });

  it('un INSERT simple se traduce solo en parámetros y funciones', () => {
    const out = toTsql(
      `INSERT INTO users (name, username, last_password_change_at) VALUES (?, ?, ?)`
    );
    assert.equal(out, 'INSERT INTO users (name, username, last_password_change_at) VALUES (@p0, @p1, @p2)');
    assert.doesNotMatch(out, /MERGE/);
  });

  it('insertId añade la recuperación del identificador generado', () => {
    const out = toTsql('INSERT INTO tickets (title) VALUES (?)', { insertId: true });
    assert.equal(
      out,
      'INSERT INTO tickets (title) VALUES (@p0); SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;'
    );
    assert.throws(() => toTsql('SELECT 1 FROM x', { insertId: true }), /solo se admite con INSERT/);
    assert.throws(
      () => toTsql('INSERT INTO a (x) VALUES (?); INSERT INTO b (y) VALUES (?)', { insertId: true }),
      /única sentencia/
    );
  });
});

describe('dialect: rechazo ruidoso de SQLite', () => {
  it('detecta construcciones no traducidas', () => {
    assert.deepEqual(findSqliteOnly('SELECT id FROM t LIMIT 5'), ['LIMIT']);
    assert.deepEqual(findSqliteOnly(`SELECT strftime('%Y', x) FROM t`), ['strftime(']);
    assert.ok(findSqliteOnly(`SELECT 1 WHERE a = TRUE`).includes('literales TRUE/FALSE'));
    assert.deepEqual(findSqliteOnly(`SELECT name FROM sqlite_master`), ['sqlite_master / sqlite_sequence']);
    // Un ? dentro de una cadena no es parámetro.
    assert.deepEqual(findSqliteOnly("SELECT 'a LIMIT 1' AS x"), []);
  });

  it('toTsql lanza error si queda una construcción de SQLite', () => {
    assert.throws(() => toTsql('SELECT id FROM t RETURNING id'), /no traducidas/);
    assert.throws(() => toTsql(`SELECT random() AS r`), /no traducidas/);
    assert.throws(() => toTsql(`SELECT strftime('%d', created_at) FROM t`), /strftime no soportado/);
    assert.throws(() => toTsql('PRAGMA foreign_keys = ON'), /no soportada por el traductor/);
    assert.throws(
      () => toTsql('INSERT OR IGNORE INTO sin_indice_conocido (a) VALUES (?)'),
      /sin columna de conflicto conocida/
    );
  });

  it('un INSERT OR IGNORE sin columna en conflicto conocida también falla', () => {
    assert.throws(
      () => toTsql('INSERT OR IGNORE INTO ticket_history (ticket_id, action) VALUES (?, ?)'),
      /sin columna de conflicto conocida/
    );
  });

  it('procesa lotes de varias sentencias', () => {
    const out = toTsql('SELECT id FROM a WHERE x = ?; SELECT id FROM b WHERE y = ?');
    assert.equal(out, 'SELECT id FROM a WHERE x = @p0; SELECT id FROM b WHERE y = @p1');
  });
});
