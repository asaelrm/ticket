// APPLY SQLite -> MSSQL: orquestación de la escritura contra el destino.
//
// `runApply` no importa `mssql` ni toca la red: recibe un driver con un puerto
// semántico (begin / lockAndAssertTargetEmpty / insertRow / commit / rollback)
// que en producción se implementa con `createMssqlDriver` y en las pruebas con
// un doble en memoria (test/migrate-apply-driver.test.js). El SQL se construye
// con funciones puras que SOLO usan identificadores de la allowlist COLUMNS
// (paridad con src/db/mssql/schema.sql verificada por test).
import {
  EMPTY_TARGET_ERROR, IDENTITY_TABLES, SKIPPED_TABLES, TABLES, assertAllowedColumns,
  legacyOrganizationInsertRow, resolveLegacyOrganization, sequenceRowsForMigration, transformRow, validateSource,
} from './sqlite-to-mssql.js';

// Bloqueo con nombre de aplicación, tomado con LockOwner=Transaction: se libera
// solo con commit/rollback y serializa cualquier otro APPLY contra la misma base.
export const MIGRATION_APPLOCK = 'SIFHA_MIGRATION_TARGET';
export const MIGRATION_APPLOCK_TIMEOUT_MS = 60000;

export function insertStatement(table, columns) {
  assertAllowedColumns(table, columns);
  if (!columns.length) throw new Error(`${table}: el INSERT necesita al menos una columna`);
  return `INSERT dbo.${table} (${columns.map((column) => `[${column}]`).join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`;
}

export function identityInsertStatement(table, enabled) {
  assertAllowedColumns(table, []);
  return `SET IDENTITY_INSERT dbo.${table} ${enabled ? 'ON' : 'OFF'}`;
}

export function organizationInsertStatement() {
  assertAllowedColumns('organizations', ['code', 'name', 'active', 'created_at']);
  return 'INSERT dbo.organizations ([code], [name], [active], [created_at]) OUTPUT INSERTED.id VALUES (@code, @name, @active, @created_at)';
}

// Recuento exacto de las 24 tablas (incluida la que no se migra, sessions):
// la comprobación vive dentro de la transacción, después del bloqueo.
export function targetEmptyStatement(tables = TABLES) {
  if (!Array.isArray(tables) || !tables.length) throw new Error('targetEmptyStatement requiere la lista de tablas del esquema.');
  const counts = tables.map((table) => { assertAllowedColumns(table, []); return `(SELECT COUNT(*) FROM dbo.${table})`; });
  return `SELECT ${counts.join(' + ')} AS count`;
}

export function appLockStatement() {
  if (!/^[A-Z0-9_]+$/.test(MIGRATION_APPLOCK)) throw new Error('nombre de bloqueo de migración inválido');
  return `DECLARE @lock_result INT; EXEC @lock_result = sp_getapplock @Resource = N'${MIGRATION_APPLOCK}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ${MIGRATION_APPLOCK_TIMEOUT_MS}; SELECT @lock_result AS lock_result;`;
}

