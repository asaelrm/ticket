import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import config, { dbClient, requestedDbClient } from '../src/config.js';

describe('M1 backend selection guard', () => {
  it('keeps SQLite as the effective default backend', () => {
    assert.equal(config.dbClient, 'sqlite');
    assert.equal(dbClient(), 'sqlite');
  });

  it('marks MSSQL as requested but keeps SQLite as the active backend', () => {
    assert.equal(requestedDbClient('mssql'), 'mssql');
    assert.equal(dbClient('mssql'), 'sqlite');
    assert.equal(config.mssqlRuntimeEnabled, false);
  });
});
