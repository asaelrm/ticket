import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regresiones del modelo de permisos TEMPORALES de despliegue C1.
//
// El fallo real fue 229 (REFERENCES permission was denied) sobre teams: crear
// una FK exige REFERENCES sobre la tabla referenciada, y ALTER ON SCHEMA::dbo no
// lo implica. Aqui se fija por prueba que el grant concede ese permiso, que el
// revoke lo retira exactamente, y que nada de esto toca a sifha_ticket_dev.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const read = (relative) => fs.readFileSync(path.join(src, relative), 'utf8');

const grant = read(path.join('scripts', 'grant-c1-deploy-temp.sql'));
const revoke = read(path.join('scripts', 'revoke-c1-deploy-temp.sql'));
const ddl = read('schema.mssql.tickets-dev.sql');
const validator = read(path.join('scripts', 'validate-c1-mssql-rollback.mjs'));

const ROLE = 'c1_deploy_temp';

/** GRANT/REVOKE sobre el rol temporal, una instruccion por linea. */
function roleStatements(sql, verb) {
  const out = [];
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, '').trim();
    const m = new RegExp(`^${verb}\\s+(.+?)\\s+(TO|FROM)\\s+\\[${ROLE}\\]\\s*;$`, 'i').exec(line);
    if (!m) continue;
    const on = /\s+ON\s+(\S+)\s*$/i.exec(m[1]);
    out.push(`${(on ? m[1].slice(0, on.index) : m[1]).replace(/\s+/g, ' ').trim().toUpperCase()}|${on ? on[1].toUpperCase() : ''}`);
  }
  return out.sort();
}

const grants = roleStatements(grant, 'GRANT');
const revokes = roleStatements(revoke, 'REVOKE');
const schemaReferences = 'REFERENCES|SCHEMA::[DBO]';

/** Tablas referenciadas por alguna FK del DDL C1 (los padres). */
const parents = [...new Set([...ddl.matchAll(/REFERENCES\s+dbo\.\[?(\w+)\]?/gi)].map((m) => m[1].toLowerCase()))];

const isCovered = (table) => grants.includes(schemaReferences) || grants.includes(`REFERENCES|OBJECT::DBO.[${table}]`);

