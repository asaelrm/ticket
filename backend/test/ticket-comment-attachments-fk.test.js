// C4 · Orden de borrado cuando falla un adjunto de un comentario.
//
// ticket_attachments.comment_id REFERENCES ticket_comments(id):
//   · ON DELETE CASCADE en SQLite (schema.sql)
//   · ON DELETE NO ACTION en SQL Server (schema.mssql.tickets-dev.sql)
//
// El código antiguo borraba PRIMERO el comentario: en SQLite lo tapaba el
// CASCADE, pero en SQL Server el borrado revienta dentro del propio catch (la
// FK impide dejar adjuntos referenciados), la respuesta deja de ser el 500
// explicativo y pasa a "Error interno del servidor", y el comentario queda
// huérfano en la base.
//
// La suite corre sobre SQLite, así que aquí se reproduce la semántica de SQL
// Server (FK sin CASCADE) sobre la misma conexión: el orden de los DELETE pasa
// a ser observable. Se comprueba también el orden en la fuente, para que la
// regresión se vea aunque alguien cambie el simulador.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import db from '../src/db.js';
import { createClient } from './helpers.js';

const IMG_PNG = {
  name: 'captura.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

const IMG_PNG_2 = {
  name: 'captura-dos.png',
  mime: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
};

function envolver(statement, overrides) {
  return new Proxy(statement, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Instala durante `fn` las dos consecuencias que SQL Server tiene y SQLite no:
 * el INSERT de un adjunto puede fallar a mitad de la lista y, si falla, el
 * comentario que lo referencia no puede borrarse mientras haya algún adjunto
 * ya insertado apuntándolo (la primera fila sí entra).
 * Se restaura SIEMPRE, pase lo que pase dentro de `fn`.
 */
async function conSemanticaDeSqlServer(fn) {
  const original = db.prepare;
  let adjuntosInsertados = 0;
  const preparar = function preparar(sql) {
    const statement = original.call(db, sql);

    if (/^\s*INSERT\s+INTO\s+ticket_attachments/i.test(sql)) {
      return envolver(statement, {
        run(...args) {
          adjuntosInsertados += 1;
          // Solo el primer adjunto entra: el segundo revienta a mitad de la
          // lista, que es como falla una transacción real en SQL Server.
          if (adjuntosInsertados > 1) throw new Error('fallo provocado al insertar el adjunto');
          return statement.run(...args);
        },
      });
    }

    if (/^\s*DELETE\s+FROM\s+ticket_comments\s+WHERE\s+id\s*=\s*\?/i.test(sql)) {
      return envolver(statement, {
        run(...args) {
          const [commentId] = args;
          const row = original
            .call(db, 'SELECT COUNT(*) AS n FROM ticket_attachments WHERE comment_id = ?')
            .get(commentId);
          if (Number(row.n) > 0) {
            throw new Error('FOREIGN KEY constraint failed: ticket_attachments.comment_id (NO ACTION)');
          }
          return statement.run(...args);
        },
      });
    }

    return statement;
  };

  db.prepare = preparar;
  try {
    return await fn();
  } finally {
    db.prepare = original;
  }
}

async function crearTicket(admin) {
  const res = await admin.post('/api/tickets', {
    title: 'Ticket para probar el fallo de adjuntos',
    description: 'Descripción de prueba',
    category_id: 1,
    priority: 'MEDIUM',
  });
  assert.equal(res.status, 201, `no se pudo crear el ticket de prueba: ${JSON.stringify(res.body)}`);
  return res.body.ticket.id;
}

describe('Adjuntos de un comentario: el orden de borrado del error', () => {
  it('devuelve el 500 explicativo y no deja el comentario huérfano', async () => {
    const admin = createClient();
    await admin.login('admin', '123456');
    const ticketId = await crearTicket(admin);

    // Dos adjuntos: el primero entra y el segundo falla, de modo que al llegar
    // al catch el comentario sí tiene adjuntos referenciándolo.
    const res = await conSemanticaDeSqlServer(() =>
      admin.postMultipart(`/api/tickets/${ticketId}/comments`, { message: 'Con adjuntos' }, [IMG_PNG, IMG_PNG_2]),
    );

    assert.equal(res.status, 500, 'el fallo de adjuntos debe responder 500, no un error interno genérico');
    assert.equal(res.body.error, 'Error al guardar los archivos adjuntos');

    const comentarios = db.prepare('SELECT id FROM ticket_comments WHERE ticket_id = ?').all(ticketId);
    assert.equal(comentarios.length, 0, 'el comentario debe borrarse: no puede quedar sin sus adjuntos');

    const adjuntos = db.prepare('SELECT id FROM ticket_attachments WHERE ticket_id = ?').all(ticketId);
    assert.equal(adjuntos.length, 0, 'no debe quedar ningún adjunto a medio insertar');
  });

  it('el DELETE de adjuntos va ANTES del DELETE del comentario en processComment', () => {
    const fuente = readFileSync(new URL('../src/routes/tickets.js', import.meta.url), 'utf8');
    const inicio = fuente.indexOf('function processComment');
    const fin = fuente.indexOf('function requireTicketWriteAccess');
    assert.ok(inicio > -1 && fin > inicio, 'no se encontró processComment en routes/tickets.js');

    const bloque = fuente.slice(inicio, fin);
    const adjuntos = bloque.indexOf('DELETE FROM ticket_attachments WHERE comment_id');
    const comentario = bloque.indexOf('DELETE FROM ticket_comments WHERE id');

    assert.ok(adjuntos > -1, 'el error de adjuntos debe limpiar ticket_attachments');
    assert.ok(comentario > -1, 'el error de adjuntos debe limpiar ticket_comments');
    assert.ok(
      adjuntos < comentario,
      'hay que borrar primero los adjuntos: en SQL Server la FK es ON DELETE NO ACTION',
    );
  });
});
