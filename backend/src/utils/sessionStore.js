import { Store } from 'express-session';
import db from '../db/runtime.js';

// Store de sesiones respaldado por la base de datos (tabla `sessions`).
// La API de express-session es de callbacks, así que las firmas no cambian:
// solo el cuerpo pasa a ser async y usar la fachada de runtime.
export default class SqliteSessionStore extends Store {
  async get(sid, callback) {
    try {
      const row = await db.queryOne('SELECT sess FROM sessions WHERE sid = ? AND expire > ?', sid, Date.now());
      if (!row) return callback(null, null);
      let sess;
      try {
        sess = JSON.parse(row.sess);
      } catch {
        return callback(new Error(`Session deserialization error: ${sid}`));
      }
      return callback(null, sess);
    } catch (err) {
      return callback(err);
    }
  }

  async set(sid, session, callback) {
    try {
      const expire = this.#expiry(session);
      await db.execute(
        `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`,
        sid,
        JSON.stringify(session),
        expire,
      );
      await db.execute('DELETE FROM sessions WHERE expire <= ?', Date.now());
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await db.execute('DELETE FROM sessions WHERE sid = ?', sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  async touch(sid, session, callback) {
    try {
      const expire = this.#expiry(session);
      await db.execute('UPDATE sessions SET expire = ? WHERE sid = ?', expire, sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  async length(callback) {
    try {
      const row = await db.queryOne('SELECT COUNT(*) AS n FROM sessions');
      return callback(null, row.n);
    } catch (err) {
      return callback(err);
    }
  }

  #expiry(session) {
    let expires = session.cookie && session.cookie.expires ? new Date(session.cookie.expires).getTime() : NaN;
    if (!Number.isFinite(expires)) expires = Date.now() + 24 * 60 * 60 * 1000;
    return expires;
  }
}

export async function destroyUserSessions(userId) {
  await db.execute("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?", userId);
}
