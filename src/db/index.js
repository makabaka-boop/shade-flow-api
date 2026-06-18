import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { SCHEMA_SQL } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'shade-flow.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');
db.exec(SCHEMA_SQL);

export default db;

export function now() {
  return db.prepare("SELECT datetime('now','localtime') AS t").get().t;
}

export function beginTransaction() {
  return db.transaction((fn) => fn());
}
