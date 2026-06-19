import { Hono } from 'hono';
import db from '../db/index.js';

const query = new Hono();

query.get('/search', (c) => {
  const {
    paper_batch_id, skeleton_spec_id, workstation_id, responsible_id,
    status, start_date, end_date, light_uniformity_min, light_uniformity_max,
    page = 1, page_size = 20
  } = c.req.query();

  let where = [];
  let params = [];

  if (paper_batch_id) { where.push('l.paper_batch_id = ?'); params.push(paper_batch_id); }
  if (skeleton_spec_id) { where.push('l.skeleton_spec_id = ?'); params.push(skeleton_spec_id); }
  if (workstation_id) { where.push('l.workstation_id = ?'); params.push(workstation_id); }
  if (responsible_id) { where.push('l.responsible_id = ?'); params.push(responsible_id); }
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (start_date) { where.push('date(l.started_at) >= date(?)'); params.push(start_date); }
  if (end_date) { where.push('date(l.started_at) <= date(?)'); params.push(end_date); }

  const latestInspJoin = `
    LEFT JOIN (
      SELECT pf.shade_id, ir.light_uniformity, ir.conclusion
      FROM inspection_records ir
      JOIN process_flows pf ON ir.flow_id = pf.id
      WHERE ir.conclusion != 'pending'
      AND ir.inspected_at = (
        SELECT MAX(ir2.inspected_at) FROM inspection_records ir2
        JOIN process_flows pf2 ON ir2.flow_id = pf2.id
        WHERE pf2.shade_id = pf.shade_id AND ir2.conclusion != 'pending'
      )
    ) last_insp ON last_insp.shade_id = l.id
  `;

  if (light_uniformity_min) { where.push('last_insp.light_uniformity >= ?'); params.push(light_uniformity_min); }
  if (light_uniformity_max) { where.push('last_insp.light_uniformity <= ?'); params.push(light_uniformity_max); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (parseInt(page) - 1) * parseInt(page_size);

  const countSql = `SELECT COUNT(*) as total FROM lampshades l ${latestInspJoin} ${whereClause}`;
  const total = db.prepare(countSql).get(...params).total;

  const listSql = `
    SELECT l.*, 
      pb.batch_code as paper_batch_code,
      ss.spec_code as skeleton_spec_code,
      ss.name as skeleton_spec_name,
      ws.station_code as workstation_code,
      ws.name as workstation_name,
      op.name as responsible_name,
      op.employee_no as responsible_no,
      last_insp.light_uniformity as last_light_uniformity,
      last_insp.conclusion as last_conclusion,
      (SELECT ROUND(AVG(ir.light_uniformity), 1) FROM inspection_records ir 
       JOIN process_flows pf ON ir.flow_id = pf.id 
       WHERE pf.shade_id = l.id AND ir.conclusion != 'pending') as avg_light_uniformity
    FROM lampshades l
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN workstations ws ON l.workstation_id = ws.id
    LEFT JOIN operators op ON l.responsible_id = op.id
    ${latestInspJoin}
    ${whereClause}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const list = db.prepare(listSql).all(...params, parseInt(page_size), offset);

  return c.json({
    code: 0,
    data: { list, total, page: parseInt(page), page_size: parseInt(page_size) }
  });
});

query.get('/alerts/overdue-inspection', (c) => {
  const rows = db.prepare(`
    SELECT l.id as shade_id, l.shade_code, l.status, l.inspection_cycle_hours,
      ir.id as inspection_id, ir.inspected_at, ir.next_inspection_at,
      op.name as responsible_name,
      ss.spec_code as skeleton_spec_code,
      pb.batch_code as paper_batch_code,
      CAST((julianday('now', 'localtime') - julianday(ir.next_inspection_at)) * 24 AS INTEGER) as overdue_hours
    FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    JOIN inspection_records ir ON ir.flow_id = pf.id AND ir.conclusion = 'pending'
    LEFT JOIN operators op ON l.responsible_id = op.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    WHERE ir.next_inspection_at < datetime('now', 'localtime')
    ORDER BY ir.next_inspection_at ASC
  `).all();
  return c.json({ code: 0, data: rows });
});

query.get('/alerts/high-wrinkle-batches', (c) => {
  const threshold = parseFloat(c.req.query('threshold') || '0.3');
  const rows = db.prepare(`
    SELECT pb.id as batch_id, pb.batch_code, pb.supplier, pb.paper_type,
      COUNT(DISTINCT l.id) as total_shades,
      SUM(CASE WHEN mr.has_wrinkle = 1 THEN 1 ELSE 0 END) as wrinkle_count,
      ROUND(
        CAST(SUM(CASE WHEN mr.has_wrinkle = 1 THEN 1 ELSE 0 END) AS REAL) / 
        NULLIF(COUNT(DISTINCT l.id), 0), 3
      ) as wrinkle_rate
    FROM paper_batches pb
    JOIN lampshades l ON l.paper_batch_id = pb.id
    JOIN process_flows pf ON pf.shade_id = l.id
    JOIN mounting_records mr ON mr.flow_id = pf.id
    GROUP BY pb.id
    HAVING wrinkle_rate >= ?
    ORDER BY wrinkle_rate DESC
  `).all(threshold);
  return c.json({ code: 0, data: rows });
});

query.get('/alerts/rework-pending-conclusion', (c) => {
  const rows = db.prepare(`
    SELECT l.id as shade_id, l.shade_code, l.status,
      rr.id as rework_id, rr.rework_type, rr.action_detail, rr.created_at as rework_created_at,
      op.name as operator_name,
      ss.spec_code as skeleton_spec_code,
      CAST((julianday('now', 'localtime') - julianday(rr.created_at)) * 24 AS INTEGER) as pending_hours
    FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    JOIN rework_records rr ON rr.flow_id = pf.id AND rr.completed = 1
    LEFT JOIN operators op ON rr.operator_id = op.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    WHERE NOT EXISTS (
      SELECT 1 FROM inspection_records ir 
      WHERE ir.flow_id = pf.id AND ir.conclusion != 'pending' 
      AND ir.inspected_at > rr.completed_at
    ) AND l.status = 'pending_inspection'
    ORDER BY rr.completed_at ASC
  `).all();
  return c.json({ code: 0, data: rows });
});

query.get('/alerts/spec-anomalies', (c) => {
  const threshold = parseFloat(c.req.query('threshold') || '0.25');
  const rows = db.prepare(`
    SELECT ss.id as spec_id, ss.spec_code, ss.name,
      COUNT(DISTINCT l.id) as total_shades,
      SUM(CASE WHEN ir.conclusion IN ('rework', 'reject') THEN 1 ELSE 0 END) as anomaly_count,
      ROUND(
        CAST(SUM(CASE WHEN ir.conclusion IN ('rework', 'reject') THEN 1 ELSE 0 END) AS REAL) / 
        NULLIF(COUNT(DISTINCT l.id), 0), 3
      ) as anomaly_rate
    FROM skeleton_specs ss
    JOIN lampshades l ON l.skeleton_spec_id = ss.id
    JOIN process_flows pf ON pf.shade_id = l.id
    JOIN inspection_records ir ON ir.flow_id = pf.id AND ir.conclusion != 'pending'
    GROUP BY ss.id
    HAVING anomaly_rate >= ?
    ORDER BY anomaly_rate DESC
  `).all(threshold);
  return c.json({ code: 0, data: rows });
});

query.get('/stats/spec-ranking', (c) => {
  const rows = db.prepare(`
    SELECT ss.id as spec_id, ss.spec_code, ss.name,
      COUNT(DISTINCT l.id) as total_shades,
      SUM(CASE WHEN ir.conclusion = 'pass' THEN 1 ELSE 0 END) as pass_count,
      SUM(CASE WHEN ir.conclusion = 'rework' THEN 1 ELSE 0 END) as rework_count,
      SUM(CASE WHEN ir.conclusion = 'reject' THEN 1 ELSE 0 END) as reject_count,
      ROUND(AVG(CASE WHEN ir.conclusion != 'pending' THEN ir.light_uniformity END), 2) as avg_light_uniformity,
      ROUND(
        CAST(SUM(CASE WHEN mr.has_wrinkle = 1 THEN 1 ELSE 0 END) AS REAL) / 
        NULLIF(COUNT(DISTINCT mr.id), 0), 3
      ) as wrinkle_rate
    FROM skeleton_specs ss
    LEFT JOIN lampshades l ON l.skeleton_spec_id = ss.id
    LEFT JOIN process_flows pf ON pf.shade_id = l.id
    LEFT JOIN inspection_records ir ON ir.flow_id = pf.id
    LEFT JOIN mounting_records mr ON mr.flow_id = pf.id
    GROUP BY ss.id
    ORDER BY total_shades DESC
  `).all();
  return c.json({ code: 0, data: rows });
});

query.get('/stats/inspection-todo', (c) => {
  const rows = db.prepare(`
    SELECT l.id as shade_id, l.shade_code, l.status,
      ir.id as inspection_id, ir.next_inspection_at,
      l.inspection_cycle_hours,
      op.name as responsible_name,
      ss.spec_code as skeleton_spec_code,
      pb.batch_code as paper_batch_code,
      ws.station_code as workstation_code,
      CASE 
        WHEN ir.next_inspection_at < datetime('now', 'localtime') THEN 'overdue'
        WHEN ir.next_inspection_at < datetime('now', 'localtime', '+2 hours') THEN 'urgent'
        ELSE 'normal'
      END as priority,
      CAST(MAX(0, (julianday(ir.next_inspection_at) - julianday('now', 'localtime')) * 24) AS INTEGER) as hours_remaining
    FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    JOIN inspection_records ir ON ir.flow_id = pf.id AND ir.conclusion = 'pending'
    LEFT JOIN operators op ON l.responsible_id = op.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    LEFT JOIN workstations ws ON l.workstation_id = ws.id
    ORDER BY 
      CASE WHEN ir.next_inspection_at < datetime('now', 'localtime') THEN 0 ELSE 1 END,
      ir.next_inspection_at ASC
  `).all();
  return c.json({ code: 0, data: rows });
});

query.get('/stats/delivery-cycle', (c) => {
  const { start_date, end_date, spec_id } = c.req.query();
  let where = [`l.delivered_at IS NOT NULL`, `l.started_at IS NOT NULL`];
  let params = [];
  if (start_date) { where.push('date(l.started_at) >= date(?)'); params.push(start_date); }
  if (end_date) { where.push('date(l.started_at) <= date(?)'); params.push(end_date); }
  if (spec_id) { where.push('l.skeleton_spec_id = ?'); params.push(spec_id); }

  const rows = db.prepare(`
    SELECT 
      l.id as shade_id, l.shade_code, l.started_at, l.delivered_at,
      ss.spec_code,
      CAST((julianday(l.delivered_at) - julianday(l.started_at)) * 24 AS REAL) as cycle_hours,
      CASE
        WHEN (julianday(l.delivered_at) - julianday(l.started_at)) * 24 <= 24 THEN '0-24h'
        WHEN (julianday(l.delivered_at) - julianday(l.started_at)) * 24 <= 48 THEN '24-48h'
        WHEN (julianday(l.delivered_at) - julianday(l.started_at)) * 24 <= 72 THEN '48-72h'
        WHEN (julianday(l.delivered_at) - julianday(l.started_at)) * 24 <= 168 THEN '3-7d'
        ELSE '>7d'
      END as cycle_range
    FROM lampshades l
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.delivered_at DESC
  `).all(...params);

  const distribution = {
    '0-24h': 0, '24-48h': 0, '48-72h': 0, '3-7d': 0, '>7d': 0
  };
  let totalHours = 0;
  rows.forEach(r => {
    distribution[r.cycle_range]++;
    totalHours += r.cycle_hours;
  });

  return c.json({
    code: 0,
    data: {
      list: rows,
      distribution,
      summary: {
        total: rows.length,
        avg_cycle_hours: rows.length ? parseFloat((totalHours / rows.length).toFixed(1)) : 0,
        min_cycle_hours: rows.length ? parseFloat(Math.min(...rows.map(r => r.cycle_hours)).toFixed(1)) : 0,
        max_cycle_hours: rows.length ? parseFloat(Math.max(...rows.map(r => r.cycle_hours)).toFixed(1)) : 0
      }
    }
  });
});

query.get('/stats/dashboard', (c) => {
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM lampshades GROUP BY status
  `).all();

  const overdueCount = db.prepare(`
    SELECT COUNT(*) as count FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    JOIN inspection_records ir ON ir.flow_id = pf.id AND ir.conclusion = 'pending'
    WHERE ir.next_inspection_at < datetime('now', 'localtime')
  `).get().count;

  const highWrinkleBatches = db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT pb.id FROM paper_batches pb
      JOIN lampshades l ON l.paper_batch_id = pb.id
      JOIN process_flows pf ON pf.shade_id = l.id
      JOIN mounting_records mr ON mr.flow_id = pf.id
      GROUP BY pb.id
      HAVING CAST(SUM(CASE WHEN mr.has_wrinkle = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(DISTINCT l.id) >= 0.3
    )
  `).get().count;

  const deliveredToday = db.prepare(`
    SELECT COUNT(*) as count FROM lampshades 
    WHERE date(delivered_at) = date('now', 'localtime')
  `).get().count;

  const pendingReworkConclusion = db.prepare(`
    SELECT COUNT(*) as count FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    JOIN rework_records rr ON rr.flow_id = pf.id AND rr.completed = 1
    WHERE NOT EXISTS (
      SELECT 1 FROM inspection_records ir 
      WHERE ir.flow_id = pf.id AND ir.conclusion != 'pending' AND ir.inspected_at > rr.completed_at
    ) AND l.status = 'pending_inspection'
  `).get().count;

  const last7Days = db.prepare(`
    SELECT date(delivered_at) as date, COUNT(*) as count
    FROM lampshades
    WHERE delivered_at >= date('now', 'localtime', '-7 days')
    GROUP BY date(delivered_at)
    ORDER BY date
  `).all();

  return c.json({
    code: 0,
    data: {
      status_counts: statusCounts,
      alerts: {
        overdue_inspection: overdueCount,
        high_wrinkle_batches: highWrinkleBatches,
        pending_rework_conclusion: pendingReworkConclusion
      },
      delivered_today: deliveredToday,
      last_7_days_delivery: last7Days
    }
  });
});

export default query;
