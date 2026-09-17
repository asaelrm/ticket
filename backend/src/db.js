import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

export function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(schema);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const { user_version } = db.prepare('PRAGMA user_version').get();
  return user_version;
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export default db;