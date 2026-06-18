import { Hono } from 'hono';
import db, { now } from '../db/index.js';
import { STATUS_LABELS, GRADE_LABELS, WRINKLE_LABELS } from '../db/schema.js';

const query = new Hono();

query.get('/lampshades', (c) => {
  const {
    batch_id, spec_id, station_id, responsible_id, status,
    date_from, date_to, light_grade, wrinkle_severity,
    keyword, page = '1', pageSize = '20'
  } = c.req.query();

  const p = Math.max(1, parseInt(page));
  const ps = Math.min(200, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  const conditions = [];
  const params = {};

  if (batch_id) { conditions.push('l.batch_id=@batch_id'); params.batch_id = parseInt(batch_id); }
  if (spec_id) { conditions.push('l.spec_id=@spec_id'); params.spec_id = parseInt(spec_id); }
  if (station_id) { conditions.push('l.station_id=@station_id'); params.station_id = parseInt(station_id); }
  if (responsible_id) { conditions.push('l.responsible_id=@responsible_id'); params.responsible_id = parseInt(responsible_id); }
  if (status) { conditions.push('l.status=@status'); params.status = status; }
  if (date_from) { conditions.push('l.created_at>=@date_from'); params.date_from = date_from; }
  if (date_to) { conditions.push('l.created_at<=@date_to'); params.date_to = date_to; }
  if (keyword) { conditions.push('(l.shade_no LIKE @kw OR pb.batch_no LIKE @kw)'); params.kw = `%${keyword}%`; }
  if (light_grade) {
    conditions.push(`EXISTS(SELECT 1 FROM process_records pr2 JOIN inspection_details id2 ON id2.process_id=pr2.id WHERE pr2.shade_id=l.id AND pr2.process_type='inspection' AND id2.light_uniformity_grade=@light_grade)`);
    params.light_grade = light_grade;
  }
  if (wrinkle_severity) {
    conditions.push(`(
      EXISTS(SELECT 1 FROM process_records pr2 JOIN pasting_details pd2 ON pd2.process_id=pr2.id WHERE pr2.shade_id=l.id AND pr2.process_type='pasting' AND pd2.wrinkle_severity=@ws)
      OR EXISTS(SELECT 1 FROM process_records pr2 JOIN inspection_details id2 ON id2.process_id=pr2.id WHERE pr2.shade_id=l.id AND pr2.process_type='inspection' AND id2.wrinkle_severity=@ws)
    )`);
    params.ws = wrinkle_severity;
  }

  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT l.id) AS c FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    ${whereSql}
  `).get(params);

  const rows = db.prepare(`
    SELECT l.*, pb.batch_no, ss.spec_code, ss.name AS spec_name,
           st.station_code, st.name AS station_name,
           w.name AS responsible_name, w.worker_code,
           ic.cycle_hours
    FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN stations st ON st.id=l.station_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
    ${whereSql}
    ORDER BY l.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: ps, offset });

  const gradeMap = {};
  for (const row of rows) {
    const latestInspection = db.prepare(`
      SELECT id.light_uniformity_grade, id.wrinkle_severity, id.conclusion
      FROM inspection_details id
      JOIN process_records pr ON pr.id=id.process_id
      WHERE pr.shade_id=? AND pr.process_type='inspection'
      ORDER BY pr.id DESC LIMIT 1
    `).get(row.id);
    row.latest_inspection = latestInspection || null;
    if (latestInspection?.light_uniformity_grade) {
      gradeMap[row.id] = latestInspection.light_uniformity_grade;
    }
    row.status_label = STATUS_LABELS[row.status] || row.status;
  }

  return c.json({
    code: 0,
    data: rows,
    total: totalRow.c,
    page: p,
    pageSize: ps,
    filters: { status_labels: STATUS_LABELS, grade_labels: GRADE_LABELS, wrinkle_labels: WRINKLE_LABELS }
  });
});

