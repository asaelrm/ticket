import test from 'node:test';
import assert from 'node:assert/strict';

// Prueba manual, aislada y opt-in. Nunca toca tablas de aplicación: la tabla
// temporal vive solo en la sesión actual y el bloque termina con ROLLBACK.
const enabled = process.env.M5_IDENTITY_INTEGRATION === '1';
const TEMP_TABLE_NAME = '#m5_identity_probe';
const TEMP_OBJECT_ID_SQL = "SELECT @@SPID AS spid, OBJECT_ID(N'tempdb..#m5_identity_probe') AS object_id";

function attachSecondary(primaryError, field, error) {
  if (primaryError && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
    primaryError[field] = error;
  }
}

// La transacción puede auto-abortarse tras el primer error de SQL Server. En
// ese caso rollback() devuelve EABORT; ese diagnóstico secundario nunca debe
// reemplazar la excepción que abortó la transacción.
export async function cleanupIdentityProbe({ transaction, pool, began, identityEnabled, primaryError }) {
  let cleanupError = null;
  let rollbackError = null;
  let closeError = null;
  if (identityEnabled) {
    try { await transaction.request().batch('SET IDENTITY_INSERT #m5_identity_probe OFF'); } catch (error) { cleanupError = error; }
  }
  if (began) {
    try { await transaction.rollback(); } catch (error) { rollbackError = error; }
  }
  try { await pool.close(); } catch (error) { closeError = error; }

  if (primaryError) {
    if (cleanupError) attachSecondary(primaryError, 'identityInsertCleanupError', cleanupError);
    if (rollbackError) attachSecondary(primaryError, 'rollbackError', rollbackError);
    if (closeError) attachSecondary(primaryError, 'closeError', closeError);
    return;
  }
  if (cleanupError) throw cleanupError;
  if (rollbackError) throw rollbackError;
  if (closeError) throw closeError;
}

test('M5 integrado: IDENTITY_INSERT ON -> INSERT explícito -> OFF comparte sesión y hace rollback', { skip: !enabled }, async () => {
  const [{ default: sql }, migration] = await Promise.all([
    import('mssql'),
    import('../scripts/migration/sqlite-to-mssql.js'),
  ]);
  const target = migration.assertTargetGuard(process.env);
  const pool = await sql.connect(migration.mssqlConnectionConfig(target, process.env));
  const transaction = new sql.Transaction(pool);
  let began = false;
  let identityEnabled = false;
  let primaryError = null;
  let stage = 'begin';
  try {
    await transaction.begin();
    began = true;
    // query() usa sp_executesql; una #temp creada ahí queda en ese alcance
    // dinámico. batch() la crea en el alcance de la sesión de Transaction.
    const request = () => transaction.request();
    stage = 'spid-before';
    const first = await request().batch('SELECT @@SPID AS spid');
    const spid = Number(first.recordset?.[0]?.spid);
    stage = 'create-temp-table';
    await request().batch('CREATE TABLE #m5_identity_probe (id INT IDENTITY(1,1) NOT NULL PRIMARY KEY, label NVARCHAR(16) NOT NULL)');
    stage = 'spid-after-create';
    const afterCreate = await request().batch(TEMP_OBJECT_ID_SQL);
    assert.equal(Number(afterCreate.recordset?.[0]?.spid), spid, 'CREATE conserva la misma sesión');
    assert.ok(Number(afterCreate.recordset?.[0]?.object_id), 'la tabla temporal existe tras CREATE');
    stage = 'spid-before-identity-on';
    const beforeIdentityOn = await request().batch(TEMP_OBJECT_ID_SQL);
    assert.equal(Number(beforeIdentityOn.recordset?.[0]?.spid), spid, 'SET usará la misma sesión');
    assert.ok(Number(beforeIdentityOn.recordset?.[0]?.object_id), 'la tabla temporal existe antes de IDENTITY_INSERT');
    stage = 'identity-on';
    await request().batch('SET IDENTITY_INSERT #m5_identity_probe ON');
    identityEnabled = true;
    stage = 'insert-explicit-id';
    await request().batch("INSERT #m5_identity_probe ([id], [label]) VALUES (917, N'probe')");
    stage = 'spid-after-insert';
    const inserted = await request().batch('SELECT @@SPID AS spid, id FROM #m5_identity_probe');
    stage = 'identity-off';
    await request().batch('SET IDENTITY_INSERT #m5_identity_probe OFF');
    identityEnabled = false;
    stage = 'assert-result';
    assert.equal(Number(inserted.recordset?.[0]?.spid), spid);
    assert.equal(Number(inserted.recordset?.[0]?.id), 917);
  } catch (error) {
    primaryError = error;
    attachSecondary(primaryError, 'm5IdentityStage', stage);
    throw error;
  } finally {
    await cleanupIdentityProbe({ transaction, pool, began, identityEnabled, primaryError });
  }
});

