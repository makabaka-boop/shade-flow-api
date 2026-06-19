import { Hono } from 'hono';
import db from '../db.js';
import { STATUS, STATUS_LABELS } from '../constants.js';
import { scanAlerts } from '../utils.js';

const query = new Hono();

const BASE_SHADE_SELECT = `
  SELECT s.id, s.shade_no, s.status, s.inspection_cycle_hours,
         s.paper_batch_id, pb.batch_no AS paper_batch_no,
         s.skeleton_spec_id, ss.spec_code AS skeleton_spec_code, ss.name AS skeleton_spec_name, ss.dimensions AS skeleton_dimensions,
         s.station_id, st.station_code, st.name AS station_name,
         s.responsible_person_id, rp.name AS responsible_person_name, rp.employee_no AS responsible_employee_no,
         s.forming_started_at, s.forming_completed_at, s.skeleton_corrected, s.skeleton_correction_notes,
         s.pasting_started_at, s.pasting_completed_at, s.paste_layers,
         s.drying_started_at, s.drying_completed_at, s.drying_duration_hours,
         s.rework_count,
         i.light_uniformity_grade, i.light_uniformity_score, i.wrinkles_found, i.final_recommendation,
         i.inspected_at AS last_inspected_at,
         s.delivered_at, s.suspended_at,
         s.created_at, s.updated_at
  FROM shades s
  LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id
  LEFT JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
  LEFT JOIN stations st ON st.id = s.station_id
  LEFT JOIN persons rp ON rp.id = s.responsible_person_id
  LEFT JOIN inspections i ON i.id = s.last_inspection_id
`;

