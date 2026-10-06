import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.join(here, '..', 'src', 'schema.mssql.tickets-dev.sql'), 'utf8');

function has(text) {
  assert.match(ddl, new RegExp(text, 'i'));
}

function hasFk(name, target, action) {
  has(`${name}[\\s\\S]*?REFERENCES dbo\\.${target}\\(id\\) ON DELETE ${action}`);
}

describe('C1 · esquema MSSQL de tickets', () => {
  it('declara la barrera DEV, transacción de despliegue y las diez tablas requeridas', () => {
    has("DB_NAME\\(\\)\\s*<>\\s*N'SIFHA_Tickets_DEV'");
    has('SET XACT_ABORT ON');
    has('BEGIN TRY[\\s\\S]*?BEGIN TRANSACTION');
    has('COMMIT TRANSACTION[\\s\\S]*?END TRY[\\s\\S]*?BEGIN CATCH[\\s\\S]*?XACT_STATE\\(\\)\\s*<>\\s*0[\\s\\S]*?ROLLBACK TRANSACTION[\\s\\S]*?THROW');

    for (const table of [
      'categories', 'sequences', 'settings', 'teams', 'team_members', 'tickets',
      'ticket_comments', 'ticket_history', 'ticket_attachments', 'notifications',
    ]) {
      has(`OBJECT_ID\\(N'dbo\\.${table}',\\s*N'U'\\)\\s+IS\\s+NULL`);
      has(`CREATE\\s+TABLE\\s+dbo\\.${table}\\b`);
    }
  });

  it('usa identity, UTC y BIT en las columnas fundamentales', () => {
    for (const table of ['categories', 'teams', 'tickets', 'ticket_comments', 'ticket_history', 'ticket_attachments', 'notifications']) {
      has(`CREATE\\s+TABLE\\s+dbo\\.${table}[\\s\\S]*?id\\s+INT\\s+IDENTITY\\(1,1\\)\\s+NOT\\s+NULL`);
    }
    has('created_at\\s+DATETIME2\\(3\\)\\s+NOT\\s+NULL[\\s\\S]*?SYSUTCDATETIME\\(\\)');
    has('active\\s+BIT\\s+NOT\\s+NULL');
    has('is_internal\\s+BIT\\s+NOT\\s+NULL');
    has('resolution_notified\\s+BIT\\s+NOT\\s+NULL');
  });

  it('preserva claves, unicidad y FKs requeridas', () => {
    for (const constraint of [
      'UQ_categories_name UNIQUE \\(name\\)', 'PK_sequences PRIMARY KEY CLUSTERED \\(name\\)',
      'PK_settings PRIMARY KEY CLUSTERED \\(\\[key\\]\\)', 'UQ_teams_name UNIQUE \\(name\\)',
      'PK_team_members PRIMARY KEY CLUSTERED \\(team_id, user_id\\)',
      'UQ_tickets_ticket_number UNIQUE \\(ticket_number\\)',
      'UQ_ticket_attachments_stored_name UNIQUE \\(stored_name\\)',
    ]) has(constraint);

    hasFk('FK_settings_updated_by', 'users', 'SET NULL');
    hasFk('FK_team_members_team', 'teams', 'CASCADE');
    hasFk('FK_team_members_user', 'users', 'CASCADE');
    hasFk('FK_tickets_assigned_team', 'teams', 'SET NULL');
    hasFk('FK_tickets_category', 'categories', 'SET NULL');
    hasFk('FK_tickets_department', 'departments', 'SET NULL');
    hasFk('FK_ticket_comments_ticket', 'tickets', 'CASCADE');
    hasFk('FK_ticket_comments_user', 'users', 'SET NULL');
    hasFk('FK_ticket_history_ticket', 'tickets', 'CASCADE');
    hasFk('FK_ticket_history_user', 'users', 'SET NULL');
    hasFk('FK_ticket_attachments_ticket', 'tickets', 'CASCADE');
    hasFk('FK_ticket_attachments_comment', 'ticket_comments', 'NO ACTION');
    hasFk('FK_ticket_attachments_uploader', 'users', 'SET NULL');
    hasFk('FK_notifications_user', 'users', 'CASCADE');
    hasFk('FK_notifications_ticket', 'tickets', 'CASCADE');
  });

  it('elimina rutas múltiples de acciones referenciales desde users y tickets', () => {
    for (const name of [
      'FK_tickets_reporter', 'FK_tickets_assigned_to', 'FK_tickets_resolved_by',
      'FK_tickets_closed_by', 'FK_tickets_reopened_by', 'FK_tickets_cancelled_by',
    ]) hasFk(name, 'users', 'NO ACTION');

    assert.doesNotMatch(
      ddl,
      /FK_tickets_(?:reporter|assigned_to|resolved_by|closed_by|reopened_by|cancelled_by)[^\r\n]*REFERENCES dbo\.users\(id\) ON DELETE (?:CASCADE|SET NULL)/i,
    );
    assert.doesNotMatch(
      ddl,
      /FK_ticket_attachments_comment[^\r\n]*REFERENCES dbo\.ticket_comments\(id\) ON DELETE (?:CASCADE|SET NULL)/i,
    );
  });

  it('restringe priority, status, csat y tiempo a los valores usados por tickets.js', () => {
    has("CK_tickets_priority CHECK \\(priority IN \\(N'LOW', N'MEDIUM', N'HIGH', N'CRITICAL'\\)\\)");
    has("CK_tickets_status CHECK \\(status IN \\(N'OPEN', N'ASSIGNED', N'IN_PROGRESS', N'PENDING', N'RESOLVED', N'CLOSED', N'CANCELLED'\\)\\)");
    has('CK_tickets_time_spent_minutes CHECK \\(time_spent_minutes IS NULL OR time_spent_minutes BETWEEN 0 AND 100000\\)');
    has('CK_tickets_csat_rating CHECK \\(csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5\\)');
  });

  it('incluye todos los índices requeridos sin duplicar PK o UNIQUE', () => {
    for (const index of [
      'IX_team_members_user', 'IX_tickets_reporter', 'IX_tickets_assigned', 'IX_tickets_assigned_team',
      'IX_tickets_category', 'IX_tickets_department', 'IX_tickets_priority', 'IX_tickets_status',
      'IX_tickets_created', 'IX_tickets_updated', 'IX_tickets_resolved', 'IX_tickets_closed',
      'IX_tickets_sla_due', 'IX_tickets_resolved_by', 'IX_tickets_closed_by', 'IX_tickets_cancelled_by',
      'IX_tickets_cancelled_at', 'IX_ticket_comments_ticket', 'IX_ticket_comments_ticket_internal',
      'IX_ticket_comments_created', 'IX_ticket_history_ticket', 'IX_ticket_history_created',
      'IX_ticket_attachments_ticket', 'IX_ticket_attachments_comment', 'IX_notifications_user_read',
      'IX_notifications_created',
    ]) has(`IF NOT EXISTS \\(SELECT 1 FROM sys\\.indexes[\\s\\S]*?CREATE\\s+INDEX\\s+${index}\\b`);
  });

  it('es idempotente estructuralmente, crea padres primero y no contiene operaciones prohibidas', () => {
    const pos = (needle) => ddl.indexOf(needle);
    assert.ok(pos('CREATE TABLE dbo.teams') < pos('CREATE TABLE dbo.team_members'));
    assert.ok(pos('CREATE TABLE dbo.tickets') < pos('CREATE TABLE dbo.ticket_comments'));
    assert.ok(pos('CREATE TABLE dbo.ticket_comments') < pos('CREATE TABLE dbo.ticket_attachments'));
    assert.ok(pos('CREATE TABLE dbo.tickets') < pos('CREATE TABLE dbo.notifications'));
    assert.doesNotMatch(ddl, /\\bDROP\\b|\\bTRUNCATE\\b|\\bDBCC\\b|\\bIDENTITY_INSERT\\b/i);
  });
});
