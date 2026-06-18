import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { initSchema } from './db.js';
import admin from './routes/admin.js';
import shades from './routes/shades.js';
import analytics from './routes/analytics.js';

initSchema();

const app = new Hono();

app.get('/', (c) =>
  c.json({
    service: 'shade-flow-api',
    description: '纸艺灯罩工艺管理系统',
    endpoints: [
      'GET    /health',
      'CRUD   /admin/paper-batches',
      'CRUD   /admin/frame-specs',
      'CRUD   /admin/stations',
      'CRUD   /admin/workers',
      'POST   /shades',
      'GET    /shades?paper_batch_id=&frame_spec_id=&station_id=&owner_id=&state=&light_grade=&start_date=&end_date=',
      'GET    /shades/:id',
      'PUT    /shades/:id',
      'POST   /shades/:id/start-flow',
      'POST   /shades/:id/forming',
      'POST   /shades/:id/lamination',
      'POST   /shades/:id/inspection',
      'POST   /shades/:id/pause',
      'POST   /shades/:id/resume',
      'GET    /analytics/wrinkle-batches',
      'GET    /analytics/overdue-inspections',
      'GET    /analytics/rework-pending-conclusion',
      'GET    /analytics/spec-anomaly-ranking',
      'GET    /analytics/inspection-todos',
      'GET    /analytics/delivery-cycle-distribution',
      'GET    /analytics/summary',
    ],
  }),
);

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route('/admin', admin);
app.route('/shades', shades);
app.route('/analytics', analytics);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const port = 8118;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`shade-flow-api listening on http://localhost:${info.port}`);
});
