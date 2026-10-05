import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// config.js lee el entorno al importarse, así que cada caso necesita una copia
// fresca del módulo con las variables que interesan.
async function configCon(env) {
  const ruta = pathToFileURL(
    path.resolve(import.meta.dirname, '../src/config.js')
  ).href;
  const anterior = {};
  for (const [k, v] of Object.entries(env)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const { default: config } = await import(`${ruta}?caso=${Math.random()}`);
    return config;
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('config · PUBLIC_URL', () => {
  it('sin definir, usa el origen del frontend y no el puerto de la API', async () => {
    const config = await configCon({ PUBLIC_URL: undefined, CORS_ORIGIN: undefined, PORT: '4000' });
    // El enlace de recuperación lo sirve el frontend, no la API: con el puerto
    // 4000 el correo llevaría a una página inexistente.
    assert.equal(config.publicUrl, 'http://localhost:5173');
  });

  it('respeta PUBLIC_URL cuando está definido', async () => {
    const config = await configCon({ PUBLIC_URL: 'https://tickets.tuempresa.com' });
    assert.equal(config.publicUrl, 'https://tickets.tuempresa.com');
  });

  it('tolera un slash final en PUBLIC_URL', async () => {
    const config = await configCon({ PUBLIC_URL: 'https://tickets.tuempresa.com/' });
    assert.equal(config.publicUrl, 'https://tickets.tuempresa.com');
  });

  it('si solo hay CORS_ORIGIN, toma su primer origen', async () => {
    const config = await configCon({ PUBLIC_URL: undefined, CORS_ORIGIN: 'https://a.example, https://b.example' });
    assert.equal(config.publicUrl, 'https://a.example');
  });
});

describe('config · DB_CLIENT', () => {
  it('sin DB_CLIENT conserva SQLite por compatibilidad', async () => {
    const config = await configCon({ DB_CLIENT: undefined });
    assert.equal(config.dbClient, 'sqlite');
  });

  it('acepta SQLite de forma explícita sin distinguir mayúsculas', async () => {
    const config = await configCon({ DB_CLIENT: 'SQLITE' });
    assert.equal(config.dbClient, 'sqlite');
  });

  it('acepta mssql para su contrato async futuro', async () => {
    const config = await configCon({ DB_CLIENT: 'mssql' });
    assert.equal(config.dbClient, 'mssql');
  });

  it('rechaza proveedores sin implementación', async () => {
    await assert.rejects(
      configCon({ DB_CLIENT: 'otro' }),
      /DB_CLIENT no soportado.*sqlite.*mssql/i,
    );
  });
});