// Secuencia completa de APPLY. Cualquier fallo revierte la transacción entera:
// no hay truncate, merge ni reanudación.
export async function runApply({ source, legacyOrganization, manifest, driver }) {
  if (!driver || typeof driver.begin !== 'function' || typeof driver.insertRow !== 'function') {
    throw new Error('runApply requiere un driver de destino con el puerto semántico completo.');
  }
  let activeLegacy = legacyOrganization;
  let started = false;
  try {
    await driver.begin();
    started = true;
    // 1. Bloqueo + destino vacío (las 24 tablas) dentro de la transacción.
    await driver.lockAndAssertTargetEmpty();
    // 2. Organizaciones del origen PRIMERO: conservan su ID con IDENTITY_INSERT
    //    y el contador continúa desde el máximo real, de modo que la organización
    //    legacy que se cree después nunca colisiona con un ID existente.
    if ((source.organizations || []).length) {
      await driver.setIdentityInsert('organizations', true);
      try {
        for (const row of source.organizations) {
          const data = transformRow('organizations', row, source, legacyOrganization);
          await driver.insertRow('organizations', Object.keys(data), data);
          manifest.tables.organizations.inserted_count += 1;
        }
      } finally {
        await driver.setIdentityInsert('organizations', false);
      }
    }
    // 3. Organización legacy: se reutiliza la existente con ese código o se crea
    //    y se toma el ID real que devuelve el destino (nunca un valor supuesto).
    if (legacyOrganization) {
      if (legacyOrganization.mode === 'reuse') {
        activeLegacy = resolveLegacyOrganization(legacyOrganization, legacyOrganization.existingId);
      } else {
        const organizationId = await driver.insertOrganization(legacyOrganizationInsertRow(legacyOrganization));
        activeLegacy = resolveLegacyOrganization(legacyOrganization, organizationId);
        manifest.tables.organizations.inserted_count += 1;
      }
      const resolutionErrors = validateSource(source, activeLegacy);
      if (resolutionErrors.length) throw new Error(`Precheck con el ID real falló con ${resolutionErrors.length} error(es); no se escribió ninguna fila tenant.`);
      if (manifest.legacy_organization) manifest.legacy_organization.resolved_organization_id = activeLegacy.resolvedId;
    }
    // 4. Resto de tablas en orden de FK, con la secuencia reconciliada al final.
    for (const table of TABLES) {
      if (table === 'organizations' || SKIPPED_TABLES.has(table)) continue;
      const rows = table === 'sequences'
        ? sequenceRowsForMigration(source, activeLegacy, activeLegacy?.resolvedId ?? null)
        : (source[table] || []);
      if (!rows.length) continue;
      const usesIdentity = IDENTITY_TABLES.has(table);
      if (usesIdentity) await driver.setIdentityInsert(table, true);
      try {
        for (const row of rows) {
          const data = transformRow(table, row, source, activeLegacy);
          await driver.insertRow(table, Object.keys(data), data);
          manifest.tables[table].inserted_count += 1;
        }
      } finally {
        // IDENTITY_INSERT es de sesión: se apaga aunque falle una fila.
        if (usesIdentity) await driver.setIdentityInsert(table, false);
      }
    }
    await driver.commit();
  } catch (error) {
    if (started) { try { await driver.rollback(); } catch { /* el error original es el que importa */ } }
    throw error;
  }
  return { legacyOrganization: activeLegacy, manifest };
}

// Driver real sobre node-mssql. Único punto que emite SQL contra el servidor.
export function createMssqlDriver(sql, pool) {
  let transaction = null;
  const request = () => new sql.Request(transaction);
  return {
    async begin() { transaction = new sql.Transaction(pool); await transaction.begin(); },
    async lockAndAssertTargetEmpty() {
      const lock = await request().query(appLockStatement());
      const result = Number(lock.recordset?.[0]?.lock_result);
      if (!Number.isFinite(result) || result < 0) throw new Error(`No se pudo adquirir el bloqueo de migración (sp_getapplock=${result}); APPLY se niega a continuar.`);
      const counts = await request().query(targetEmptyStatement());
      if (Number(counts.recordset[0].count || 0) !== 0) throw new Error(EMPTY_TARGET_ERROR);
    },
    async insertOrganization(row) {
      const created = await request()
        .input('code', row.code)
        .input('name', row.name)
        .input('active', row.active ? 1 : 0)
        .input('created_at', new Date(row.created_at))
        .query(organizationInsertStatement());
      return created.recordset[0].id;
    },
    async setIdentityInsert(table, enabled) { await request().query(identityInsertStatement(table, enabled)); },
    async insertRow(table, columns, data) {
      const statement = request();
      for (const column of columns) statement.input(column, data[column] ?? null);
      await statement.query(insertStatement(table, columns));
    },
    async commit() { await transaction.commit(); },
    async rollback() { if (transaction) await transaction.rollback(); },
  };
}