describe('C1 · permisos temporales de despliegue', () => {
  it('el grant concede REFERENCES sobre SCHEMA::dbo, que es lo que pedia el 229', () => {
    assert.ok(grants.includes(schemaReferences), 'falta GRANT REFERENCES ON SCHEMA::[dbo] TO [c1_deploy_temp]');
    assert.match(grant, /GRANT\s+REFERENCES\s+ON\s+SCHEMA::\[dbo\]\s+TO\s+\[c1_deploy_temp\];/i);
  });

  it('cubre TODAS las tablas referenciadas por las FK de schema.mssql.tickets-dev.sql', () => {
    assert.ok(parents.length >= 6, `se esperaban las tablas padre de C1, hubo: ${parents.join(', ')}`);
    for (const table of parents) {
      assert.ok(isCovered(table), `sin REFERENCES para la tabla padre dbo.${table}`);
    }
  });

  it('incluye teams, categories, tickets y ticket_comments ademas de users y departments', () => {
    for (const table of ['users', 'departments', 'teams', 'categories', 'tickets', 'ticket_comments']) {
      assert.ok(parents.includes(table), `dbo.${table} debe ser padre de alguna FK de C1`);
      assert.ok(isCovered(table), `dbo.${table} queda sin REFERENCES`);
    }
  });

  it('revoca exactamente lo que concede', () => {
    assert.deepEqual(revokes, grants, 'el conjunto GRANT y el de REVOKE deben coincidir');
    assert.ok(revokes.includes(schemaReferences), 'falta REVOKE REFERENCES ON SCHEMA::[dbo]');
  });

  it('el revoke es idempotente y no retira nada ajeno al mecanismo temporal', () => {
    assert.match(revoke, /IF\s+DATABASE_PRINCIPAL_ID\(N'c1_deploy_temp'\)\s+IS\s+NULL[\s\S]*?\bRETURN;/);
    assert.match(revoke, /IF\s+USER_ID\(N'sifha_migration_dev'\)\s+IS\s+NOT\s+NULL\s*\r?\nAND\s+EXISTS\s*\(/);
    const beforeDrop = revoke.slice(0, revoke.lastIndexOf('DROP ROLE'));
    assert.ok((beforeDrop.match(/RETURN;/g) || []).length >= 3, 'DROP ROLE debe quedar tras sus guardas');
    assert.doesNotMatch(revoke, /\bDENY\b/i);
    assert.doesNotMatch(revoke, /^\s*(?:GRANT|REVOKE)\b[^;\r\n]*\b(?:sifha_ticket_dev|sifha_migration_dev)\b/im);
  });

  it('el grant es idempotente y solo se dirige al rol temporal', () => {
    assert.match(grant, /IF\s+DATABASE_PRINCIPAL_ID\(N'c1_deploy_temp'\)\s+IS\s+NULL[\s\S]*?CREATE\s+ROLE\s+\[c1_deploy_temp\]\s+AUTHORIZATION\s+\[dbo\];[\s\S]*?\bELSE\b/);
    assert.match(grant, /IF\s+NOT\s+EXISTS\s*\([\s\S]*?ALTER\s+ROLE\s+\[c1_deploy_temp\]\s+ADD\s+MEMBER/);
    assert.equal(grants.length, new Set(grants).size, 'ningun GRANT repetido');
    for (const line of grant.split(/\r?\n/)) {
      if (!/^\s*GRANT\b/i.test(line)) continue;
      assert.match(line, new RegExp(`TO\\s+\\[${ROLE}\\]\\s*;$`, 'i'), `GRANT fuera del rol temporal: ${line.trim()}`);
    }
    assert.doesNotMatch(grant, /\bTO\s+\[(?:sifha_ticket_dev|sifha_migration_dev|sa|dbo|db_owner|db_ddladmin)\]/i);
    assert.doesNotMatch(grant, /WITH\s+GRANT\s+OPTION/i);
  });

  it('no introduce privilegios amplios ni usa sa', () => {
    const scripts = `${grant}\n${revoke}`;
    for (const forbidden of [
      'db_owner', 'db_ddladmin', 'db_securityadmin', 'db_accessadmin',
      'db_datawriter', 'db_datareader', 'db_backupadmin',
    ]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'i').test(scripts), `rol fijo inesperado: ${forbidden}`);
    }
    assert.doesNotMatch(grant, /^\s*GRANT\s+(?:CONTROL|ALTER\s+ANY\b|IMPERSONATE|TAKE\s+OWNERSHIP|ALTER\s+ANY\s+DATABASE)/im);
    assert.doesNotMatch(scripts, /\[sa\]|'sa'|"sa"|\bLOGIN\s+\[?sa\]?\b|\bAUTHORIZATION\s+\[sa\]/i);
  });

  it('no otorga nada a sifha_ticket_dev y separa despliegue de runtime', () => {
    for (const [label, sql] of [['grant', grant], ['revoke', revoke]]) {
      assert.doesNotMatch(sql, /^\s*(?:GRANT|REVOKE)\b[^;\r\n]*\bsifha_ticket_dev\b/im, `${label} toca sifha_ticket_dev`);
      assert.doesNotMatch(sql, /ALTER\s+ROLE\s+\[sifha_ticket_dev\]/i, `${label} altera sifha_ticket_dev`);
    }
    assert.match(grant, /No se otorgaron permisos a sifha_ticket_dev/);
  });

  it('el esquema C1 sigue sin gestionar permisos y los scripts no hacen DDL de tablas', () => {
    assert.doesNotMatch(ddl, /\bGRANT\b|\bREVOKE\b|\bDENY\b|CREATE\s+ROLE|ALTER\s+ROLE|sp_addrolemember/i);
    assert.doesNotMatch(`${grant}\n${revoke}`, /^\s*(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|DATABASE)\b/im);
    assert.doesNotMatch(grant, /^\s*(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+dbo\./im);
  });

  it('conserva la mejora diagnostica del validador C1', () => {
    assert.match(validator, /export function logDiagnostic/);
    assert.match(validator, /precedingErrors/);
    assert.match(validator, /errores-previos/);
    assert.match(validator, /originalError/);
  });
});