query.get('/lampshades/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  const lamp = db.prepare(`
    SELECT l.*, pb.batch_no, pb.supplier, ss.spec_code, ss.name AS spec_name,
           ss.diameter_cm, ss.height_cm, ss.material AS spec_material,
           st.station_code, st.name AS station_name, st.location,
           w.name AS responsible_name, w.worker_code, w.phone,
           ic.cycle_hours
    FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN stations st ON st.id=l.station_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
    WHERE l.id=?
  `).get(id);
  if (!lamp) return c.json({ code: 404, message: 'not found' }, 404);
  lamp.status_label = STATUS_LABELS[lamp.status];

  const processes = db.prepare(`
    SELECT pr.*, w.name AS technician_name
    FROM process_records pr
    LEFT JOIN workers w ON w.id=pr.technician_id
    WHERE pr.shade_id=? ORDER BY pr.id ASC
  `).all(id);

  for (const p of processes) {
    switch (p.process_type) {
      case 'forming':
        p.detail = db.prepare('SELECT * FROM forming_details WHERE process_id=?').get(p.id); break;
      case 'pasting':
        p.detail = db.prepare('SELECT * FROM pasting_details WHERE process_id=?').get(p.id); break;
      case 'drying':
        p.detail = db.prepare('SELECT * FROM drying_details WHERE process_id=?').get(p.id); break;
      case 'inspection':
        p.detail = db.prepare(`
          SELECT id.*, iw.name AS inspector_name
          FROM inspection_details id LEFT JOIN workers iw ON iw.id=id.inspector_id
          WHERE id.process_id=?
        `).get(p.id);
        if (p.detail) p.detail.grade_label = GRADE_LABELS[p.detail.light_uniformity_grade];
        break;
      case 'repair':
        p.detail = db.prepare(`
          SELECT rd.*, rw.name AS repairer_name
          FROM repair_details rd LEFT JOIN workers rw ON rw.id=rd.repaired_by
          WHERE rd.process_id=?
        `).get(p.id);
        break;
    }
    p.process_type_label = {
      forming: '骨架成型', pasting: '裱贴', drying: '干燥', inspection: '巡检', repair: '返修'
    }[p.process_type];
  }

  lamp.processes = processes;
  return c.json({ code: 0, data: lamp });
});

query.get('/dashboard/abnormal-specs', (c) => {
  const { days = '30', threshold = '2' } = c.req.query();
  const thresh = parseInt(threshold);
  const rows = db.prepare(`
    SELECT
      ss.id AS spec_id,
      ss.spec_code,
      ss.name AS spec_name,
      COUNT(DISTINCT l.id) AS total_count,
      SUM(CASE WHEN l.status IN ('in_repair','paused') THEN 1 ELSE 0 END) AS abnormal_count,
      SUM(CASE WHEN l.status='paused' THEN 1 ELSE 0 END) AS paused_count,
      SUM(CASE WHEN l.status='in_repair' THEN 1 ELSE 0 END) AS repair_count,
      ROUND(
        100.0 * SUM(CASE WHEN l.status IN ('in_repair','paused') THEN 1 ELSE 0 END)
        / NULLIF(COUNT(DISTINCT l.id),0), 2
      ) AS abnormal_rate,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr_p
        JOIN pasting_details pd ON pd.process_id=pr_p.id
        WHERE pr_p.shade_id=l.id AND pr_p.process_type='pasting'
          AND pd.wrinkle_severity IN ('moderate','severe')
      ) THEN 1 ELSE 0 END) AS wrinkle_issues,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr_i
        JOIN inspection_details idet ON idet.process_id=pr_i.id
        WHERE pr_i.shade_id=l.id AND pr_i.process_type='inspection'
          AND idet.light_uniformity_grade IN ('C','D')
      ) THEN 1 ELSE 0 END) AS poor_light_grades
    FROM skeleton_specs ss
    LEFT JOIN lampshades l ON l.spec_id=ss.id
      AND l.created_at >= datetime('now','localtime', '-' || ? || ' days')
    GROUP BY ss.id
    HAVING abnormal_count >= ?
    ORDER BY abnormal_rate DESC, abnormal_count DESC
  `).all(days, thresh);

  return c.json({ code: 0, data: rows, meta: { days: parseInt(days), threshold: thresh } });
});

query.get('/dashboard/inspection-todos', (c) => {
  const nowTs = now();

  const overdue = db.prepare(`
    SELECT l.id, l.shade_no, l.status, l.updated_at,
           pb.batch_no, ss.spec_code, ss.name AS spec_name,
           w.name AS responsible_name,
           idet.next_inspection_at,
           ic.cycle_hours,
           CAST((julianday(?) - julianday(COALESCE(idet.next_inspection_at, l.updated_at))) * 24 AS INTEGER) AS overdue_hours
    FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
    LEFT JOIN (
      SELECT pr.shade_id, idet.next_inspection_at
      FROM process_records pr
      JOIN inspection_details idet ON idet.process_id=pr.id
      WHERE pr.process_type='inspection'
      AND idet.next_inspection_at IS NOT NULL
      AND pr.id = (SELECT MAX(pr2.id) FROM process_records pr2 JOIN inspection_details id2 ON id2.process_id=pr2.id WHERE pr2.shade_id=pr.shade_id AND pr2.process_type='inspection')
    ) idet ON idet.shade_id=l.id
    WHERE l.status='pending_inspection'
    ORDER BY overdue_hours DESC NULLS LAST, l.updated_at ASC
  `).all(nowTs);

  for (const item of overdue) {
    item.status_label = STATUS_LABELS[item.status];
  }

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS cnt
    FROM lampshades WHERE status IN ('pending_inspection','in_repair','pending_forming','forming')
    GROUP BY status
  `).all();

  return c.json({ code: 0, data: { overdue_items: overdue, summary: byStatus, labels: STATUS_LABELS } });
});

