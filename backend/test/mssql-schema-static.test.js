import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.join(here, '..', 'src', 'db', 'mssql', 'schema.sql'), 'utf8');

// The MSSQL target schema. M2 checks: SQL Server compatibility, parity with the
// active SQLite schema, and the multi-tenant invariants that MSSQL can finally
// enforce (composite same-org FKs, tenant candidate keys, tenant ticket numbers).
const ACTIVE_SQLITE_TABLES = [
  'organizations', 'roles', 'permissions', 'role_permissions', 'departments', 'categories',
  'users', 'teams', 'team_members', 'tickets', 'canned_responses', 'ticket_comments',
  'ticket_attachments', 'ticket_history', 'sessions', 'sequences', 'settings',
  'email_logs', 'notifications', 'kb_categories', 'kb_articles', 'kb_ticket_articles', 'kb_article_history',
];

// Tables with the surrogate tenant candidate key UNIQUE (organization_id, id).
// Every composite same-org FK needs exactly this key on the referenced table.
const CANDIDATE_KEY_TABLES = [
  'departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses',
  'ticket_comments', 'kb_categories', 'kb_articles',
];

function table(name) {
  const match = ddl.match(new RegExp(`CREATE TABLE dbo\\.${name} \\(([\\s\\S]*?)(?:\\n\\);)`));
  assert.ok(match, `dbo.${name} must exist`);
  return match[1];
}

