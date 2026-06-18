import { Hono } from 'hono';
import { db, STATES } from '../db.js';

const analytics = new Hono();

analytics.get('/wrinkle-batches', (c) => {
  const threshold = Number(c.req.query('threshold') || 2);
  const rows = db
    .prepare(
      `SELECT pb.id AS paper_batch_id, pb.batch_no,
              COUNT(*) AS wrinkle_count,
              AVG(lr.wrinkle_severity) AS avg_severity
         FROM lamination_record lr
         JOIN shade s ON s.id = lr.shade_id
         JOIN paper_batch pb ON pb.id = s.paper_batch_id
        WHERE lr.wrinkle_severity >= 1 OR (lr.wrinkle_note IS NOT NULL AND lr.wrinkle_note <> '')
        GROUP BY pb.id
        HAVING wrinkle_count >= ?
        ORDER BY wrinkle_count DESC`,
    )
    .all(threshold);
  return c.json({ data: rows });
});

analytics.get('/overdue-inspections', (c) => {
  const rows = db
    .prepare(
      `WITH last_insp AS (
         SELECT shade_id, MAX(inspected_at) AS last_inspected_at, MAX(next_due_at) AS next_due_at
           FROM inspection_record
          GROUP BY shade_id
       ),
       last_lam AS (
         SELECT shade_id, MAX(created_at) AS last_lamination_at
           FROM lamination_record
          GROUP BY shade_id
       )
       SELECT s.id, s.shade_no, s.current_state, s.inspect_cycle_hours,
              li.last_inspected_at,
              li.next_due_at,
              ll.last_lamination_at
         FROM shade s
         LEFT JOIN last_insp li ON li.shade_id = s.id
         LEFT JOIN last_lam  ll ON ll.shade_id  = s.id
        WHERE s.current_state IN (?, ?)
          AND (
            (li.next_due_at IS NOT NULL AND li.next_due_at < datetime('now'))
            OR (
              li.next_due_at IS NULL
              AND ll.last_lamination_at IS NOT NULL
              AND datetime(ll.last_lamination_at, '+' || COALESCE(s.inspect_cycle_hours, 24) || ' hours') < datetime('now')
            )
          )
        ORDER BY COALESCE(li.next_due_at, ll.last_lamination_at) ASC`,
    )
    .all(STATES.PENDING_INSPECT, STATES.REWORK);
  return c.json({ data: rows });
});

analytics.get('/rework-pending-conclusion', (c) => {
  const rows = db
    .prepare(
      `WITH last_rework AS (
         SELECT shade_id, MAX(inspected_at) AS last_rework_at
           FROM inspection_record
          WHERE rework_action IS NOT NULL AND rework_action <> ''
          GROUP BY shade_id
       )
       SELECT s.id, s.shade_no, s.current_state, lr.last_rework_at
         FROM shade s
         JOIN last_rework lr ON lr.shade_id = s.id
        WHERE s.current_state = ?
          AND NOT EXISTS (
            SELECT 1 FROM inspection_record ir2
             WHERE ir2.shade_id = s.id
               AND ir2.inspected_at > lr.last_rework_at
               AND ir2.conclusion IS NOT NULL
               AND ir2.conclusion <> ''
          )
        ORDER BY lr.last_rework_at ASC`,
    )
    .all(STATES.REWORK);
  return c.json({ data: rows });
});

analytics.get('/spec-anomaly-ranking', (c) => {
  const rows = db
    .prepare(
      `SELECT fs.id AS frame_spec_id, fs.spec_code, fs.shape,
              COUNT(DISTINCT s.id) AS anomaly_shade_count,
              SUM(CASE WHEN ir.rework_action IS NOT NULL AND ir.rework_action <> '' THEN 1 ELSE 0 END) AS rework_count,
              SUM(CASE WHEN lr.wrinkle_severity >= 1 THEN 1 ELSE 0 END) AS wrinkle_count
         FROM frame_spec fs
         JOIN shade s ON s.frame_spec_id = fs.id
         LEFT JOIN inspection_record ir ON ir.shade_id = s.id
         LEFT JOIN lamination_record lr ON lr.shade_id = s.id
        WHERE (ir.rework_action IS NOT NULL AND ir.rework_action <> '')
           OR lr.wrinkle_severity >= 1
        GROUP BY fs.id
        ORDER BY anomaly_shade_count DESC, rework_count DESC
        LIMIT 20`,
    )
    .all();
  return c.json({ data: rows });
});

analytics.get('/inspection-todos', (c) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.shade_no, s.current_state, s.inspect_cycle_hours,
              w.name AS owner_name, st.code AS station_code,
              MAX(ir.next_due_at) AS next_due_at
         FROM shade s
         LEFT JOIN worker w ON w.id = s.owner_id
         LEFT JOIN station st ON st.id = s.station_id
         LEFT JOIN inspection_record ir ON ir.shade_id = s.id
        WHERE s.current_state IN (?, ?)
        GROUP BY s.id
        ORDER BY (next_due_at IS NULL) DESC, next_due_at ASC`,
    )
    .all(STATES.PENDING_INSPECT, STATES.REWORK);
  return c.json({ data: rows });
});

analytics.get('/delivery-cycle-distribution', (c) => {
  const rows = db
    .prepare(
      `SELECT
          CASE
            WHEN hours < 24 THEN '<1天'
            WHEN hours < 72 THEN '1-3天'
            WHEN hours < 168 THEN '3-7天'
            WHEN hours < 336 THEN '7-14天'
            ELSE '>14天'
          END AS bucket,
          COUNT(*) AS shade_count,
          AVG(hours) AS avg_hours
       FROM (
         SELECT (julianday(pf.delivered_at) - julianday(pf.started_at)) * 24.0 AS hours
           FROM process_flow pf
          WHERE pf.delivered_at IS NOT NULL
       )
       GROUP BY bucket
       ORDER BY MIN(hours)`,
    )
    .all();
  return c.json({ data: rows });
});

analytics.get('/summary', (c) => {
  const stateCounts = db
    .prepare(`SELECT current_state AS state, COUNT(*) AS count FROM shade GROUP BY current_state`)
    .all();
  return c.json({ data: { state_counts: stateCounts, states: STATES } });
});

export default analytics;