query.get('/dashboard/delivery-cycle', (c) => {
  const { days = '90', buckets = '7' } = c.req.query();
  const bucketCount = parseInt(buckets);

  const rows = db.prepare(`
    SELECT
      l.shade_no,
      l.status,
      l.created_at,
      l.delivered_at,
      ss.spec_code,
      pb.batch_no,
      ROUND((julianday(COALESCE(l.delivered_at, datetime('now','localtime'))) - julianday(l.created_at)) * 24, 1) AS cycle_hours,
      CASE WHEN l.delivered_at IS NOT NULL THEN 1 ELSE 0 END AS delivered
    FROM lampshades l
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN paper_batches pb ON pb.id=l.batch_id
    WHERE l.created_at >= datetime('now','localtime', '-' || ? || ' days')
  `).all(days);

  const delivered = rows.filter(r => r.delivered);
  const undelivered = rows.filter(r => !r.delivered);

  let distribution = [];
  if (rows.length) {
    const hours = rows.map(r => r.cycle_hours);
    const maxH = Math.max(...hours);
    const step = Math.max(1, Math.ceil(maxH / bucketCount));

    for (let i = 0; i < bucketCount; i++) {
      const lo = i * step;
      const hi = (i === bucketCount - 1) ? Infinity : (i + 1) * step;
      const matched = rows.filter(r => r.cycle_hours >= lo && r.cycle_hours < hi);
      distribution.push({
        range: hi === Infinity ? `${lo}h+` : `${lo}-${hi}h`,
        min_hours: lo,
        max_hours: hi === Infinity ? null : hi,
        count: matched.length,
        delivered_count: matched.filter(r => r.delivered).length
      });
    }
  }

  const avgHours = delivered.length
    ? Math.round(delivered.reduce((s, r) => s + r.cycle_hours, 0) / delivered.length * 10) / 10
    : null;
  const minHours = delivered.length ? Math.min(...delivered.map(r => r.cycle_hours)) : null;
  const maxHours = delivered.length ? Math.max(...delivered.map(r => r.cycle_hours)) : null;

  return c.json({
    code: 0,
    data: {
      distribution,
      stats: {
        total_in_range: rows.length,
        delivered_count: delivered.length,
        in_progress_count: undelivered.length,
        avg_delivery_hours: avgHours,
        min_delivery_hours: minHours,
        max_delivery_hours: maxHours
      },
      meta: { days: parseInt(days), buckets: bucketCount }
    }
  });
});

