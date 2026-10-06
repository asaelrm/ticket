import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  C1_TABLES, EXPECTED_CHECKS, EXPECTED_FKS, EXPECTED_INDEXES, EXPECTED_KEYS,
  PROTECTED_TABLES, configurationFromEnv, validateC1Rollback,
} from '../src/scripts/validate-c1-mssql-rollback.mjs';

const env = () => ({
  DB_CLIENT: 'mssql', DB_SERVER: 'test-host', DB_PORT: '1433',
  DB_DATABASE: 'SIFHA_Tickets_DEV', DB_USER: 'migration-test', DB_PASSWORD: 'never-print-me',
  DB_ENCRYPT: 'true', DB_TRUST_SERVER_CERTIFICATE: 'false',
});

function fakeMssql(state = {}) {
  state.c1 = Boolean(state.c1);
  state.tran = 0;
  state.rollbacks = 0;
  state.commits = 0;
  const request = () => ({
    async query(text) {
      const tag = /\/\* C1V:([^* ]+)/.exec(text)?.[1] || '';
      if (tag === 'identity') return { recordset: [{ database: state.database ?? 'SIFHA_Tickets_DEV', original_login: state.login ?? 'migration-test', suser: state.suser ?? 'migration-test' }] };
      if (tag.includes('tables')) return { recordset: state.c1 ? C1_TABLES.map((name) => ({ name })) : [] };
      if (tag.includes('protected:objects')) {
        const missing = new Set(state.protectedMissing || []);
        return { recordset: PROTECTED_TABLES.filter((name) => !missing.has(name)).map((name, i) => ({ name, object_id: i + 100 })) };
      }
      if (tag.includes('protected:count:')) {
        const name = tag.split(':').at(-1);
        const changed = state.protectedChange && tag.startsWith('after-');
        return { recordset: [{ row_count: changed && name === 'users' ? 99 : 1 }] };
      }
      if (tag === 'before-ddl' || tag === 'after-ddl' || tag === 'error-trancount') return { recordset: [{ tran_count: state.tran }] };
      if (tag === 'inside-fks') return { recordset: [...EXPECTED_FKS].map(([name, delete_referential_action_desc]) => ({ name, delete_referential_action_desc })) };
      if (tag === 'inside-keys') return { recordset: EXPECTED_KEYS.map((name) => ({ name })) };
      if (tag === 'inside-checks') return { recordset: EXPECTED_CHECKS.map((name) => ({ name })) };
      if (tag === 'inside-indexes') return { recordset: EXPECTED_INDEXES.map((name) => ({ name })) };
      throw new Error(`consulta no simulada: ${tag}`);
    },
    async batch() {
      state.batchCalls = (state.batchCalls || 0) + 1;
      if (state.batchError) throw (state.batchError instanceof Error ? state.batchError : new Error('fallo ddl simulado'));
      state.c1 = true;
      if (state.afterTran !== undefined) state.tran = state.afterTran;
    },
  });
  class Transaction {
    constructor(pool) { this.pool = pool; }
    async begin() { state.tran = 1; }
    request() { return request(); }
    async rollback() { state.rollbacks += 1; state.tran = 0; state.c1 = false; }
    async commit() { state.commits += 1; }
  }
  return {
    Transaction,
    async connect() { return { request, async close() { state.closed = true; } }; },
  };
}

const ddl = async () => '-- ddl de prueba sin secretos';
const quiet = () => {};

describe('validador C1 con rollback', () => {
  it('bloquea DB_CLIENT y base no permitidos sin conectar', () => {
    assert.throws(() => configurationFromEnv({ ...env(), DB_CLIENT: 'sqlite' }), /DB_CLIENT/);
    assert.throws(() => configurationFromEnv({ ...env(), DB_DATABASE: 'otra' }), /DB_DATABASE/);
  });

  it('bloquea una DB_NAME() distinta después de conectar', async () => {
    await assert.rejects(
      validateC1Rollback({ env: env(), sqlModule: fakeMssql({ database: 'master' }), readFile: ddl, log: quiet }),
      /validación C1 falló/i,
    );
  });

  it('bloquea sa y no expone la contraseña en el error', async () => {
    const state = { login: 'sa' };
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }), /validación C1 falló/i);
    try { await validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }); } catch (error) { assert.doesNotMatch(error.message, /never-print-me/); }
  });

  it('aborta si ya existe una tabla C1 sin abrir transacción ni ejecutar DDL', async () => {
    const state = { c1: true };
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }));
    assert.equal(state.tran, 0);
    assert.equal(state.rollbacks, 0);
  });

  it('informa una tabla protegida faltante, las detectadas y aborta antes del DDL', async () => {
    const state = { protectedMissing: ['sessions'] };
    const output = [];
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: (line) => output.push(line) }));
    const text = output.join('\n');
    assert.match(text, /tablas protegidas encontradas: users, roles, permissions, role_permissions, departments/);
    assert.match(text, /tablas protegidas faltantes: sessions \(ausente o no visible para el login actual\)/);
    assert.doesNotMatch(text, /never-print-me/);
    assert.equal(state.batchCalls || 0, 0);
    assert.equal(state.tran, 0);
  });

  it('informa varias tablas protegidas faltantes', async () => {
    const state = { protectedMissing: ['sessions', 'departments'] };
    const output = [];
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: (line) => output.push(line) }));
    assert.match(output.join('\n'), /tablas protegidas faltantes: departments, sessions/);
    assert.equal(state.batchCalls || 0, 0);
  });

  it('hace rollback en éxito y nunca commit', async () => {
    const state = {};
    const result = await validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet });
    assert.deepEqual(result, { ok: true });
    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
    assert.equal(state.c1, false);
  });

  it('hace rollback ante error de DDL y nunca commit', async () => {
    const state = { batchError: true };
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }));
    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
  });

  it('informa etapa y metadatos SQL, y redacta la contraseña', async () => {
    const technical = Object.assign(new Error('The SELECT permission was denied; password=never-print-me'), {
      name: 'RequestError', code: 'EREQUEST', number: 229, state: 1, class: 14, lineNumber: 42, procName: 'dbo.probe',
    });
    const state = { batchError: technical };
    const output = [];
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: (line) => output.push(line) }));
    const text = output.join('\n');
    assert.match(text, /etapa: ddl-c1/);
    assert.match(text, /error\.name: RequestError/);
    assert.match(text, /error\.code: EREQUEST/);
    assert.match(text, /error\.number: 229/);
    assert.match(text, /error\.lineNumber: 42/);
    assert.match(text, /mensaje: .*\[REDACTED\]/);
    assert.doesNotMatch(text, /never-print-me/);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
  });

  it('detecta @@TRANCOUNT inesperado y revierte', async () => {
    const state = { afterTran: 0 };
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }), /validación C1 falló/i);
    assert.equal(state.rollbacks, 0); // El contador 0 simula que C1 ya revirtió la transacción.
    assert.equal(state.commits, 0);
  });

  it('detecta un cambio posterior en tabla protegida', async () => {
    const state = { protectedChange: true };
    await assert.rejects(validateC1Rollback({ env: env(), sqlModule: fakeMssql(state), readFile: ddl, log: quiet }), /validación C1 falló/i);
    assert.equal(state.rollbacks, 1);
    assert.equal(state.commits, 0);
  });
});
