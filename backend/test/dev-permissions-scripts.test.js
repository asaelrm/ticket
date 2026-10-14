import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(here, '..', 'scripts', 'migration');

function readCode(name) {
  const raw = fs.readFileSync(path.join(migrationDir, name), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

// Las 24 tablas del esquema canonico (backend/src/db/mssql/schema.sql) que
// ambos scripts de permisos deben cubrir.
const SCHEMA_TABLES = [
  'organizations', 'permissions', 'roles', 'role_permissions',
  'departments', 'categories', 'users', 'teams', 'team_members',
  'tickets', 'canned_responses', 'ticket_comments', 'ticket_attachments',
  'ticket_history', 'sessions', 'sequences', 'settings', 'org_settings',
  'email_logs', 'notifications', 'kb_categories', 'kb_articles',
  'kb_ticket_articles', 'kb_article_history',
];

function assertIdentityGuard(name) {
  const code = readCode(name);
  assert.match(code, /N'SIFHA_TICKETS_DEV'/i, 'debe fijar la base esperada');
  assert.match(code, /SIFHADEV/, 'debe fijar la instancia/servidor esperado');
  assert.match(code, /DB_NAME\(\)/, 'debe comparar la base actual');
  assert.match(code, /SERVERPROPERTY\('InstanceName'\)/, 'debe comparar la instancia');
  assert.match(code, /RAISERROR\([\s\S]*?RETURN;/, 'debe abortar con RETURN si no coincide');
}

function assertDryRunDefault(name) {
  const code = readCode(name);
  assert.match(code, /@apply\s+BIT\s*=\s*0\b/, '@apply debe ser 0 (DRY-RUN) por defecto');
  assert.match(code, /QUOTENAME\(/, 'debe usar QUOTENAME al componer SQL dinamico');
}

// Permisos OPERATIVOS de minimo privilegio por tabla/operacion para la cuenta
// de la aplicacion. No usa roles de base globales (db_datareader/db_datawriter)
// ni crea logins/usuarios: solo GRANTs por tabla.
describe('grant-app-account-minimal.sql (permisos operativos DEV)', () => {
  const name = 'grant-app-account-minimal.sql';

  it('se protege por identidad (base + instancia + servidor)', () => {
    assertIdentityGuard(name);
  });

  it('es DRY-RUN por defecto y usa SQL dinamico con QUOTENAME', () => {
    assertDryRunDefault(name);
  });

  it('concede por tabla y operacion (nada de roles globales)', () => {
    const code = readCode(name);
    assert.match(code, /GRANT\s*'?\s*\+\s*@perms/i, 'debe componer GRANT <perm> ON dbo.<tabla>');
    assert.match(code, /N'tickets',\s*N'SELECT, INSERT, UPDATE, DELETE'/i);
    assert.match(code, /N'permissions',\s*N'SELECT'/i);
    assert.match(code, /N'roles',\s*N'SELECT'/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE/i);
    assert.doesNotMatch(code, /db_datareader\s+ADD\s+MEMBER/i);
    assert.doesNotMatch(code, /db_datawriter\s+ADD\s+MEMBER/i);
  });

  it('no concede db_owner, db_ddladmin ni roles de servidor', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_owner\]?/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_ddladmin\]?/i);
    assert.doesNotMatch(code, /ALTER\s+SERVER\s+ROLE/i);
  });

  it('no crea ni altera logins/usuarios ni hace DROP', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /\bCREATE\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bALTER\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bCREATE\s+USER\b/i);
    assert.doesNotMatch(code, /\bDROP\s+/i);
  });

  it('cubre las 24 tablas del esquema canonico', () => {
    const code = readCode(name);
    for (const tbl of SCHEMA_TABLES) {
      assert.match(code, new RegExp(`N'${tbl}'`, 'i'), `falta la tabla ${tbl}`);
    }
  });

  it('revoca permisos DML sobrantes solo si @revoke_extra = 1 y acotado al mapa', () => {
    const code = readCode(name);
    assert.match(code, /@revoke_extra\s+BIT\s*=\s*0\b/, 'no debe revocar por defecto');
    assert.match(code, /REVOKE\s*'\s*\+\s*@rperm/i, 'debe componer REVOKE <perm> ON dbo.<tabla>');
    assert.match(code, /p\.permission_name\s+IN\s*\(N'SELECT',\s*N'INSERT',\s*N'UPDATE',\s*N'DELETE'\)/i);
    assert.match(code, /JOIN\s+@grants\s+g\s+ON\s+g\.tbl\b/i, 'debe acotar a las 24 tablas del mapa');
    assert.match(code, /CHARINDEX\([\s\S]*?p\.permission_name[\s\S]*?g\.perms[\s\S]*?\)\s*=\s*0/i);
    assert.match(code, /COLLATE\s+DATABASE_DEFAULT/i, 'debe resolver el conflicto de collation del catalogo');
  });

  it('no ejecuta DML sobre tablas persistentes (solo GRANT/REVOKE/SELECT)', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /\bINSERT\s+(OR\s+\w+\s+)?INTO\s+dbo\./i);
    assert.doesNotMatch(code, /\bDELETE\s+FROM\s+dbo\./i);
    assert.doesNotMatch(code, /\bUPDATE\s+dbo\./i);
    assert.doesNotMatch(code, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(code, /\bTRUNCATE\b/i);
  });
});
// GRANT SELECT por tabla (mas VIEW DEFINITION opt-in). Nunca INSERT/UPDATE/
// DELETE ni roles globales.
describe('create-groupE-readonly-account.sql (cuenta solo lectura Grupo E)', () => {
  const name = 'create-groupE-readonly-account.sql';

  it('se protege por identidad (base + instancia + servidor)', () => {
    assertIdentityGuard(name);
  });

  it('es DRY-RUN por defecto y usa SQL dinamico con QUOTENAME', () => {
    assertDryRunDefault(name);
  });

  it('concede SOLO SELECT por tabla', () => {
    const code = readCode(name);
    assert.match(code, /N'GRANT SELECT ON dbo\.'\s*\+\s*QUOTENAME\(@tbl\)/i);
    assert.doesNotMatch(code, /\bGRANT\s+INSERT\b/i);
    assert.doesNotMatch(code, /\bGRANT\s+UPDATE\b/i);
    assert.doesNotMatch(code, /\bGRANT\s+DELETE\b/i);
    assert.doesNotMatch(code, /\bINSERT\b/i);
    assert.doesNotMatch(code, /\bUPDATE\b/i);
    assert.doesNotMatch(code, /\bDELETE\b/i);
  });

  it('no usa roles de base globales ni roles de servidor', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_datareader\]?/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_datawriter\]?/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_owner\]?/i);
    assert.doesNotMatch(code, /ALTER\s+ROLE\s+\[?db_ddladmin\]?/i);
    assert.doesNotMatch(code, /ALTER\s+SERVER\s+ROLE/i);
  });

  it('no hace DROP y deja la creacion del LOGIN al administrador', () => {
    const code = readCode(name);
    assert.doesNotMatch(code, /\bCREATE\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bALTER\s+LOGIN\b/i);
    assert.doesNotMatch(code, /\bDROP\s+/i);
  });

  it('cubre las 24 tablas del esquema canonico', () => {
    const code = readCode(name);
    for (const tbl of SCHEMA_TABLES) {
      assert.match(code, new RegExp(`N'${tbl}'`, 'i'), `falta la tabla ${tbl}`);
    }
  });
});

// Los comentarios de bloque de T-SQL ANIDAN: un "/*" dentro de un comentario de
// cabecera abre un comentario interno que deja el bloque sin cerrar y hace que
// el script no compile (Msg 113 "Missing end comment mark"). Defecto real
// detectado en grant-app-account-minimal.sql: el encabezado citaba "routes/*,
// middleware/*...". Esta regresion escanea todos los scripts de migracion.
describe('scripts SQL: sin aperturas de comentario anidadas accidentales', () => {
  const scripts = fs
    .readdirSync(migrationDir)
    .filter((f) => f.endsWith('.sql'));

  it('ninguna linea de continuacion de comentario (que empieza por "*") abre otro bloque', () => {
    assert.ok(scripts.length > 0, 'hay scripts de migracion');
    for (const file of scripts) {
      const raw = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      raw.split(/\r?\n/).forEach((line, idx) => {
        if (/^\s*\*/.test(line) && line.includes('/*')) {
          assert.fail(
            `${file}:${idx + 1} abre un comentario anidado dentro de un comentario de bloque: "${line.trim()}"`
          );
        }
      });
    }
  });
});