query.get('/alerts/wrinkle-batches', (c) => {
  const { days = '30', threshold = '2' } = c.req.query();
  const thresh = parseInt(threshold);
  const rows = db.prepare(`
    SELECT
      pb.id AS batch_id,
      pb.batch_no,
      pb.supplier,
      COUNT(DISTINCT l.id) AS total_shades,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr
        JOIN pasting_details pd ON pd.process_id=pr.id
        WHERE pr.shade_id=l.id AND pr.process_type='pasting'
          AND pd.wrinkle_severity IN ('moderate','severe')
      ) THEN 1 ELSE 0 END) AS wrinkle_count,
      ROUND(
        100.0 * SUM(CASE WHEN EXISTS(
          SELECT 1 FROM process_records pr
          JOIN pasting_details pd ON pd.process_id=pr.id
          WHERE pr.shade_id=l.id AND pr.process_type='pasting'
            AND pd.wrinkle_severity IN ('moderate','severe')
        ) THEN 1 ELSE 0 END)
        / NULLIF(COUNT(DISTINCT l.id),0), 2
      ) AS wrinkle_rate,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr
        JOIN pasting_details pd ON pd.process_id=pr.id
        WHERE pr.shade_id=l.id AND pr.process_type='pasting'
          AND pd.wrinkle_severity='severe'
      ) THEN 1 ELSE 0 END) AS severe_count
    FROM paper_batches pb
    JOIN lampshades l ON l.batch_id=pb.id AND l.created_at >= datetime('now','localtime', '-' || ? || ' days')
    GROUP BY pb.id
    HAVING wrinkle_count >= ?
    ORDER BY wrinkle_rate DESC, wrinkle_count DESC
  `).all(days, thresh);

  return c.json({ code: 0, data: rows, meta: { days: parseInt(days), threshold: thresh, wrinkle_labels: WRINKLE_LABELS } });
});

query.get('/alerts/overdue-inspections', (c) => {
  const nowTs = now();
  const rows = db.prepare(`
    SELECT
      l.id, l.shade_no, l.status, l.updated_at,
      pb.batch_no, ss.spec_code, w.name AS responsible_name,
      ic.cycle_hours,
      idet.next_inspection_at,
      CAST((julianday(?) - julianday(COALESCE(idet.next_inspection_at, l.updated_at))) * 24 AS INTEGER) AS overdue_hours
    FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
    LEFT JOIN (
      SELECT pr.shade_id, idet.next_inspection_at
      FROM process_records pr
      JOIN inspection_details idet ON idet.process_id=pr.id
      WHERE pr.process_type='inspection' AND idet.next_inspection_at IS NOT NULL
      AND pr.id IN (
        SELECT MAX(pr2.id) FROM process_records pr2
        JOIN inspection_details id2 ON id2.process_id=pr2.id
        WHERE pr2.process_type='inspection'
        GROUP BY pr2.shade_id
      )
    ) idet ON idet.shade_id=l.id
    WHERE l.status='pending_inspection'
    AND (
      (idet.next_inspection_at IS NOT NULL AND idet.next_inspection_at < ?)
      OR (idet.next_inspection_at IS NULL AND julianday(?) - julianday(l.updated_at) > COALESCE(ic.cycle_hours,24)/24.0)
    )
    ORDER BY overdue_hours DESC
  `).all(nowTs, nowTs, nowTs);

  for (const r of rows) r.status_label = STATUS_LABELS[r.status];
  return c.json({ code: 0, data: rows, count: rows.length });
});

