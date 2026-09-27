// ============================================================================
// Sumidero SMTP minimo, SOLO para el laboratorio.
// ============================================================================
// No es un servidor de correo: habla justo el trozo de SMTP que necesita
// nodemailer para entregar un mensaje, y guarda cada correo recibido en un
// fichero. Sirve para poder probar la recuperacion de contrasena en modo
// PRODUCCION, donde la API ya no devuelve el token en la respuesta (a
// proposito) y la unica via para obtenerlo es leer el correo.
//
// Sin dependencias a proposito: el laboratorio tiene que poder levantarse sin
// descargar nada de Internet.
//
// NO se usa en produccion. El servicio real manda el correo por SMTP real.
// ============================================================================

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.SINK_PORT || 1025);
const DIR = process.env.SINK_DIR || '/correo';
fs.mkdirSync(DIR, { recursive: true });

let recibido = 0;

const servidor = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 sink.lab ESMTP sumidero-de-laboratorio\r\n');

  let enDatos = false;
  let buffer = '';
  let mensaje = '';
  let destinatario = null;

  const responder = (texto) => socket.write(`${texto}\r\n`);

  socket.on('data', (trozo) => {
    buffer += trozo;

    while (buffer.includes('\r\n')) {
      const corte = buffer.indexOf('\r\n');
      const linea = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);

      if (enDatos) {
        // Fin del cuerpo: una linea que sea solo un punto.
        if (linea === '.') {
          enDatos = false;
          recibido += 1;
          const nombre = path.join(DIR, `correo-${String(recibido).padStart(3, '0')}.txt`);
          // Deshacer el "dot stuffing" que anade el cliente a las lineas
          // que empiezan por punto.
          fs.writeFileSync(nombre, mensaje.replace(/\r\n\.\./g, '\r\n.'), 'utf8');
          console.log(`[sink] correo ${nombre} -> ${destinatario}`);
          mensaje = '';
          destinatario = null;
          responder('250 2.0.0 Aceptado');
        } else {
          mensaje += `${linea}\n`;
        }
        continue;
      }

      const comando = linea.toUpperCase();

      if (comando.startsWith('EHLO')) {
        // Se anuncia SIZE para que nodemailer sepa que puede enviar cuerpos grandes.
        socket.write('250-sink.lab\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n');
      } else if (comando.startsWith('HELO')) {
        responder('250 sink.lab');
      } else if (comando.startsWith('MAIL FROM')) {
        responder('250 2.1.0 Remitente ok');
      } else if (comando.startsWith('RCPT TO')) {
        destinatario = (linea.match(/<([^>]*)>/) || [, 'desconocido'])[1];
        responder('250 2.1.5 Destinatario ok');
      } else if (comando === 'DATA') {
        enDatos = true;
        responder('354 Fin de datos con <CR><LF>.<CR><LF>');
      } else if (comando === 'RSET') {
        mensaje = '';
        destinatario = null;
        responder('250 2.0.0 Restablecido');
      } else if (comando === 'NOOP') {
        responder('250 2.0.0 Ok');
      } else if (comando === 'QUIT') {
        responder('221 2.0.0 Adios');
        socket.end();
      } else {
        // AUTH y comandos raros: se aceptan sin hacer nada.
        responder('250 2.0.0 Ok');
      }
    }
  });

  socket.on('error', () => {});
});

servidor.listen(PORT, '0.0.0.0', () => {
  console.log(`[sink] escuchando en 0.0.0.0:${PORT}, escribiendo en ${DIR}`);
});
