// B13-A · lectura de la SQLite de origen, en modo SOLO LECTURA.
//
// Reglas de este módulo:
//   - se abre con `readOnly: true` y además con `PRAGMA query_only=ON`, para que
//     ni un error de este fichero pueda escribir en el volumen `ticket_dev_data`;
//   - todo el manifiesto se lee dentro de UNA transacción de lectura breve, que
//     es lo que hace que la vista sea coherente aunque la app esté insertando;
//   - el manifiesto se devuelve entero en memoria y la conexión se cierra antes
//     de que el llamante abra una transacción de escritura en SQL Server.
//
// Un detalle que no es evidente: una base en modo WAL necesita su fichero
// `-shm` (índice compartido) para leerse, y SQLite lo crea al abrir. Abrir en
// solo lectura NO deja el volumen intacto al 100 %, deja el `tickets.db` intacto
// y materializa los dos ficheros de acompanamiento. No se puede evitar sin
// `immutable=1`, que sí ignoraría el WAL y está prohibido: ignorar el WAL
// copiaría datos que la app aún no ha consolidado.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Abre la fuente en solo lectura y devuelve la conexión con `query_only` activo.
 * La ruta se comprueba aquí y no solo en el migrador: es esta la función que
 * decide a qué fichero se abre.
 */
export function openSourceReadOnly(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`No existe la SQLite de origen: ${path.resolve(sourcePath)}`);
  }

  const db = new DatabaseSync(sourcePath, { readOnly: true });

  try {
    // Belt and braces: `readOnly` ya impide escribir, y `query_only` impide
    // además que una sentencia futura sin querer amplíe el radio de acción.
    db.exec('PRAGMA query_only = ON');
    if (Number(db.prepare('PRAGMA query_only').get().query_only) !== 1) {
      throw new Error('No se pudo activar PRAGMA query_only en la fuente; se aborta.');
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

/** Tamaño del WAL en el momento de la lectura, para poder informarlo. */
export function walSize(sourcePath) {
  try {
    return fs.statSync(`${sourcePath}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Lee el manifiesto completo dentro de una transacción de lectura y lo devuelve.
 * NO cierra la conexión: de eso se encarga `readSourceManifest`, que es la que
 * cumple el requisito de cerrarla antes de escribir en el otro motor. Aquí solo
 * se lee, para poder reutilizarla en pruebas con una base temporal.
 */
export function readDepartmentsManifestFrom(db, sourcePath) {
  db.exec('BEGIN DEFERRED');
  try {
    const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const rows = db
      .prepare('SELECT id, name, description, active, created_at FROM departments ORDER BY id')
      .all();

    // `sqlite_sequence` solo tiene fila si alguna vez se insertó con AUTOINCREMENT.
    const sequenceRow = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'departments'")
      .get();
    const sequence = sequenceRow ? Number(sequenceRow.seq) : null;

    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    db.exec('COMMIT');

    return {
      rows,
      sequence,
      foreignKeyViolations,
      journalMode,
      walBytes: walSize(sourcePath),
      readAt: new Date().toISOString(),
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Si la transacción de lectura no llegó a abrirse, no hay nada que deshacer.
    }
    throw error;
  }
}

/**
 * Apertura + lectura + cierre. Devuelve el manifiesto ya en memoria: a partir de
 * aquí la fuente no está abierta y el migrador puede escribir en SQL Server sin
 * ningún otro proceso de Node sosteniendo un handle del volumen.
 */
export function readSourceManifest(sourcePath) {
  const db = openSourceReadOnly(sourcePath);
  try {
    return readDepartmentsManifestFrom(db, sourcePath);
  } finally {
    db.close();
  }
}