query.get('/shades', (c) => {
  const {
    paper_batch_id, skeleton_spec_id, station_id, responsible_person_id,
    status, date_from, date_to, light_grade, keyword,
    page = '1', page_size = '20'
  } = c.req.query();

  const where = [];
  const params = [];

  if (paper_batch_id) { where.push(`s.paper_batch_id = ?`); params.push(Number(paper_batch_id)); }
  if (skeleton_spec_id) { where.push(`s.skeleton_spec_id = ?`); params.push(Number(skeleton_spec_id)); }
  if (station_id) { where.push(`s.station_id = ?`); params.push(Number(station_id)); }
  if (responsible_person_id) { where.push(`s.responsible_person_id = ?`); params.push(Number(responsible_person_id)); }
  if (status) {
    const statuses = status.split(',');
    where.push(`s.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (date_from) { where.push(`s.created_at >= ?`); params.push(date_from); }
  if (date_to) { where.push(`s.created_at <= ?`); params.push(date_to); }
  if (light_grade) {
    const grades = light_grade.split(',');
    where.push(`i.light_uniformity_grade IN (${grades.map(() => '?').join(',')})`);
    params.push(...grades);
  }
  if (keyword) {
    where.push(`(s.shade_no LIKE ? OR pb.batch_no LIKE ? OR rp.name LIKE ?)`);
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size) || 20));
  const offset = (pageNum - 1) * pageSize;

  const totalSql = `SELECT COUNT(*) AS count FROM shades s LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id LEFT JOIN persons rp ON rp.id = s.responsible_person_id LEFT JOIN inspections i ON i.id = s.last_inspection_id ${whereClause}`;
  const total = db.prepare(totalSql).get(...params).count;

  const dataSql = `${BASE_SHADE_SELECT} ${whereClause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataSql).all(...params, pageSize, offset);

  return c.json({
    code: 0,
    data: {
      total, page: pageNum, page_size: pageSize,
      items: rows.map(r => ({ ...r, status_label: STATUS_LABELS[r.status] }))
    }
  });
});

query.get('/stats/anomaly-spec-ranking', (c) => {
  scanAlerts();
  const rows = db.prepare(`
    SELECT
      ss.id AS skeleton_spec_id,
      ss.spec_code,
      ss.name,
      ss.dimensions,
      COUNT(s.id) AS total_shades,
      SUM(CASE WHEN s.status = 'deliverable' THEN 1 ELSE 0 END) AS delivered_count,
      SUM(CASE WHEN s.status = 'suspended' THEN 1 ELSE 0 END) AS suspended_count,
      SUM(CASE WHEN s.rework_count > 0 THEN 1 ELSE 0 END) AS reworked_count,
      AVG(CASE WHEN i.light_uniformity_score IS NOT NULL THEN i.light_uniformity_score END) AS avg_light_score,
      SUM(CASE WHEN i.wrinkles_found = 1 THEN 1 ELSE 0 END) AS wrinkle_count,
      SUM(CASE WHEN i.light_uniformity_grade IN ('C','D') THEN 1 ELSE 0 END) AS low_grade_count,
      SUM(CASE WHEN i.final_recommendation = 'suspend' THEN 1 ELSE 0 END) AS suspend_rec_count,
      ROUND(
        SUM(CASE WHEN i.wrinkles_found = 1 OR i.light_uniformity_grade IN ('C','D') OR i.final_recommendation IN ('rework','suspend') OR s.rework_count > 0 THEN 1 ELSE 0 END) * 100.0
        / NULLIF(COUNT(s.id), 0), 2
      ) AS anomaly_rate
    FROM skeleton_specs ss
    LEFT JOIN shades s ON s.skeleton_spec_id = ss.id
    LEFT JOIN inspections i ON i.id = s.last_inspection_id
    GROUP BY ss.id
    HAVING total_shades > 0
    ORDER BY anomaly_rate DESC, total_shades DESC
  `).all();

  return c.json({ code: 0, data: rows });
});

query.get('/stats/inspection-todo', (c) => {
  scanAlerts();
  const nowTs = Date.now();
  const rows = db.prepare(`
    SELECT
      s.id, s.shade_no, s.status, s.inspection_cycle_hours,
      s.drying_completed_at, s.pasting_completed_at,
      pb.batch_no AS paper_batch_no,
      ss.spec_code AS skeleton_spec_code, ss.name AS skeleton_spec_name,
      st.station_code, st.name AS station_name,
      rp.name AS responsible_person_name,
      i.inspected_at AS last_inspected_at,
      s.rework_count,
      CASE
        WHEN s.drying_completed_at IS NOT NULL THEN
          CAST((? - strftime('%s', replace(s.drying_completed_at, ' ', 'T'))) / 3600 AS INTEGER)
        ELSE 0
      END AS hours_since_drying
    FROM shades s
    LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id
    LEFT JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
    LEFT JOIN stations st ON st.id = s.station_id
    LEFT JOIN persons rp ON rp.id = s.responsible_person_id
    LEFT JOIN inspections i ON i.id = s.last_inspection_id
    WHERE s.status IN (?, ?)
    ORDER BY
      CASE WHEN s.status = 'reworking' THEN 0 ELSE 1 END,
      hours_since_drying DESC
  `).all(nowTs / 1000, STATUS.PENDING_INSPECTION, STATUS.REWORKING);

  return c.json({
    code: 0,
    data: rows.map(r => ({
      ...r,
      status_label: STATUS_LABELS[r.status],
      is_overdue: r.status === STATUS.PENDING_INSPECTION && r.drying_completed_at && r.hours_since_drying > r.inspection_cycle_hours
    }))
  });
});

query.get('/stats/delivery-cycle', (c) => {
  const { date_from, date_to } = c.req.query();
  let sql = `
    SELECT
      s.id, s.shade_no, s.created_at, s.delivered_at, s.rework_count,
      pb.batch_no AS paper_batch_no,
      ss.spec_code AS skeleton_spec_code,
      CAST((julianday(s.delivered_at) - julianday(s.created_at)) * 24 AS REAL) AS cycle_hours
    FROM shades s
    LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id
    LEFT JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
    WHERE s.status = 'deliverable' AND s.delivered_at IS NOT NULL
  `;
  const params = [];
  if (date_from) { sql += ` AND s.delivered_at >= ?`; params.push(date_from); }
  if (date_to) { sql += ` AND s.delivered_at <= ?`; params.push(date_to); }
  sql += ` ORDER BY s.delivered_at DESC`;

  const rows = db.prepare(sql).all(...params);

  const buckets = {
    '0-12h': 0, '12-24h': 0, '24-48h': 0, '48-72h': 0, '72h+': 0
  };
  let total = 0, sumHours = 0, minH = Infinity, maxH = -Infinity, reworkTotal = 0, reworkCycles = 0;

  for (const r of rows) {
    const h = r.cycle_hours || 0;
    sumHours += h; total++;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (r.rework_count > 0) { reworkTotal++; reworkCycles += h; }
    if (h <= 12) buckets['0-12h']++;
    else if (h <= 24) buckets['12-24h']++;
    else if (h <= 48) buckets['24-48h']++;
    else if (h <= 72) buckets['48-72h']++;
    else buckets['72h+']++;
  }

  const distribution = Object.entries(buckets).map(([range, count]) => ({
    range,
    count,
    percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
  }));

  return c.json({
    code: 0,
    data: {
      summary: {
        total_delivered: total,
        avg_cycle_hours: total > 0 ? Number((sumHours / total).toFixed(1)) : 0,
        min_cycle_hours: total > 0 ? Number(minH.toFixed(1)) : 0,
        max_cycle_hours: total > 0 ? Number(maxH.toFixed(1)) : 0,
        rework_shades: reworkTotal,
        avg_cycle_with_rework: reworkTotal > 0 ? Number((reworkCycles / reworkTotal).toFixed(1)) : 0
      },
      distribution,
      items: rows.map(r => ({ ...r, cycle_hours: Number(r.cycle_hours.toFixed(1)) }))
    }
  });
});

query.get('/stats/overview', (c) => {
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM shades GROUP BY status
  `).all();

  const counts = {};
  for (const s of statusCounts) counts[s.status] = s.count;

  const alerts = db.prepare(`SELECT COUNT(*) AS count FROM alerts WHERE resolved = 0`).get().count;
  const delivered24h = db.prepare(`
    SELECT COUNT(*) AS count FROM shades WHERE status = 'deliverable' AND delivered_at >= datetime('now', '-24 hours', 'localtime')
  `).get().count;

  return c.json({
    code: 0,
    data: {
      status_counts: Object.fromEntries(
        Object.keys(STATUS_LABELS).map(k => [k, { label: STATUS_LABELS[k], count: counts[k] || 0 }])
      ),
      unresolved_alerts: alerts,
      delivered_last_24h: delivered24h
    }
  });
});

export default query;