// Reproduce el transporte corregido del APPLY: ON/OFF usan batch() para el
// estado de sesión e INSERT conserva query() con parámetros.
test('M5 integrado: batch(IDENTITY ON/OFF) + query(INSERT) conserva identidad entre requests', { skip: !enabled }, async () => {
  const [{ default: sql }, migration] = await Promise.all([
    import('mssql'),
    import('../scripts/migration/sqlite-to-mssql.js'),
  ]);
  const target = migration.assertTargetGuard(process.env);
  const pool = await sql.connect(migration.mssqlConnectionConfig(target, process.env));
  const transaction = new sql.Transaction(pool);
  let began = false;
  let identityEnabled = false;
  let primaryError = null;
  let stage = 'begin';
  try {
    await transaction.begin();
    began = true;
    const request = () => transaction.request();
    stage = 'create-temp-table-batch';
    await request().batch('CREATE TABLE #m5_identity_query_probe (id INT IDENTITY(1,1) NOT NULL PRIMARY KEY, label NVARCHAR(16) NOT NULL)');
    stage = 'spid-before-batch-identity-on';
    const beforeOn = await request().query("SELECT @@SPID AS spid, OBJECT_ID(N'tempdb..#m5_identity_query_probe') AS object_id");
    const spid = Number(beforeOn.recordset?.[0]?.spid);
    assert.ok(Number(beforeOn.recordset?.[0]?.object_id), 'la #temp creada por batch existe antes de batch(ON)');
    stage = 'batch-identity-on';
    await request().batch('SET IDENTITY_INSERT #m5_identity_query_probe ON');
    identityEnabled = true;
    stage = 'query-insert-explicit-id';
    await request().input('id', 918).input('label', 'query-probe').query('INSERT #m5_identity_query_probe ([id], [label]) VALUES (@id, @label)');
    stage = 'query-spid-after-insert';
    const inserted = await request().query('SELECT @@SPID AS spid, id FROM #m5_identity_query_probe');
    assert.equal(Number(inserted.recordset?.[0]?.spid), spid, 'query() conserva la sesión de Transaction');
    assert.equal(Number(inserted.recordset?.[0]?.id), 918);
    stage = 'batch-identity-off';
    await request().batch('SET IDENTITY_INSERT #m5_identity_query_probe OFF');
    identityEnabled = false;
  } catch (error) {
    primaryError = error;
    attachSecondary(primaryError, 'm5IdentityStage', stage);
    throw error;
  } finally {
    // La limpieza se escribe aquí porque el nombre temporal es distinto del
    // primer probe; conserva el mismo contrato de error primario.
    let cleanupError = null;
    let rollbackError = null;
    let closeError = null;
    if (identityEnabled) {
      try { await transaction.request().batch('SET IDENTITY_INSERT #m5_identity_query_probe OFF'); } catch (error) { cleanupError = error; }
    }
    if (began) {
      try { await transaction.rollback(); } catch (error) { rollbackError = error; }
    }
    try { await pool.close(); } catch (error) { closeError = error; }
    if (primaryError) {
      if (cleanupError) attachSecondary(primaryError, 'identityInsertCleanupError', cleanupError);
      if (rollbackError) attachSecondary(primaryError, 'rollbackError', rollbackError);
      if (closeError) attachSecondary(primaryError, 'closeError', closeError);
    } else if (cleanupError) throw cleanupError;
    else if (rollbackError) throw rollbackError;
    else if (closeError) throw closeError;
  }
});

test('M5 diagnóstico no oculta el error primario cuando rollback devuelve EABORT', async () => {
  const primary = new Error('fallo SQL original');
  const transaction = {
    request: () => ({ batch: async () => { throw new Error('limpieza fallida'); } }),
    rollback: async () => { const error = new Error('Transaction has been aborted'); error.code = 'EABORT'; throw error; },
  };
  const pool = { close: async () => { throw new Error('cierre fallido'); } };
  await cleanupIdentityProbe({ transaction, pool, began: true, identityEnabled: true, primaryError: primary });
  assert.equal(primary.message, 'fallo SQL original');
  assert.match(primary.identityInsertCleanupError?.message || '', /limpieza fallida/);
  assert.equal(primary.rollbackError?.code, 'EABORT');
  assert.match(primary.closeError?.message || '', /cierre fallido/);
});

test('M5 diagnóstico declara una #temp de sesión y verifica OBJECT_ID', () => {
  assert.equal(TEMP_TABLE_NAME, '#m5_identity_probe');
  assert.match(TEMP_OBJECT_ID_SQL, /OBJECT_ID\(N'tempdb\.\.#m5_identity_probe'\)/);
});