describe('M2 MSSQL multi-tenant schema (static)', () => {
  it('defines every active SQLite table plus the future org_settings table', () => {
    for (const name of [...ACTIVE_SQLITE_TABLES, 'org_settings']) table(name);
  });

  it('uses MSSQL types and contains no SQLite-only or instance DDL', () => {
    assert.match(ddl, /INT IDENTITY\(1,1\)/);
    assert.match(ddl, /DATETIME2\(3\)/);
    assert.match(ddl, /SYSUTCDATETIME\(\)/);
    assert.doesNotMatch(ddl, /\bPRAGMA\b|\bstrftime\b|\bON CONFLICT\b|AUTOINCREMENT/i);
    assert.doesNotMatch(ddl, /^\s*(CREATE|DROP)\s+DATABASE\b|^\s*USE\s+[^\s]+\s*;?\s*$/im);
    assert.doesNotMatch(ddl, /\bdatetime\(['"]now['"]|\bjulianday\b|\bsqlite_sequence\b|\bAUTOINCREMENT\b/i);
  });

  it('survives without instance names, backup targets, or live database references', () => {
    assert.doesNotMatch(ddl, /SIFHADEV|HPWJA|ZZZSQL/i);
    assert.doesNotMatch(ddl, /BACKUP\s+DATABASE|RESTORE\s+DATABASE|ALTER\s+DATABASE/i);
  });

  it('keeps tenant identity in every tenant table', () => {
    for (const name of ['departments', 'categories', 'teams', 'tickets', 'canned_responses', 'kb_categories', 'kb_articles']) {
      assert.match(table(name), /organization_id INT NOT NULL/, `dbo.${name}.organization_id must be NOT NULL`);
    }
    assert.match(table('users'), /organization_id INT NULL/, 'users.organization_id must stay nullable for SUPERADMIN');
    for (const name of ['ticket_comments', 'ticket_attachments', 'ticket_history', 'kb_ticket_articles', 'kb_article_history', 'team_members']) {
      assert.match(table(name), /organization_id INT NOT NULL/, `dbo.${name}.organization_id must be present and NOT NULL`);
    }
  });

  it('allows notifications.organization_id NULL only for global SUPERADMIN notices', () => {
    const notifications = table('notifications');
    // La única tabla tenant con organization_id NULL, y solo para avisos
    // globales sin ticket a una cuenta SUPERADMIN sin organización.
    assert.match(notifications, /organization_id INT NULL/, 'notifications.organization_id must be nullable');
    assert.match(
      notifications,
      /CONSTRAINT CK_notifications_ticket_requires_org CHECK \(organization_id IS NOT NULL OR ticket_id IS NULL\)/,
      'una notificación de ticket debe exigir organización',
    );
    // Las FK compuestas se mantienen aunque la columna sea nullable.
    assert.match(notifications, /FK_notifications_user_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
    assert.match(notifications, /FK_notifications_ticket_same_org[\s\S]*?REFERENCES dbo\.tickets\(organization_id, id\)/);
  });

  it('enforces tenant-unique ticket numbering, never a global UNIQUE(ticket_number)', () => {
    const tickets = table('tickets');
    assert.match(tickets, /organization_id INT NOT NULL/);
    assert.match(tickets, /UQ_tickets_organization_ticket_number UNIQUE \(organization_id, ticket_number\)/);
    assert.doesNotMatch(tickets, /UNIQUE \(ticket_number\)/);
    assert.doesNotMatch(ddl, /UNIQUE\s*\(ticket_number\)/);
  });

  it('declares all composite same-org ticket FKs against users, teams, categories and departments', () => {
    const tickets = table('tickets');
    for (const fk of [
      'reporter', 'assigned_user', 'team', 'category', 'department',
      'resolved_by', 'closed_by', 'reopened_by', 'cancelled_by',
    ]) {
      assert.match(tickets, new RegExp(`FK_tickets_${fk}_same_org`), `missing FK_tickets_${fk}_same_org`);
    }
    assert.match(tickets, /FK_tickets_reporter_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
    assert.match(tickets, /FK_tickets_team_same_org[\s\S]*?REFERENCES dbo\.teams\(organization_id, id\)/);
    assert.match(tickets, /FK_tickets_category_same_org[\s\S]*?REFERENCES dbo\.categories\(organization_id, id\)/);
    assert.match(tickets, /FK_tickets_department_same_org[\s\S]*?REFERENCES dbo\.departments\(organization_id, id\)/);
  });

  it('enforces the remaining same-org guarantees across users, memberships, comments and knowledge base', () => {
    assert.match(table('users'), /FK_users_department_same_org[\s\S]*?REFERENCES dbo\.departments\(organization_id, id\)/);
    const members = table('team_members');
    assert.match(members, /FK_team_members_team_same_org[\s\S]*?REFERENCES dbo\.teams\(organization_id, id\)/);
    assert.match(members, /FK_team_members_user_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
    const comments = table('ticket_comments');
    assert.match(comments, /FK_ticket_comments_ticket_same_org[\s\S]*?REFERENCES dbo\.tickets\(organization_id, id\)/);
    assert.match(comments, /FK_ticket_comments_user_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
    assert.match(table('canned_responses'), /FK_canned_responses_owner_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
    assert.match(table('canned_responses'), /FK_canned_responses_team_same_org[\s\S]*?REFERENCES dbo\.teams\(organization_id, id\)/);
    assert.match(table('kb_articles'), /FK_kb_articles_category_same_org[\s\S]*?REFERENCES dbo\.kb_categories\(organization_id, id\)/);
    assert.match(table('kb_articles'), /FK_kb_articles_author_same_org[\s\S]*?REFERENCES dbo\.users\(organization_id, id\)/);
  });

  it('provides the surrogate tenant candidate key that every composite same-org FK references', () => {
    for (const name of CANDIDATE_KEY_TABLES) {
      assert.match(table(name), new RegExp(`UQ_${name}_organization_id UNIQUE \\(organization_id, id\\)`), `dbo.${name} needs UQ (organization_id, id)`);
    }
  });

  it('models global settings and composite org_settings without SQLite upsert syntax', () => {
    const settings = table('settings');
    const orgSettings = table('org_settings');
    assert.match(settings, /\[key\] NVARCHAR\(100\) NOT NULL/);
    assert.match(settings, /FK_settings_updated_by[\s\S]*?ON DELETE SET NULL/);
    assert.match(orgSettings, /organization_id INT NOT NULL/);
    assert.match(orgSettings, /\[key\] NVARCHAR\(100\) NOT NULL/);
    assert.match(orgSettings, /PK_org_settings PRIMARY KEY CLUSTERED \(organization_id, \[key\]\)/);
    assert.match(orgSettings, /FK_org_settings_organization[\s\S]*?REFERENCES dbo\.organizations\(id\) ON DELETE CASCADE/);
    assert.match(orgSettings, /FK_org_settings_updated_by[\s\S]*?REFERENCES dbo\.users\(id\) ON DELETE SET NULL/);
  });

  it('keeps organizations as the single cascade source (no multiple cascade paths)', () => {
    for (const name of ['departments', 'categories', 'users', 'teams', 'tickets', 'canned_responses', 'notifications', 'email_logs', 'kb_categories', 'kb_articles']) {
      assert.doesNotMatch(table(name), /REFERENCES dbo\.organizations\(id\) ON DELETE CASCADE/, `dbo.${name} must not cascade from organizations`);
    }
    const attachments = table('ticket_attachments');
    assert.match(attachments, /FK_ticket_attachments_ticket_same_org[\s\S]*?ON DELETE CASCADE/);
    assert.match(attachments, /FK_ticket_attachments_comment_same_org[\s\S]*?ON DELETE NO ACTION/, 'comment FK must be NO ACTION to avoid a second cascade path');
  });

  it('preserves history: no user delete cascades onto tickets or tenant history', () => {
    const users = table('users');
    assert.doesNotMatch(users, /ON DELETE (CASCADE|SET NULL)/);
    for (const col of ['assigned_to', 'resolved_by', 'closed_by', 'reopened_by', 'cancelled_by']) {
      assert.doesNotMatch(table('tickets'), new RegExp(`${col}_id[\\s\\S]*?ON DELETE (CASCADE|SET NULL)`));
    }
  });

  it('supports per-organization numbering in sequences and tenant-scoped catalogs', () => {
    const seq = table('sequences');
    assert.match(seq, /value BIGINT NOT NULL/);
    assert.match(seq, /PK_sequences PRIMARY KEY CLUSTERED \(name\)/);
    for (const name of ['departments', 'categories', 'teams', 'kb_categories']) {
      assert.match(table(name), new RegExp(`UQ_${name}_organization_name UNIQUE \\(organization_id, name\\)`), `dbo.${name} must be tenant-unique by name`);
    }
  });

  it('uses DATETIME2(3) with UTC defaults wherever the SQLite schema timestamps data', () => {
    for (const name of ['organizations', 'users', 'tickets', 'ticket_comments', 'ticket_history', 'notifications', 'email_logs', 'kb_articles', 'settings', 'org_settings']) {
      assert.match(table(name), /created_at DATETIME2\(3\) NOT NULL/, `dbo.${name}.created_at`);
      assert.match(table(name), /DEFAULT \(SYSUTCDATETIME\(\)\)/, `dbo.${name}.created_at default`);
    }
  });

  it('contains no credentials, connection strings, IPs, or production data', () => {
    // Legitimate column names (password_hash, password_reset_token) are schema
    // parity with SQLite; only real secrets, connection strings, hosts and
    // private network addresses are leaks.
    assert.doesNotMatch(ddl, /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|User Id\s*=|Password\s*=|Pwd\s*=|Persist Security Info|Integrated Security|Initial Catalog\s*=|Data Source\s*=|Server\s*=\s*[a-z0-9])/i);
    assert.doesNotMatch(ddl, /\b(10|127|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/);
    assert.doesNotMatch(ddl, /@[a-z0-9._%+-]+\.[a-z]{2,}\b/i);
    assert.doesNotMatch(ddl, /SIFHADEV|HPWJA|ZZZSQL/i);
  });
});