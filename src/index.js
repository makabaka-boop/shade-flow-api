import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import db from './db.js';
import { STATUS, STATUS_LABELS, LIGHT_GRADES, LIGHT_GRADE_LABELS, ALERT_TYPES, ALERT_TYPE_LABELS } from './constants.js';
import basic from './routes/basic.js';
import admin from './routes/admin.js';
import process_ from './routes/process.js';
import query from './routes/query.js';
import alertsRoutes from './routes/alerts.js';
import { scanAlerts, now } from './utils.js';

const PORT = 8118;

const app = new Hono();

app.use('*', cors());

app.get('/', (c) => {
  return c.json({
    service: 'shade-flow-api',
    version: '1.0.0',
    description: '纸艺灯罩工艺管理系统',
    status_values: STATUS_LABELS,
    light_grades: LIGHT_GRADE_LABELS,
    alert_types: ALERT_TYPE_LABELS,
    endpoints: {
      basic_data: '/api/paper-batches, /api/skeleton-specs, /api/stations, /api/persons',
      shades_crud: 'POST/GET/PUT /api/admin/shades, POST /api/admin/shades/:id/suspend, /resume',
      process: [
        'POST /api/process/shades/:id/start-forming',
        'POST /api/process/shades/:id/forming-complete',
        'POST /api/process/shades/:id/start-pasting',
        'POST /api/process/shades/:id/pasting-complete',
        'POST /api/process/shades/:id/start-drying',
        'POST /api/process/shades/:id/drying-complete',
        'POST /api/process/shades/:id/inspections',
        'POST /api/process/shades/:id/start-rework',
        'POST /api/process/shades/:id/rework-complete',
        'GET  /api/process/shades/:id/inspections',
        'GET  /api/process/shades/:id/logs',
      ],
      query: [
        'GET /api/query/shades (组合检索)',
        'GET /api/query/stats/overview',
        'GET /api/query/stats/anomaly-spec-ranking (异常规格排行)',
        'GET /api/query/stats/inspection-todo (巡检待办)',
        'GET /api/query/stats/delivery-cycle (交付周期分布)',
      ],
      alerts: [
        'GET    /api/alerts',
        'POST   /api/alerts/scan',
        'POST   /api/alerts/:id/resolve',
        'GET    /api/alerts/summary',
      ],
      seed: 'POST /api/seed'
    }
  });
});

app.route('/api', basic);
app.route('/api/admin', admin);
app.route('/api/process', process_);
app.route('/api/query', query);
app.route('/api/alerts', alertsRoutes);

app.post('/api/seed', (c) => {
  const exist = db.prepare(`SELECT COUNT(*) AS c FROM persons`).get().c;
  if (exist > 0) return c.json({ code: 0, message: '数据已存在，跳过种子', skipped: true });

  const insertPerson = db.prepare(`INSERT INTO persons (employee_no, name, role) VALUES (?, ?, ?)`);
  const insertBatch = db.prepare(`INSERT INTO paper_batches (batch_no, supplier, received_date, notes) VALUES (?, ?, ?, ?)`);
  const insertSpec = db.prepare(`INSERT INTO skeleton_specs (spec_code, name, dimensions, description) VALUES (?, ?, ?, ?)`);
  const insertStation = db.prepare(`INSERT INTO stations (station_code, name, location) VALUES (?, ?, ?)`);

  const persons = [
    ['A001', '张伟', 'admin'],
    ['O101', '李工艺', 'operator'],
    ['O102', '王师傅', 'operator'],
    ['I201', '赵巡检', 'inspector'],
    ['I202', '陈质检', 'inspector'],
  ];
  const pids = {};
  for (const [eno, name, role] of persons) {
    const r = insertPerson.run(eno, name, role);
    pids[eno] = r.lastInsertRowid;
  }

  const batch1 = insertBatch.run('P2025-001', '青山纸业', '2025-06-01', '常规宣纸').lastInsertRowid;
  const batch2 = insertBatch.run('P2025-002', '云宣堂', '2025-06-10', '加厚云龙纸').lastInsertRowid;
  const batch3 = insertBatch.run('P2025-003', '古韵斋', '2025-06-15', '试用桑皮纸').lastInsertRowid;

  const spec1 = insertSpec.run('SK-S-30', '小半圆灯罩', 'Φ30cm × H25cm', '桌面小款').lastInsertRowid;
  const spec2 = insertSpec.run('SK-M-40', '中号圆筒', 'Φ40cm × H50cm', '客厅落地款').lastInsertRowid;
  const spec3 = insertSpec.run('SK-L-50', '大号宫灯', 'Φ50cm × H60cm', '大堂宫灯造型').lastInsertRowid;

  const st1 = insertStation.run('T-01', '一号台', 'A车间').lastInsertRowid;
  const st2 = insertStation.run('T-02', '二号台', 'A车间').lastInsertRowid;
  const st3 = insertStation.run('T-03', '三号台', 'B车间').lastInsertRowid;

  const insertShade = db.prepare(`
    INSERT INTO shades (shade_no, paper_batch_id, skeleton_spec_id, station_id, responsible_person_id, inspection_cycle_hours, status)
    VALUES (?, ?, ?, ?, ?, 24, ?)
  `);
  const shades = [
    ['LMP-0001', batch1, spec1, st1, pids['O101'], STATUS.PENDING_FORMING],
    ['LMP-0002', batch1, spec2, st2, pids['O102'], STATUS.FORMING],
    ['LMP-0003', batch2, spec1, st1, pids['O101'], STATUS.PASTING],
    ['LMP-0004', batch2, spec3, st3, pids['O102'], STATUS.DRYING],
    ['LMP-0005', batch3, spec2, st2, pids['O101'], STATUS.PENDING_INSPECTION],
    ['LMP-0006', batch1, spec1, st1, pids['O102'], STATUS.DELIVERABLE],
  ];

  const shadeIds = [];
  for (const s of shades) {
    shadeIds.push(insertShade.run(...s).lastInsertRowid);
  }

  return c.json({
    code: 0,
    message: '种子数据已创建',
    data: { persons: pids, batches: [batch1, batch2, batch3], specs: [spec1, spec2, spec3], stations: [st1, st2, st3], shades: shadeIds }
  });
});

app.onError((err, c) => {
  console.error('[ERROR]', err);
  return c.json({ code: 1, message: err.message || 'Internal Server Error' }, 500);
});

scanAlerts();
setInterval(() => { scanAlerts(); }, 10 * 60 * 1000);

console.log(`shade-flow-api starting on port ${PORT}...`);
serve({ fetch: app.fetch, port: PORT });
console.log(`Server running at http://localhost:${PORT}`);

export default app;
