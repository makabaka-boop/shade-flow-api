export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS paper_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  supplier TEXT,
  received_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS skeleton_specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  diameter_cm REAL,
  height_cm REAL,
  material TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','technician','both')),
  phone TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspection_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL,
  cycle_hours INTEGER NOT NULL DEFAULT 24,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (spec_id) REFERENCES skeleton_specs(id),
  UNIQUE(spec_id)
);

CREATE TABLE IF NOT EXISTS lampshades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shade_no TEXT NOT NULL UNIQUE,
  batch_id INTEGER NOT NULL,
  spec_id INTEGER NOT NULL,
  station_id INTEGER NOT NULL,
  responsible_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_forming' CHECK(status IN (
    'pending_forming','forming','pending_inspection','in_repair','deliverable','paused'
  )),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  delivered_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES paper_batches(id),
  FOREIGN KEY (spec_id) REFERENCES skeleton_specs(id),
  FOREIGN KEY (station_id) REFERENCES stations(id),
  FOREIGN KEY (responsible_id) REFERENCES workers(id)
);

CREATE TABLE IF NOT EXISTS process_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shade_id INTEGER NOT NULL,
  process_type TEXT NOT NULL CHECK(process_type IN (
    'forming','pasting','drying','inspection','repair'
  )),
  start_time TEXT,
  end_time TEXT,
  technician_id INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (shade_id) REFERENCES lampshades(id),
  FOREIGN KEY (technician_id) REFERENCES workers(id)
);

CREATE TABLE IF NOT EXISTS forming_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL UNIQUE,
  skeleton_correction TEXT,
  correction_notes TEXT,
  FOREIGN KEY (process_id) REFERENCES process_records(id)
);

CREATE TABLE IF NOT EXISTS pasting_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL UNIQUE,
  layer_count INTEGER NOT NULL DEFAULT 1,
  wrinkle_description TEXT,
  wrinkle_severity TEXT CHECK(wrinkle_severity IN ('none','minor','moderate','severe')),
  FOREIGN KEY (process_id) REFERENCES process_records(id)
);

CREATE TABLE IF NOT EXISTS drying_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL UNIQUE,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  temp_celsius REAL,
  humidity_percent REAL,
  FOREIGN KEY (process_id) REFERENCES process_records(id)
);

CREATE TABLE IF NOT EXISTS inspection_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL UNIQUE,
  light_uniformity_grade TEXT NOT NULL CHECK(light_uniformity_grade IN ('A','B','C','D')),
  wrinkle_severity TEXT CHECK(wrinkle_severity IN ('none','minor','moderate','severe')),
  conclusion TEXT NOT NULL CHECK(conclusion IN ('deliverable','repair','pause')),
  inspector_id INTEGER,
  inspection_time TEXT,
  next_inspection_at TEXT,
  final_recommendation TEXT,
  FOREIGN KEY (process_id) REFERENCES process_records(id),
  FOREIGN KEY (inspector_id) REFERENCES workers(id)
);

CREATE TABLE IF NOT EXISTS repair_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL UNIQUE,
  repair_action TEXT NOT NULL,
  result_notes TEXT,
  conclusion_submitted INTEGER DEFAULT 0,
  repaired_by INTEGER,
  repaired_at TEXT,
  FOREIGN KEY (process_id) REFERENCES process_records(id),
  FOREIGN KEY (repaired_by) REFERENCES workers(id)
);

CREATE INDEX IF NOT EXISTS idx_lampshades_status ON lampshades(status);
CREATE INDEX IF NOT EXISTS idx_lampshades_batch ON lampshades(batch_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_spec ON lampshades(spec_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_station ON lampshades(station_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_responsible ON lampshades(responsible_id);
CREATE INDEX IF NOT EXISTS idx_lampshades_created ON lampshades(created_at);
CREATE INDEX IF NOT EXISTS idx_process_shade ON process_records(shade_id);
CREATE INDEX IF NOT EXISTS idx_process_type ON process_records(process_type);
CREATE INDEX IF NOT EXISTS idx_pasting_wrinkle ON pasting_details(wrinkle_severity);
CREATE INDEX IF NOT EXISTS idx_inspection_grade ON inspection_details(light_uniformity_grade);
`;

export const STATUS_LABELS = {
  pending_forming: '待成型',
  forming: '成型中',
  pending_inspection: '待巡检',
  in_repair: '返修中',
  deliverable: '可交付',
  paused: '暂停展示'
};

export const GRADE_LABELS = { A: '优', B: '良', C: '中', D: '差' };
export const WRINKLE_LABELS = { none: '无', minor: '轻微', moderate: '中度', severe: '严重' };
