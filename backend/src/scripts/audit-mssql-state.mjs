// B13-C · AUDITORÍA de solo lectura del estado de SIFHA_Tickets_DEV.
// NO escribe nada: solo SELECT sobre sys y conteos.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sql from 'mssql';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: config } = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'config.js')).href);

const log = console.log;
const pool = await sql.connect(config.mssql);

try {
  const who = (await pool.request().query(`
    SELECT DB_NAME() AS db, ORIGINAL_LOGIN() AS login,
           HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create_table
  `)).recordset[0];
  log(`[audit] db=${who.db} login=${who.login} can_create_table=${who.can_create_table}`);

  const ver = (await pool.request().query(
    "SELECT SERVERPROPERTY('ProductVersion') AS pv, SERVERPROPERTY('Edition') AS ed")).recordset[0];
  log(`[audit] servidor=${ver.pv} ${ver.ed}`);

  log('\n[audit] === TABLAS EXISTENTES ===');
  const tables = (await pool.request().query(`
    SELECT t.name AS name, c.object_id AS object_id
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.objects c ON c.object_id = t.object_id
    WHERE s.name = 'dbo' ORDER BY t.name
  `)).recordset;

  for (const t of tables) {
    const n = (await pool.request()
      .query(`SELECT COUNT_BIG(*) AS n FROM [dbo].[${t.name}]`)).recordset[0].n;
    const ident = (await pool.request().query(`
      SELECT c.name AS col, ic.is_identity, ic.seed_value, ic.increment_value, ic.last_value
      FROM sys.columns c JOIN sys.identity_columns ic
        ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE c.object_id = ${t.object_id}`)).recordset;
    const idTxt = ident.length
      ? ident.map((i) => `${i.col} IDENTITY(seed=${i.seed_value},inc=${i.increment_value},last=${i.last_value})`).join(' ')
      : 'sin IDENTITY';
    log(`  ${String(n).padStart(5)} filas  ${t.name.padEnd(24)} ${idTxt}`);
  }

  log('\n[audit] === FKs (orden de dependencia) ===');
  const fks = (await pool.request().query(`
    SELECT fk.name AS fk_name, OBJECT_NAME(fk.parent_object_id) AS child,
           cp.name AS child_col, OBJECT_NAME(fk.referenced_object_id) AS parent,
           cr.name AS parent_col, fk.delete_referential_action_desc AS on_delete
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
    JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
    WHERE OBJECT_NAME(fk.parent_object_id) IN (SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo'))
    ORDER BY parent, child`)).recordset;
  for (const f of fks) log(`  ${f.child}.${f.child_col} -> ${f.parent}.${f.parent_col}  (${f.on_delete})`);

  log('\n[audit] === ÍNDICES ÚNICOS (claves lógicas disponibles) ===');
  const uqs = (await pool.request().query(`
    SELECT OBJECT_NAME(i.object_id) AS tbl, i.name AS idx, i.is_unique AS uniq, i.is_primary_key AS pk,
           (SELECT STRING_AGG(c2.name, ', ') WITHIN GROUP (ORDER BY ic2.key_ordinal)
              FROM sys.index_columns ic2
              JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
             WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
               AND ic2.key_ordinal > 0) AS cols
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    WHERE t.schema_id = SCHEMA_ID('dbo') AND (i.is_unique = 1 OR i.is_primary_key = 1)
    ORDER BY tbl, i.name`)).recordset;
  for (const u of uqs) log(`  ${u.tbl.padEnd(22)} ${u.pk ? 'PK ' : 'UQ '} ${u.cols}`);

  log('\n[audit] === CONTENIDO ACTUAL DE CATÁLOGOS ===');
  for (const tbl of ['roles', 'permissions', 'role_permissions', 'categories', 'kb_categories', 'departments', 'users', 'sequences', 'settings', 'teams']) {
    const exists = tables.some((t) => t.name === tbl);
    if (!exists) { log(`  ${tbl}: NO EXISTE`); continue; }
    const rows = (await pool.request().query(`SELECT * FROM dbo.${tbl}`)).recordset;
    log(`  ${tbl}: ${rows.length} filas`);
    for (const r of rows.slice(0, 30)) {
      const { password_hash, ...rest } = r;
      log(`      ${JSON.stringify(rest)}`);
    }
    if (rows.length > 30) log(`      ... y ${rows.length - 30} más`);
  }
} finally {
  await pool.close();
}