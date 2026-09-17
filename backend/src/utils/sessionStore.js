import { Store } from 'express-session';
import db from '../db.js';

// Store de sesiones respaldado por SQLite (tabla `sessions`).
export default class SqliteSessionStore extends Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?').get(sid, Date.now());
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

  set(sid, session, callback) {
    try {
      const expire = this.#expiry(session);
      db.prepare(
        `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`
      ).run(sid, JSON.stringify(session), expire);
      db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now());
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  touch(sid, session, callback) {
    try {
      const expire = this.#expiry(session);
      db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expire, sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  length(callback) {
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      return callback(null, n);
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