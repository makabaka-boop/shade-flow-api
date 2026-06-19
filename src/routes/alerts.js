import { Hono } from 'hono';
import db from '../db.js';
import { ALERT_TYPES, ALERT_TYPE_LABELS } from '../constants.js';
import { scanAlerts, now, validatePerson } from '../utils.js';

const alerts = new Hono();

function requireStaff(operatorId) {
  return validatePerson(operatorId, ['admin', 'inspector', 'operator'], 'operator_id');
}

alerts.get('/', (c) => {
  const { resolved, alert_type, severity, page = '1', page_size = '20' } = c.req.query();
  const where = [];
  const params = [];

  if (resolved !== undefined) { where.push(`a.resolved = ?`); params.push(Number(resolved)); }
  if (alert_type) { where.push(`a.alert_type = ?`); params.push(alert_type); }
  if (severity) { where.push(`a.severity = ?`); params.push(severity); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size) || 20));
  const offset = (pageNum - 1) * pageSize;

  scanAlerts();

  const total = db.prepare(`SELECT COUNT(*) AS count FROM alerts a ${whereClause}`).get(...params).count;

  const items = db.prepare(`
    SELECT a.*,
      CASE a.related_type
        WHEN 'shade' THEN (SELECT shade_no FROM shades WHERE id = a.related_id)
        WHEN 'batch' THEN (SELECT batch_no FROM paper_batches WHERE id = a.related_id)
        WHEN 'spec' THEN (SELECT spec_code FROM skeleton_specs WHERE id = a.related_id)
      END AS related_no,
      CASE a.related_type
        WHEN 'spec' THEN (SELECT name FROM skeleton_specs WHERE id = a.related_id)
      END AS related_name
    FROM alerts a
    ${whereClause}
    ORDER BY a.resolved ASC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return c.json({
    code: 0,
    data: {
      total, page: pageNum, page_size: pageSize,
      items: items.map(a => ({ ...a, alert_type_label: ALERT_TYPE_LABELS[a.alert_type] || a.alert_type }))
    }
  });
});

alerts.post('/scan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const auth = requireStaff(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const created = scanAlerts();
  return c.json({ code: 0, data: { created_count: created.length, created } });
});

alerts.post('/:id/resolve', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const auth = requireStaff(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const a = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id);
  if (!a) return c.json({ code: 1, message: '告警不存在' }, 404);
  if (a.resolved) return c.json({ code: 1, message: '告警已处理' }, 400);

  db.prepare(`UPDATE alerts SET resolved = 1, resolved_at = ? WHERE id = ?`).run(now(), id);
  return c.json({ code: 0, data: db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) });
});

alerts.get('/summary', (c) => {
  scanAlerts();
  const rows = db.prepare(`
    SELECT alert_type, severity, COUNT(*) AS count
    FROM alerts WHERE resolved = 0
    GROUP BY alert_type, severity
    ORDER BY count DESC
  `).all();

  const byType = {};
  for (const key of Object.keys(ALERT_TYPE_LABELS)) {
    byType[key] = { label: ALERT_TYPE_LABELS[key], total: 0, by_severity: {} };
  }
  let total = 0;
  for (const r of rows) {
    if (!byType[r.alert_type]) byType[r.alert_type] = { label: r.alert_type, total: 0, by_severity: {} };
    byType[r.alert_type].total += r.count;
    byType[r.alert_type].by_severity[r.severity] = r.count;
    total += r.count;
  }
  return c.json({ code: 0, data: { total, by_type: byType } });
});

export default alerts;