query.get('/alerts/repair-no-conclusion', (c) => {
  const rows = db.prepare(`
    SELECT
      l.id, l.shade_no, l.status,
      pb.batch_no, ss.spec_code, w.name AS responsible_name,
      pr.id AS process_id, pr.start_time AS repair_started_at,
      rd.repair_action,
      COALESCE(rd.conclusion_submitted, 0) AS conclusion_submitted,
      CAST((julianday(datetime('now','localtime')) - julianday(pr.start_time)) * 24 AS INTEGER) AS elapsed_hours,
      rw.name AS repairer_name,
      CASE WHEN rd.id IS NULL THEN 1 ELSE 0 END AS missing_record
    FROM lampshades l
    JOIN process_records pr ON pr.shade_id=l.id AND pr.process_type='repair'
      AND pr.end_time IS NULL
      AND pr.id = (
        SELECT MAX(pr2.id) FROM process_records pr2
        WHERE pr2.shade_id=l.id AND pr2.process_type='repair' AND pr2.end_time IS NULL
      )
    LEFT JOIN repair_details rd ON rd.process_id=pr.id
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN workers rw ON rw.id=rd.repaired_by
    WHERE rd.id IS NULL OR rd.conclusion_submitted=0
    ORDER BY pr.start_time ASC
  `).all();

  return c.json({ code: 0, data: rows, count: rows.length });
});

query.get('/alerts/spec-abnormal-cluster', (c) => {
  const { days = '14', cluster_size = '3' } = c.req.query();
  const size = parseInt(cluster_size);
  const rows = db.prepare(`
    SELECT
      ss.id AS spec_id,
      ss.spec_code,
      ss.name AS spec_name,
      COUNT(DISTINCT l.id) AS period_total,
      SUM(CASE WHEN l.status='paused' THEN 1 ELSE 0 END) AS paused_count,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr2 JOIN repair_details rd ON rd.process_id=pr2.id
        WHERE pr2.shade_id=l.id AND pr2.process_type='repair'
      ) THEN 1 ELSE 0 END) AS repair_lamp_count,
      SUM(CASE WHEN idet.light_uniformity_grade IN ('C','D') THEN 1 ELSE 0 END) AS poor_light_count,
      SUM(CASE WHEN EXISTS(
        SELECT 1 FROM process_records pr_p
        JOIN pasting_details pd ON pd.process_id=pr_p.id
        WHERE pr_p.shade_id=l.id AND pr_p.process_type='pasting'
          AND pd.wrinkle_severity='severe'
      ) THEN 1 ELSE 0 END) AS severe_wrinkle_count
    FROM skeleton_specs ss
    JOIN lampshades l ON l.spec_id=ss.id AND l.created_at >= datetime('now','localtime', '-' || ? || ' days')
    LEFT JOIN (
      SELECT pr.shade_id, idet.light_uniformity_grade
      FROM process_records pr JOIN inspection_details idet ON idet.process_id=pr.id
      WHERE pr.process_type='inspection'
      AND pr.id IN (SELECT MAX(pr2.id) FROM process_records pr2 JOIN inspection_details id2 ON id2.process_id=pr2.id WHERE pr2.process_type='inspection' GROUP BY pr2.shade_id)
    ) idet ON idet.shade_id=l.id
    GROUP BY ss.id
    HAVING (paused_count + poor_light_count + severe_wrinkle_count) >= ?
    ORDER BY (paused_count + poor_light_count + severe_wrinkle_count) DESC
  `).all(days, size);

  return c.json({ code: 0, data: rows, meta: { days: parseInt(days), cluster_size: size } });
});

query.get('/summary', (c) => {
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count FROM lampshades GROUP BY status ORDER BY count DESC
  `).all();

  const total = db.prepare('SELECT COUNT(*) AS c FROM lampshades').get().c;
  const active = db.prepare(`SELECT COUNT(*) AS c FROM lampshades WHERE status NOT IN ('deliverable','paused')`).get().c;

  const wrinkleAlerts = db.prepare(`
    SELECT COUNT(DISTINCT l.id) AS c FROM lampshades l
    JOIN process_records pr ON pr.shade_id=l.id
    JOIN pasting_details pd ON pd.process_id=pr.id
    WHERE pd.wrinkle_severity IN ('moderate','severe')
  `).get().c;

  return c.json({
    code: 0,
    data: {
      total_lampshades: total,
      active_lampshades: active,
      by_status: byStatus.map(r => ({ ...r, label: STATUS_LABELS[r.status] })),
      wrinkle_alert_count: wrinkleAlerts,
      status_labels: STATUS_LABELS
    }
  });
});

export default query;
