import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '..', 'data', 'shade-flow.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initSQL = `
CREATE TABLE IF NOT EXISTS paper_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_code TEXT NOT NULL UNIQUE,
  supplier TEXT,
  paper_type TEXT,
  gram_weight REAL,
  received_date TEXT NOT NULL,
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS skeleton_specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  diameter REAL,
  height REAL,
  rib_count INTEGER,
  material TEXT,
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS workstations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS lampshades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shade_code TEXT NOT NULL UNIQUE,
  paper_batch_id INTEGER REFERENCES paper_batches(id),
  skeleton_spec_id INTEGER REFERENCES skeleton_specs(id),
  workstation_id INTEGER REFERENCES workstations(id),
  responsible_id INTEGER REFERENCES operators(id),
  inspection_cycle_hours INTEGER DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'pending_forming',
  current_flow_id INTEGER,
  started_at TEXT,
  delivered_at TEXT,
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS process_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shade_id INTEGER NOT NULL REFERENCES lampshades(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  ended_at TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS forming_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES process_flows(id),
  operator_id INTEGER REFERENCES operators(id),
  correction_notes TEXT,
  correction_applied INTEGER DEFAULT 0,
  formed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS mounting_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES process_flows(id),
  operator_id INTEGER REFERENCES operators(id),
  layer_count INTEGER NOT NULL,
  wrinkle_notes TEXT,
  has_wrinkle INTEGER DEFAULT 0,
  mounted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS drying_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES process_flows(id),
  operator_id INTEGER REFERENCES operators(id),
  duration_hours REAL NOT NULL,
  temperature REAL,
  humidity REAL,
  dried_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS inspection_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES process_flows(id),
  operator_id INTEGER REFERENCES operators(id),
  light_uniformity INTEGER NOT NULL,
  wrinkle_severity INTEGER DEFAULT 0,
  conclusion TEXT NOT NULL,
  rework_action TEXT,
  final_recommendation TEXT,
  inspector_note TEXT,
  inspected_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  next_inspection_at TEXT
);

CREATE TABLE IF NOT EXISTS rework_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES process_flows(id),
  operator_id INTEGER REFERENCES operators(id),
  rework_type TEXT NOT NULL,
  action_detail TEXT NOT NULL,
  result TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_lampshades_status ON lampshades(status);
CREATE INDEX IF NOT EXISTS idx_lampshades_paper_batch ON lampshades(paper_batch_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_spec ON lampshades(skeleton_spec_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_workstation ON lampshades(workstation_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_responsible ON lampshades(responsible_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_started ON lampshades(started_at);
CREATE INDEX IF NOT EXISTS idx_flows_shade ON process_flows(shade_id);
CREATE INDEX IF NOT EXISTS idx_flows_active ON process_flows(is_active);
CREATE INDEX IF NOT EXISTS idx_mounting_wrinkle ON mounting_records(has_wrinkle);
CREATE INDEX IF NOT EXISTS idx_inspection_next ON inspection_records(next_inspection_at);
`;

db.exec(initSQL);

const columns = db.prepare("PRAGMA table_info(lampshades)").all();
if (!columns.find(c => c.name === 'pre_suspend_status')) {
  db.exec('ALTER TABLE lampshades ADD COLUMN pre_suspend_status TEXT');
}

export default db;
