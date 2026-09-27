// ============================================================================
// ¿Coincide el origen de CORS de forma EXACTA o por subcadena?
// ============================================================================
// node --test usa un proceso por archivo, asi que este archivo puede fijar
// CORS_ORIGINS ANTES de que se importe app.js (que es quien lo lee al crearse
// la aplicacion) y medir el comportamiento real, en vez de deducirlo leyendo
// el codigo.
//
// La respuesta importa: si la comparacion fuera por subcadena, un atacante
// controlaria un dominio como `tickets.lan.evil.example` y el navegador le
// daria luz verde para Talking con credenciales al origen bueno.

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Se declaran a proposito los espacios que deja un .env real. Asi una sola
// instancia de la aplicacion cubre las dos mitades: que el recorte funciona y
// que la comparacion es exacta.
const PERMITIDOS = '  https://tickets.lan ,  http://localhost:5173  ';
process.env.CORS_ORIGINS = PERMITIDOS;

const { createApp } = await import('../src/app.js');
const app = createApp();

const cabecera = (res) => res.headers['access-control-allow-origin'];

// --- Lo que SI debe funcionar -------------------------------------------------
test('un origen exactamente igual recibe la cabecera', async () => {
  for (const origen of ['https://tickets.lan', 'http://localhost:5173']) {
    const res = await request(app).get('/api/health').set('Origin', origen);
    assert.equal(cabecera(res), origen, `deberia Permitir ${origen}`);
  }
});

test('los espacios sobrantes de la lista se ignoran', async () => {
  // CORS_ORIGINS se declara con comas y espacios en el .env; el recorte es lo
  // que hace que " https://tickets.lan" no acabe siendo un origen distinto.
  // Este archivo no reimporta app.js: una segunda instancia abriria otra
  // conexion a la base de datos. La lista de arriba ya trae los espacios.
  const res = await request(app).get('/api/health').set('Origin', 'https://tickets.lan');
  assert.equal(cabecera(res), 'https://tickets.lan');
});

// --- Lo que NO debe pasar -----------------------------------------------------
// Cada caso de aqui seria un fallo si la comparacion fuera por subcadena, o
// un fallo de criterio si fuera por正规izacion incompleta.
const RECHAZADOS = [
  ['un dominio que empieza por el permitido', 'https://tickets.lan.evil.example'],
  ['un dominio que lo contiene', 'https://evil.example/https://tickets.lan'],
  ['un subdominio del permitido', 'https://sub.tickets.lan'],
  ['el mismo con otro puerto', 'https://tickets.lan:8443'],
  ['el mismo en http (degradar a texto plano)', 'http://tickets.lan'],
  ['el mismo con barra final', 'https://tickets.lan/'],
  ['otro origen permitido, alterado', 'http://localhost:5173.evil.example'],
  ['un origen sin esquema', 'tickets.lan'],
  ['otro puerto distinto', 'http://localhost:4000'],
];

for (const [nombre, origen] of RECHAZADOS) {
  test(`se rechaza ${nombre}: ${origen}`, async () => {
    const res = await request(app).get('/api/health').set('Origin', origen);
    assert.equal(cabecera(res), undefined, `no deberia Permitir ${origen}`);
  });
}

test('sin cabecera Origin no se concede nada', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(cabecera(res), undefined);
});

// --- El caso que distingue una comparacion de la otra -------------------------
test('una lista de dos origenes no habilita ninguno de sus fragmentos', async () => {
  // Este es el test que falla si el codigo hiciera
  //   'https://a.example,https://b.example'.includes(origen)
  // porque ahi 'a.example' SI esta contenido en la cadena unida.
  const origen = 'tickets.lan';
  const res = await request(app).get('/api/health').set('Origin', origen);
  assert.equal(
    cabecera(res),
    undefined,
    'un fragmento de la lista debe rechazarse: eso solo pasaria con comparacion por subcadena'
  );
});
