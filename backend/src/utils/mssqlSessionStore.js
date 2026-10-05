import { Store } from 'express-session';
import { contract as defaultContract } from '../db.js';

export default class MssqlSessionStore extends Store {
  #contract;

  constructor({ contract = defaultContract } = {}) {
    super();
    this.#contract = contract;
  }

  get(sid, callback) {
    this.#contract.queryOne(
      'SELECT sess FROM dbo.sessions WHERE sid = @sid AND expire > @now',
      { sid, now: Date.now() },
    ).then((row) => {
      if (!row) return callback(null, null);
      try {
        return callback(null, JSON.parse(row.sess));
      } catch {
        return callback(new Error(`Session deserialization error: ${sid}`));
      }
    }).catch(callback);
  }

  set(sid, session, callback) {
    let serialized;
    try {
      serialized = JSON.stringify(session);
    } catch (error) {
      return callback(error);
    }
    const expire = this.#expiry(session);
    this.#contract.execute(
      `UPDATE dbo.sessions SET sess = @sess, expire = @expire WHERE sid = @sid;
       IF @@ROWCOUNT = 0
         INSERT INTO dbo.sessions (sid, sess, expire) VALUES (@sid, @sess, @expire);`,
      { sid, sess: serialized, expire },
    ).then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    this.#contract.execute('DELETE FROM dbo.sessions WHERE sid = @sid', { sid })
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, session, callback) {
    this.#contract.execute('UPDATE dbo.sessions SET expire = @expire WHERE sid = @sid', {
      sid,
      expire: this.#expiry(session),
    }).then(() => callback(null)).catch(callback);
  }

  length(callback) {
    this.#contract.queryOne('SELECT COUNT(*) AS n FROM dbo.sessions')
      .then((row) => callback(null, Number(row?.n || 0)))
      .catch(callback);
  }

  #expiry(session) {
    let expires = session.cookie && session.cookie.expires ? new Date(session.cookie.expires).getTime() : NaN;
    if (!Number.isFinite(expires)) expires = Date.now() + 24 * 60 * 60 * 1000;
    return expires;
  }
}

export async function destroyUserSessionsMssql(userId, contract = defaultContract) {
  return contract.execute(
    "DELETE FROM dbo.sessions WHERE JSON_VALUE(sess, '$.userId') = @userId",
    { userId: String(userId) },
  );
}
