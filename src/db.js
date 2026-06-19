import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'shade-flow.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT UNIQUE NOT NULL,
      supplier TEXT,
      received_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS skeleton_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      dimensions TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','inspector')),
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS shades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shade_no TEXT UNIQUE NOT NULL,
      paper_batch_id INTEGER NOT NULL REFERENCES paper_batches(id),
      skeleton_spec_id INTEGER NOT NULL REFERENCES skeleton_specs(id),
      station_id INTEGER NOT NULL REFERENCES stations(id),
      responsible_person_id INTEGER NOT NULL REFERENCES persons(id),
      inspection_cycle_hours INTEGER DEFAULT 24,
      status TEXT NOT NULL DEFAULT 'pending_forming',
      active_process_token TEXT,

      forming_started_at TEXT,
      forming_completed_at TEXT,
      forming_operator_id INTEGER REFERENCES persons(id),
      skeleton_correction_notes TEXT,
      skeleton_corrected INTEGER DEFAULT 0,

      pasting_started_at TEXT,
      pasting_completed_at TEXT,
      pasting_operator_id INTEGER REFERENCES persons(id),
      paste_layers INTEGER,
      paste_notes TEXT,

      drying_started_at TEXT,
      drying_completed_at TEXT,
      drying_operator_id INTEGER REFERENCES persons(id),
      drying_duration_hours REAL,

      last_inspection_id INTEGER REFERENCES inspections(id),
      rework_count INTEGER DEFAULT 0,
      next_inspection_is_rework INTEGER DEFAULT 0,

      delivered_at TEXT,
      suspended_at TEXT,
      suspend_reason TEXT,

      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shade_id INTEGER NOT NULL REFERENCES shades(id),
      inspector_id INTEGER NOT NULL REFERENCES persons(id),
      inspected_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      is_rework_inspection INTEGER DEFAULT 0,
      rework_count INTEGER DEFAULT 0,

      wrinkle_description TEXT,
      wrinkles_found INTEGER DEFAULT 0,
      light_uniformity_grade TEXT NOT NULL CHECK(light_uniformity_grade IN ('A','B','C','D')),
      light_uniformity_score REAL,

      rework_action TEXT,
      final_recommendation TEXT NOT NULL CHECK(final_recommendation IN ('deliver','rework','suspend')),
      conclusion TEXT,

      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shade_id INTEGER NOT NULL REFERENCES shades(id),
      operator_id INTEGER REFERENCES persons(id),
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      related_id INTEGER,
      related_type TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_shades_status ON shades(status);
    CREATE INDEX IF NOT EXISTS idx_shades_batch ON shades(paper_batch_id);
    CREATE INDEX IF NOT EXISTS idx_shades_spec ON shades(skeleton_spec_id);
    CREATE INDEX IF NOT EXISTS idx_shades_station ON shades(station_id);
    CREATE INDEX IF NOT EXISTS idx_shades_person ON shades(responsible_person_id);
    CREATE INDEX IF NOT EXISTS idx_shades_created ON shades(created_at);
    CREATE INDEX IF NOT EXISTS idx_inspections_shade ON inspections(shade_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
    CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved);
    CREATE INDEX IF NOT EXISTS idx_op_logs_shade ON operation_logs(shade_id);
  `);

  const addColumnIfMissing = (table, column, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  };
  addColumnIfMissing('shades', 'next_inspection_is_rework', 'INTEGER DEFAULT 0');
}

init();

export default db;
