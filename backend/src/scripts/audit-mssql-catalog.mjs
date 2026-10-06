// B13-C · AUDITORÍA DE CATÁLOGO de SIFHA_Tickets_DEV, solo lectura.
//
// Responde a la contradicción entre la auditoría de `sifha_ticket_dev`
// (6 tablas) y el seed real corriendo con `sifha_migration_dev`
// (SEED_MISSING_TABLES: permissions, roles, role_permissions, users).
//
// Usa EXACTAMENTE la misma configuración DB_* que seed-mssql.mjs
// (env -> src/config.js -> createMssqlContract). NO escribe nada: solo SELECT
// sobre sys / INFORMATION_SCHEMA, HAS_PERMS_BY_NAME y conteos.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sql from 'mssql';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: config } = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'config.js')).href);

const pool = await sql.connect(config.mssql);
const REQUIRED_TABLES = [
  'dbo.departments', 'dbo.permissions', 'dbo.roles', 'dbo.role_permissions',
  'dbo.sessions', 'dbo.users',
];

try {
  const log = (s = '') => console.log(s);

  // 1-5. Quién soy y en qué base.
  const who = (await pool.request().query(`
    SELECT DB_NAME()          AS db,
           CONVERT(nvarchar(128), @@SERVERNAME) AS server_name,
           SUSER_SNAME()      AS suser,
           SCHEMA_NAME()      AS schema_name,
           USER_NAME()        AS user_name,
           ORIGINAL_LOGIN()   AS original_login
  `)).recordset[0];
  log('=== 1-5. CONTEXTO DE CONEXIÓN ===');
  log(`  DB_NAME()     = ${who.db}`);
  log(`  @@SERVERNAME  = ${who.server_name}`);
  log(`  SUSER_SNAME() = ${who.suser}`);
  log(`  SCHEMA_NAME() = ${who.schema_name}`);
  log(`  USER_NAME()   = ${who.user_name}`);
  log(`  ORIGINAL_LOGIN() = ${who.original_login}`);

  // 6. sys.tables + sys.schemas: exactamente la vista que usa el seed.
  log('\n=== 6. sys.tables + sys.schemas (lo que VE este login) ===');
  const seedView = (await pool.request().query(`
    SELECT t.name AS name, s.name AS schema_name, t.object_id
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    ORDER BY s.name, t.name`)).recordset;
  for (const t of seedView) log(`  [${t.schema_name}].${t.name}  object_id=${t.object_id}`);
  log(`  total tablas visibles: ${seedView.length}`);

  // 7. OBJECT_ID de cada tabla requerida.
  log('\n=== 7. OBJECT_ID(N\'dbo.X\') ===');
  const objChecks = [];
  for (const full of REQUIRED_TABLES) {
    const r = (await pool.request()
      .input('full', sql.NVarChar, full)
      .query('SELECT OBJECT_ID(@full) AS object_id')).recordset[0];
    objChecks.push({ tabla: full, object_id: r.object_id });
    log(`  ${full}  ->  ${r.object_id ?? 'NULL'}`);
  }

  // 8. INFORMATION_SCHEMA.TABLES para las requeridas.
  log('\n=== 8. INFORMATION_SCHEMA.TABLES (mismos filtros de visibilidad) ===');
  const ischema = (await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = N'BASE TABLE'
    ORDER BY TABLE_NAME`)).recordset;
  for (const t of ischema) log(`  ${t.TABLE_SCHEMA}.${t.TABLE_NAME}`);
  log(`  total filas: ${ischema.length}`);

  // 9. Permisos efectivos de ESTE login sobre las tablas.
  log('\n=== 9. HAS_PERMS_BY_NAME de este login ===');
  const permsTable = (await pool.request().query(`
    SELECT OBJECT_SCHEMA_NAME(t.object_id) AS sch, t.name AS tbl
    FROM sys.tables t
    WHERE OBJECT_SCHEMA_NAME(t.object_id) = N'dbo'
    ORDER BY t.name`)).recordset;
  for (const t of permsTable) {
    const full = `dbo.${t.tbl}`;
    const r = (await pool.request()
      .input('full', sql.NVarChar, full)
      .query(`
        SELECT HAS_PERMS_BY_NAME(@full, N'OBJECT', N'SELECT')        AS s,
               HAS_PERMS_BY_NAME(@full, N'OBJECT', N'INSERT')        AS i,
               HAS_PERMS_BY_NAME(@full, N'OBJECT', N'UPDATE')        AS u,
               HAS_PERMS_BY_NAME(@full, N'OBJECT', N'ALTER')         AS a,
               HAS_PERMS_BY_NAME(@full, N'OBJECT', N'VIEW DEFINITION') AS vd`)).recordset[0];
    log(`  ${full.padEnd(28)} SELECT=${r.s} INSERT=${r.i} UPDATE=${r.u} ALTER=${r.a} VIEW_DEF=${r.vd}`);
  }
  log('  PERMISO CREATE TABLE en la base: ' +
    (await pool.request().query('SELECT HAS_PERMS_BY_NAME(DB_NAME(), N\'DATABASE\', N\'CREATE TABLE\') AS c')).recordset[0].c);

  // 9b. Principales de la base y permisos concedidos (si este login los ve).
  log('\n=== 9b. sys.database_principals (usuarios de la base, visibles para este login) ===');
  const principals = (await pool.request().query(`
    SELECT name, type_desc, default_schema_name
    FROM sys.database_principals
    WHERE type IN (N'S', N'U', N'G') AND name NOT LIKE '##%'
    ORDER BY name`)).recordset;
  for (const p of principals) log(`  ${p.name} (${p.type_desc}, schema=${p.default_schema_name ?? 'NULL'})`);

  log('\n  sys.database_permissions de cada principal sobre las 6 tablas:');
  const grants = (await pool.request().query(`
    SELECT dp.name AS principal_name,
           OBJECT_SCHEMA_NAME(perm.major_id) AS sch,
           OBJECT_NAME(perm.major_id) AS obj,
           perm.permission_name
    FROM sys.database_permissions perm
    JOIN sys.database_principals dp ON dp.principal_id = perm.grantee_principal_id
    WHERE perm.class = 1
      AND perm.major_id IN (
        SELECT target FROM (VALUES
          (OBJECT_ID(N'dbo.permissions')), (OBJECT_ID(N'dbo.roles')),
          (OBJECT_ID(N'dbo.role_permissions')), (OBJECT_ID(N'dbo.users')),
          (OBJECT_ID(N'dbo.departments')), (OBJECT_ID(N'dbo.sessions'))) AS targets(target))
      AND dp.name IN (N'sifha_ticket_dev', N'sifha_migration_dev')
    ORDER BY dp.name, perm.major_id, perm.permission_name`)).recordset;
  if (grants.length === 0) {
    log('  (ninguna concesión directa visible para este login)');
  } else {
    for (const g of grants) log(`  ${g.principal_name.padEnd(22)} ${g.sch}.${g.obj.padEnd(16)} ${g.permission_name}`);
  }

  // 10. La consulta EXACTA con la que seed-mssql.mjs decide SEED_MISSING_TABLES.
  log('\n=== 10. Consulta del seed (listTables/inspect) ===');
  const seedList = (await pool.request().query(`
    SELECT t.name AS name
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo'`)).recordset.map((r) => r.name);
  const requiredOrder = ['permissions', 'roles', 'departments', 'role_permissions', 'users'];
  const missing = requiredOrder.filter((t) => !seedList.includes(t));
  log(`  RESOLUTION_ORDER = ${requiredOrder.join(', ')}`);
  log(`  resultante por este login (sys.tables): ${seedList.join(', ')}`);
  log(`  missingRequired por este login: ${missing.length ? missing.join(', ') : '(ninguna)'}`);

  log('\n[cat] FIN: auditoría de solo lectura completada sin escribir nada.');
} finally {
  await pool.close();
}