import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config, { dbClient, requestedDbClient } from '../src/config.js';

describe('Selección de motor de ejecución (DB_CLIENT)', () => {
  it('SQL Server es el único motor y el valor por defecto', () => {
    assert.equal(config.dbClient, 'mssql');
    assert.equal(dbClient(), 'mssql');
    assert.equal(requestedDbClient(), 'mssql');
  });

  it('acepta explícitamente "mssql", con variaciones de mayúsculas y espacios', () => {
    assert.equal(requestedDbClient('mssql'), 'mssql');
    assert.equal(requestedDbClient(' MSSQL '), 'mssql');
    assert.equal(dbClient('mssql'), 'mssql');
  });

  it('un DB_CLIENT vacío o ausente cae en el motor por defecto (mssql)', () => {
    assert.equal(requestedDbClient(''), 'mssql');
    assert.equal(requestedDbClient(undefined), 'mssql');
  });

  it('SQLite ya no es un motor soportado y detiene el arranque', () => {
    assert.throws(() => requestedDbClient('sqlite'), /DB_CLIENT no soportado/);
    assert.throws(() => requestedDbClient('SQLite'), /DB_CLIENT no soportado/);
    assert.throws(() => dbClient('sqlite'), /DB_CLIENT no soportado/);
  });

  it('un valor de DB_CLIENT desconocido detiene el arranque', () => {
    assert.throws(() => requestedDbClient('oracle'), /DB_CLIENT no soportado/);
    assert.throws(() => dbClient('oracle'), /DB_CLIENT no soportado/);
    assert.throws(() => requestedDbClient('SQLite, mssql'), /DB_CLIENT no soportado/);
  });
});
