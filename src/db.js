import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data/shade-flow.db');

import fs from 'node:fs';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const STATES = {
  PENDING_FORM: '待成型',
  FORMING: '成型中',
  PENDING_INSPECT: '待巡检',
  REWORK: '返修中',
  DELIVERABLE: '可交付',
  PAUSED: '暂停展示',
};

export const ACTIVE_STATES = [
  STATES.PENDING_FORM,
  STATES.FORMING,
  STATES.PENDING_INSPECT,
  STATES.REWORK,
];

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT UNIQUE NOT NULL,
      material TEXT,
      supplier TEXT,
      arrived_at TEXT,
      remark TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS frame_spec (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_code TEXT UNIQUE NOT NULL,
      shape TEXT,
      diameter_mm INTEGER,
      height_mm INTEGER,
      wire_gauge TEXT,
      remark TEXT
    );

    CREATE TABLE IF NOT EXISTS station (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT,
      location TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS worker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      phone TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS shade (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shade_no TEXT UNIQUE NOT NULL,
      frame_spec_id INTEGER,
      paper_batch_id INTEGER,
      station_id INTEGER,
      owner_id INTEGER,
      inspect_cycle_hours INTEGER DEFAULT 24,
      current_state TEXT DEFAULT '待成型',
      light_grade TEXT,
      remark TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (frame_spec_id) REFERENCES frame_spec(id),
      FOREIGN KEY (paper_batch_id) REFERENCES paper_batch(id),
      FOREIGN KEY (station_id) REFERENCES station(id),
      FOREIGN KEY (owner_id) REFERENCES worker(id)
    );

    CREATE TABLE IF NOT EXISTS process_flow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shade_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      delivered_at TEXT,
      final_recommendation TEXT,
      FOREIGN KEY (shade_id) REFERENCES shade(id)
    );

    CREATE TABLE IF NOT EXISTS forming_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      shade_id INTEGER NOT NULL,
      worker_id INTEGER,
      frame_correction TEXT,
      corrected_at TEXT DEFAULT (datetime('now')),
      remark TEXT,
      FOREIGN KEY (flow_id) REFERENCES process_flow(id),
      FOREIGN KEY (shade_id) REFERENCES shade(id)
    );

    CREATE TABLE IF NOT EXISTS lamination_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      shade_id INTEGER NOT NULL,
      worker_id INTEGER,
      layers INTEGER NOT NULL,
      drying_hours REAL,
      wrinkle_note TEXT,
      wrinkle_severity INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (flow_id) REFERENCES process_flow(id),
      FOREIGN KEY (shade_id) REFERENCES shade(id)
    );

    CREATE TABLE IF NOT EXISTS inspection_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      shade_id INTEGER NOT NULL,
      worker_id INTEGER,
      light_uniformity TEXT,
      light_grade TEXT,
      rework_action TEXT,
      conclusion TEXT,
      inspected_at TEXT DEFAULT (datetime('now')),
      next_due_at TEXT,
      FOREIGN KEY (flow_id) REFERENCES process_flow(id),
      FOREIGN KEY (shade_id) REFERENCES shade(id)
    );

    CREATE INDEX IF NOT EXISTS idx_flow_shade_active ON process_flow(shade_id, active);
    CREATE INDEX IF NOT EXISTS idx_shade_state ON shade(current_state);
    CREATE INDEX IF NOT EXISTS idx_lamination_shade ON lamination_record(shade_id);
    CREATE INDEX IF NOT EXISTS idx_inspection_shade ON inspection_record(shade_id);
  `);
}
