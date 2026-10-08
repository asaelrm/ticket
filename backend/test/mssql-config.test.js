import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config, { dbClient, requestedDbClient } from '../src/config.js';

describe('Selección de motor de ejecución (DB_CLIENT)', () => {
  it('SQLite sigue siendo el motor por defecto', () => {
    assert.equal(config.dbClient, 'sqlite');
    assert.equal(dbClient(), 'sqlite');
  });

  it('DB_CLIENT=mssql por sí solo NO activa SQL Server en el proceso', () => {
    // Los scripts de migración sí ven la petición cruda...
    assert.equal(requestedDbClient('mssql'), 'mssql');
    // ...pero el runtime no puede hablar con SQL Server hasta que se active:
    // si lo hiciera, sesiones y consultas irían a un esquema que aún no existe
    // (login 500) mientras el resto de la app sigue en SQLite.
    assert.equal(dbClient('mssql'), 'sqlite');
    assert.equal(config.dbClient, 'sqlite');
    assert.equal(config.mssqlRuntimeEnabled, false);
  });

  it('con MSSQL_RUNTIME=true el runtime sí usa SQL Server', () => {
    assert.equal(dbClient('mssql', { MSSQL_RUNTIME: 'true' }), 'mssql');
    assert.equal(dbClient('mssql', { MSSQL_RUNTIME: '1' }), 'mssql');
    // La activación no cambia un motor pedido explícitamente como SQLite.
    assert.equal(dbClient('sqlite', { MSSQL_RUNTIME: 'true' }), 'sqlite');
    assert.equal(dbClient(undefined, { MSSQL_RUNTIME: 'true' }), 'sqlite');
  });

  it('un valor de DB_CLIENT desconocido detiene el arranque', () => {
    assert.throws(() => requestedDbClient('oracle'), /DB_CLIENT no soportado/);
    assert.throws(() => dbClient('oracle'), /DB_CLIENT no soportado/);
    assert.throws(() => requestedDbClient('SQLite, mssql'), /DB_CLIENT no soportado/);
  });

  it('admite variaciones de mayúsculas y espacios', () => {
    assert.equal(requestedDbClient(' MSSQL '), 'mssql');
    assert.equal(requestedDbClient('SQLite'), 'sqlite');
    assert.equal(requestedDbClient(''), 'sqlite');
    assert.equal(requestedDbClient(undefined), 'sqlite');
  });
});
