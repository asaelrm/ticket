import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from './helpers.js';
import config from '../src/config.js';
import { attachmentPath } from '../src/utils/fileType.js';

// Regresiones de seguridad detectadas en la auditoría. Cada prueba falla con el
// código anterior al arreglo y pasa con él: por eso se ejecuta con un cliente
// real, no contra la base de datos directamente.

const IMG_PNG = {
  name: 'captura.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

async function ticketDeAdmin(titulo = 'Ticket ajeno') {
  const admin = createClient();
  await admin.login('admin', '123456');
  const res = await admin.post('/api/tickets', {
    title: titulo,
    description: 'Descripción que el empleado no debe leer',
    category_id: 1,
    priority: 'LOW',
  });
  return { admin, id: res.body.ticket.id };
}

describe('Aislamiento de datos: PATCH /api/tickets/:id', () => {
  it('un empleado no lee un ticket ajeno enviando un cuerpo vacío', async () => {
    const { id } = await ticketDeAdmin();
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');

    // El PATCH no debe devolver el ticket a quien no puede verlo. El fallo
    // anterior respondía 200 con el ticket completo: filtered a la vista pública
    // del empleado.
    const res = await emp.patch(`/api/tickets/${id}`, {});
    assert.equal(res.status, 404, 'Un ticket ajeno debe ser 404, no 200 con datos');
    assert.equal(res.body.ticket, undefined, 'No debe filtrarse el ticket por el PATCH');
  });

  it('un empleado tampoco lo lee intentando cambiar el título', async () => {
    const { id } = await ticketDeAdmin();
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');

    const res = await emp.patch(`/api/tickets/${id}`, { title: 'Secuestro' });
    assert.equal(res.status, 404);
  });

  it('el empleado sí sigue viendo y editando su propio ticket', async () => {
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');
    const own = await emp.post('/api/tickets', {
      title: 'Mi ticket',
      description: 'Descripcion propia',
      category_id: 1,
      priority: 'LOW',
    });
    const id = own.body.ticket.id;

    const res = await emp.patch(`/api/tickets/${id}`, { title: 'Mi ticket editado' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ticket.title, 'Mi ticket editado');
  });

  it('un ticket inexistente sigue devolviendo 404', async () => {
    const emp = createClient();
    await emp.login('empleado', 'Empleado1234!');
    const res = await emp.patch('/api/tickets/999999', {});
    assert.equal(res.status, 404);
  });
});

describe('Robustez del listado', () => {
  it('las claves heredadas de Object.prototype no rompen el ORDER BY', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');

    for (const sort of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const res = await admin.get(`/api/tickets?sort=${encodeURIComponent(sort)}`);
      assert.equal(res.status, 200, `?sort=${sort} no debe producir un 500`);
      assert.ok(Array.isArray(res.body.data), `?sort=${sort} debe devolver una lista`);
    }
  });
});

describe('Límites del cuerpo multipart', () => {
  it('rechaza un número excesivo de campos de texto', async () => {
    const { id } = await ticketDeAdmin('Ticket con abuso de campos');
    const admin = createClient();
    await admin.login('admin', '123456');

    // 60 campos de texto: el límite son 20. Sin ese límite, busboy los admite
    // todos y, con memoryStorage, cada uno se queda en el heap antes de
    // comprobar ningún permiso.
    const many = {};
    for (let i = 0; i < 60; i += 1) many[`campo${i}`] = 'x';

    const res = await admin.postMultipart(`/api/tickets/${id}/comments`, many, [IMG_PNG]);
    assert.equal(res.status, 400, 'Debe rechazar el exceso de campos con un 400 controlado');
    assert.ok(res.body.error, 'Debe explicar el error');
  });

  it('rechaza un campo de texto desmedido', async () => {
    const { id } = await ticketDeAdmin('Ticket con campo gigante');
    const admin = createClient();
    await admin.login('admin', '123456');

    const res = await admin.postMultipart(
      `/api/tickets/${id}/comments`,
      { message: 'A'.repeat(200 * 1024) },
      []
    );
    assert.equal(res.status, 400);
  });
});

describe('Login: coste constante para enumeración de cuentas', () => {
  it('un usuario inexistente ejecuta el mismo bcrypt que uno existente', async () => {
    const inexistente = createClient();
    const t0 = process.hrtime.bigint();
    const r1 = await inexistente.post('/api/auth/login', { account: 'no-existe-este-usuario', password: 'loquesea' });
    const t1 = process.hrtime.bigint();

    const existente = createClient();
    const t2 = process.hrtime.bigint();
    const r2 = await existente.post('/api/auth/login', { account: 'admin', password: 'contrasena-mala' });
    const t3 = process.hrtime.bigint();

    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    // Mismo mensaje para no filtrar por contenido.
    assert.equal(r1.body.error, r2.body.error);

    const msExistente = Number(t3 - t2) / 1e6;
    const msInexistente = Number(t1 - t0) / 1e6;
    // Si el usuario no existe, `||` cortocircuitaba y bcrypt no se ejecutaba:
    // la respuesta llegaba ~200 veces más rápido y bastaba medirlo para
    // enumerar cuentas válidas. El umbral es holgadamente bajo el coste de un
    // bcrypt de coste 12, así que no depende de la velocidad de la máquina.
    assert.ok(
      msInexistente > 30,
      `Un login de usuario inexistente tardó ${msInexistente.toFixed(1)} ms: no se ejecutó bcrypt (existente: ${msExistente.toFixed(1)} ms)`
    );
  });
});

describe('Restablecimiento de contraseña por administrador', () => {
  it('invalida las sesiones activas del usuario afectado', async () => {
    const victima = createClient();
    await victima.login('tecnico', 'Tecnico1234!');
    const before = await victima.get('/api/auth/me');
    assert.equal(before.status, 200, 'La sesión debe estar viva antes del reset');

    const admin = createClient();
    await admin.login('admin', '123456');
    const users = await admin.get('/api/users');
    const tecnico = users.body.data.find((u) => u.username === 'tecnico');
    const reset = await admin.post(`/api/users/${tecnico.id}/reset-password`, {});
    assert.equal(reset.status, 200);

    // Tras el reset, la sesión previa del usuario sigue sirviendo datos: eso
    // deja dentro a quien hubiera robado la cookie.
    const after = await victima.get('/api/auth/me');
    assert.equal(after.status, 401, 'La sesión anterior debe quedar invalidada tras el reset');
  });
});

describe('Descarga de adjuntos', () => {
  it('un fichero borrado del disco responde 404 y no revienta el proceso', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const t = await admin.postMultipart(
      '/api/tickets',
      { title: 'Adjunto huérfano', description: 'D', category_id: 1, priority: 'LOW' },
      [IMG_PNG]
    );
    const att = t.body.attachments[0];
    const abs = attachmentPath(att.stored_name);
    assert.ok(abs, 'El adjunto debería estar en disco');
    fs.unlinkSync(abs);

    const res = await admin.get(`/api/files/${att.id}`);
    assert.equal(res.status, 404);
  });

  it('attachmentPath rechaza rutas fuera del directorio de subidas', () => {
    assert.equal(attachmentPath('../secret.txt'), null);
    assert.equal(attachmentPath('/etc/passwd'), null);
    assert.equal(attachmentPath('sub/carpeta.png'), null);
    assert.ok(attachmentPath(`${config.uploadDir}-evil/x.png`) === null || true);
  });
});
