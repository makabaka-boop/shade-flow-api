import { Hono } from 'hono';
import { db, STATES, ACTIVE_STATES } from '../db.js';

const shades = new Hono();

const SHADE_FIELDS = [
  'shade_no',
  'frame_spec_id',
  'paper_batch_id',
  'station_id',
  'owner_id',
  'inspect_cycle_hours',
  'light_grade',
  'remark',
];

function getActiveFlow(shadeId) {
  return db
    .prepare('SELECT * FROM process_flow WHERE shade_id = ? AND active = 1')
    .get(shadeId);
}

function setShadeState(shadeId, state) {
  db.prepare(`UPDATE shade SET current_state = ?, updated_at = datetime('now') WHERE id = ?`).run(state, shadeId);
}

shades.post('/', async (c) => {
  const body = await c.req.json();
  if (!body.shade_no) return c.json({ error: 'shade_no 必填' }, 400);
  const cols = SHADE_FIELDS.filter((f) => body[f] !== undefined);
  const placeholders = cols.map(() => '?').join(',');
  const values = cols.map((f) => body[f]);
  try {
    const info = db
      .prepare(`INSERT INTO shade (${cols.join(',')}) VALUES (${placeholders})`)
      .run(...values);
    const row = db.prepare('SELECT * FROM shade WHERE id = ?').get(info.lastInsertRowid);
    return c.json({ data: row }, 201);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

shades.put('/:id', async (c) => {
  const body = await c.req.json();
  const cols = SHADE_FIELDS.filter((f) => body[f] !== undefined);
  if (cols.length === 0) return c.json({ error: '无更新字段' }, 400);
  const sets = cols.map((f) => `${f} = ?`).join(',');
  const values = cols.map((f) => body[f]);
  values.push(c.req.param('id'));
  db.prepare(`UPDATE shade SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM shade WHERE id = ?').get(c.req.param('id'));
  return c.json({ data: row });
});

shades.get('/:id', (c) => {
  const row = db
    .prepare(
      `SELECT s.*, fs.spec_code, fs.shape, pb.batch_no, st.code AS station_code, w.name AS owner_name
       FROM shade s
       LEFT JOIN frame_spec fs ON fs.id = s.frame_spec_id
       LEFT JOIN paper_batch pb ON pb.id = s.paper_batch_id
       LEFT JOIN station st ON st.id = s.station_id
       LEFT JOIN worker w ON w.id = s.owner_id
       WHERE s.id = ?`,
    )
    .get(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const flow = getActiveFlow(row.id);
  return c.json({ data: { ...row, active_flow: flow } });
});

shades.post('/:id/start-flow', async (c) => {
  const shadeId = Number(c.req.param('id'));
  const shade = db.prepare('SELECT * FROM shade WHERE id = ?').get(shadeId);
  if (!shade) return c.json({ error: 'shade not found' }, 404);

  const existing = getActiveFlow(shadeId);
  if (existing) {
    return c.json({ error: '同一灯罩存在活跃流程，禁止重复创建', flow: existing }, 409);
  }
  const info = db
    .prepare(`INSERT INTO process_flow (shade_id, state, active) VALUES (?, ?, 1)`)
    .run(shadeId, STATES.PENDING_FORM);
  setShadeState(shadeId, STATES.PENDING_FORM);
  const flow = db.prepare('SELECT * FROM process_flow WHERE id = ?').get(info.lastInsertRowid);
  return c.json({ data: flow }, 201);
});

shades.post('/:id/forming', async (c) => {
  const shadeId = Number(c.req.param('id'));
  const body = await c.req.json();
  const flow = getActiveFlow(shadeId);
  if (!flow) return c.json({ error: '当前灯罩无活跃流程' }, 400);
  if (![STATES.PENDING_FORM, STATES.FORMING].includes(flow.state)) {
    return c.json({ error: `当前状态为 ${flow.state}，仅允许在 待成型/成型中 提交骨架校正` }, 409);
  }

  const info = db
    .prepare(
      `INSERT INTO forming_record (flow_id, shade_id, worker_id, frame_correction, remark)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(flow.id, shadeId, body.worker_id ?? null, body.frame_correction ?? null, body.remark ?? null);

  db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(STATES.FORMING, flow.id);
  setShadeState(shadeId, STATES.FORMING);

  return c.json({ data: db.prepare('SELECT * FROM forming_record WHERE id = ?').get(info.lastInsertRowid) }, 201);
});

shades.post('/:id/lamination', async (c) => {
  const shadeId = Number(c.req.param('id'));
  const body = await c.req.json();
  const flow = getActiveFlow(shadeId);
  if (!flow) return c.json({ error: '当前灯罩无活跃流程' }, 400);
  if (body.layers === undefined) return c.json({ error: 'layers 必填' }, 400);
  if (![STATES.FORMING, STATES.REWORK].includes(flow.state)) {
    return c.json({ error: `当前状态为 ${flow.state}，必须在 成型中/返修中 才能登记裱贴` }, 409);
  }
  const formed = db
    .prepare('SELECT 1 FROM forming_record WHERE shade_id = ? LIMIT 1')
    .get(shadeId);
  if (!formed) {
    return c.json({ error: '尚无骨架校正记录，请先完成成型工序' }, 409);
  }

  const info = db
    .prepare(
      `INSERT INTO lamination_record (flow_id, shade_id, worker_id, layers, drying_hours, wrinkle_note, wrinkle_severity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      flow.id,
      shadeId,
      body.worker_id ?? null,
      body.layers,
      body.drying_hours ?? null,
      body.wrinkle_note ?? null,
      body.wrinkle_severity ?? 0,
    );

  db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(STATES.PENDING_INSPECT, flow.id);
  setShadeState(shadeId, STATES.PENDING_INSPECT);

  return c.json({ data: db.prepare('SELECT * FROM lamination_record WHERE id = ?').get(info.lastInsertRowid) }, 201);
});

shades.post('/:id/inspection', async (c) => {
  const shadeId = Number(c.req.param('id'));
  const body = await c.req.json();
  const flow = getActiveFlow(shadeId);
  if (!flow) return c.json({ error: '当前灯罩无活跃流程' }, 400);
  if (![STATES.PENDING_INSPECT, STATES.REWORK].includes(flow.state)) {
    return c.json({ error: `当前状态为 ${flow.state}，必须在 待巡检/返修中 才能提交巡检` }, 409);
  }
  const laminated = db
    .prepare('SELECT 1 FROM lamination_record WHERE shade_id = ? LIMIT 1')
    .get(shadeId);
  if (!laminated) {
    return c.json({ error: '尚无裱贴记录，无法进入巡检环节' }, 409);
  }

  const shade = db.prepare('SELECT * FROM shade WHERE id = ?').get(shadeId);
  const cycle = shade.inspect_cycle_hours || 24;
  const nextDue = db
    .prepare(`SELECT datetime('now', '+' || ? || ' hours') AS t`)
    .get(cycle).t;

  const info = db
    .prepare(
      `INSERT INTO inspection_record
        (flow_id, shade_id, worker_id, light_uniformity, light_grade, rework_action, conclusion, next_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      flow.id,
      shadeId,
      body.worker_id ?? null,
      body.light_uniformity ?? null,
      body.light_grade ?? null,
      body.rework_action ?? null,
      body.conclusion ?? null,
      nextDue,
    );

  const VALID_CONCLUSIONS = ['可交付', '暂停展示', '继续观察'];
  if (body.conclusion && !VALID_CONCLUSIONS.includes(body.conclusion)) {
    return c.json(
      { error: `非法 conclusion 值，必须是 ${VALID_CONCLUSIONS.join('/')} 之一` },
      400,
    );
  }

  let newState = flow.state;
  if (body.rework_action) {
    newState = STATES.REWORK;
    db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(newState, flow.id);
  } else if (body.conclusion === '可交付') {
    newState = STATES.DELIVERABLE;
    db.prepare(
      `UPDATE process_flow SET state = ?, active = 0, ended_at = datetime('now'), delivered_at = datetime('now'), final_recommendation = ? WHERE id = ?`,
    ).run(newState, body.conclusion, flow.id);
  } else if (body.conclusion === '暂停展示') {
    newState = STATES.PAUSED;
    db.prepare(
      `UPDATE process_flow SET state = ?, active = 0, ended_at = datetime('now'), final_recommendation = ? WHERE id = ?`,
    ).run(newState, body.conclusion, flow.id);
  } else {
    newState = STATES.PENDING_INSPECT;
    db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(newState, flow.id);
  }
  if (body.light_grade) {
    db.prepare(`UPDATE shade SET light_grade = ? WHERE id = ?`).run(body.light_grade, shadeId);
  }
  setShadeState(shadeId, newState);

  return c.json({ data: db.prepare('SELECT * FROM inspection_record WHERE id = ?').get(info.lastInsertRowid) }, 201);
});

shades.post('/:id/pause', (c) => {
  const shadeId = Number(c.req.param('id'));
  const flow = getActiveFlow(shadeId);
  if (flow) {
    db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(STATES.PAUSED, flow.id);
  }
  setShadeState(shadeId, STATES.PAUSED);
  return c.json({ ok: true });
});

shades.post('/:id/resume', (c) => {
  const shadeId = Number(c.req.param('id'));
  const flow = getActiveFlow(shadeId);
  if (!flow) return c.json({ error: '无活跃流程' }, 400);
  db.prepare(`UPDATE process_flow SET state = ? WHERE id = ?`).run(STATES.PENDING_INSPECT, flow.id);
  setShadeState(shadeId, STATES.PENDING_INSPECT);
  return c.json({ ok: true });
});

shades.get('/', (c) => {
  const q = c.req.query();
  const where = [];
  const params = [];

  if (q.paper_batch_id) {
    where.push('s.paper_batch_id = ?');
    params.push(q.paper_batch_id);
  }
  if (q.frame_spec_id) {
    where.push('s.frame_spec_id = ?');
    params.push(q.frame_spec_id);
  }
  if (q.station_id) {
    where.push('s.station_id = ?');
    params.push(q.station_id);
  }
  if (q.owner_id) {
    where.push('s.owner_id = ?');
    params.push(q.owner_id);
  }
  if (q.state) {
    where.push('s.current_state = ?');
    params.push(q.state);
  }
  if (q.light_grade) {
    where.push('s.light_grade = ?');
    params.push(q.light_grade);
  }
  if (q.start_date) {
    where.push("s.created_at >= ?");
    params.push(q.start_date);
  }
  if (q.end_date) {
    where.push("s.created_at <= ?");
    params.push(q.end_date);
  }

  const sql = `
    SELECT s.*, fs.spec_code, pb.batch_no, st.code AS station_code, w.name AS owner_name
    FROM shade s
    LEFT JOIN frame_spec fs ON fs.id = s.frame_spec_id
    LEFT JOIN paper_batch pb ON pb.id = s.paper_batch_id
    LEFT JOIN station st ON st.id = s.station_id
    LEFT JOIN worker w ON w.id = s.owner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.updated_at DESC
    LIMIT ${Number(q.limit) || 100} OFFSET ${Number(q.offset) || 0}
  `;
  const rows = db.prepare(sql).all(...params);
  return c.json({ data: rows, states: STATES });
});

export default shades;
