import { Hono } from 'hono';
import db, { now } from '../db/index.js';

const proc = new Hono();

const VALID_TRANSITIONS = {
  pending_forming: ['forming', 'paused'],
  forming: ['pending_inspection', 'paused'],
  pending_inspection: ['deliverable', 'in_repair', 'paused'],
  in_repair: ['pending_inspection', 'paused'],
  deliverable: [],
  paused: ['pending_forming', 'forming', 'pending_inspection', 'in_repair']
};

function assertTransition(current, next) {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(next)) {
    throw new Error(`状态流转非法: ${current} → ${next}`);
  }
}

function getLamp(id) {
  const lamp = db.prepare(`
    SELECT l.*, pb.batch_no, ss.spec_code, ss.name AS spec_name,
           st.station_code, w.name AS responsible_name,
           ic.cycle_hours
    FROM lampshades l
    JOIN paper_batches pb ON pb.id=l.batch_id
    JOIN skeleton_specs ss ON ss.id=l.spec_id
    JOIN stations st ON st.id=l.station_id
    JOIN workers w ON w.id=l.responsible_id
    LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
    WHERE l.id=?
  `).get(id);
  return lamp;
}

function getActiveProcess(shadeId) {
  return db.prepare(`
    SELECT * FROM process_records
    WHERE shade_id=? AND end_time IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(shadeId);
}

proc.post('/lampshades/:id/start-forming', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const technicianId = body.technician_id || null;

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const active = getActiveProcess(id);
    if (active) throw new Error(`存在未结束的活跃工序: ${active.process_type}，不能重复启动`);

    assertTransition(lamp.status, 'forming');

    const ts = now();
    const procInfo = db.prepare(`
      INSERT INTO process_records (shade_id, process_type, start_time, technician_id, notes)
      VALUES (?, 'forming', ?, ?, ?)
    `).run(id, ts, technicianId, body.notes || null);

    db.prepare(`UPDATE lampshades SET status='forming', updated_at=? WHERE id=?`).run(ts, id);

    return { process_id: procInfo.lastInsertRowid, status: 'forming' };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/forming-record', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');
    if (lamp.status !== 'forming') throw new Error(`当前状态为 ${lamp.status}，请先开始成型`);

    const process = db.prepare(`
      SELECT * FROM process_records WHERE shade_id=? AND process_type='forming' AND end_time IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(id);
    if (!process) throw new Error('未找到活跃的成型工序');

    const ts = now();
    db.prepare(`
      INSERT INTO forming_details (process_id, skeleton_correction, correction_notes)
      VALUES (?, ?, ?)
      ON CONFLICT(process_id) DO UPDATE SET skeleton_correction=excluded.skeleton_correction, correction_notes=excluded.correction_notes
    `).run(process.id, body.skeleton_correction || null, body.correction_notes || null);

    if (body.complete) {
      db.prepare(`UPDATE process_records SET end_time=?, notes=COALESCE(?, notes) WHERE id=?`).run(ts, body.notes || null, process.id);
      assertTransition(lamp.status, 'pending_inspection');
      db.prepare(`UPDATE lampshades SET status='pending_inspection', updated_at=? WHERE id=?`).run(ts, id);
      return { completed: true, next_status: 'pending_inspection' };
    }
    return { completed: false };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/pasting-record', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  if (!body.layer_count) {
    return c.json({ code: 400, message: 'layer_count (裱贴层数) 必填' }, 400);
  }

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    if (lamp.status !== 'forming' && lamp.status !== 'pending_inspection' && lamp.status !== 'in_repair') {
      throw new Error(`当前状态 ${lamp.status} 不可添加裱贴记录`);
    }

    const active = getActiveProcess(id);
    if (active && active.process_type !== 'pasting') {
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(now(), active.id);
    }

    let process;
    const existingPasting = db.prepare(`
      SELECT * FROM process_records WHERE shade_id=? AND process_type='pasting' AND end_time IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(id);

    if (existingPasting) {
      process = existingPasting;
    } else {
      const ts = now();
      const info = db.prepare(`
        INSERT INTO process_records (shade_id, process_type, start_time, technician_id, notes)
        VALUES (?, 'pasting', ?, ?, ?)
      `).run(id, ts, body.technician_id || null, body.notes || null);
      process = { id: info.lastInsertRowid };
    }

    db.prepare(`
      INSERT INTO pasting_details (process_id, layer_count, wrinkle_description, wrinkle_severity)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(process_id) DO UPDATE SET
        layer_count=excluded.layer_count,
        wrinkle_description=excluded.wrinkle_description,
        wrinkle_severity=excluded.wrinkle_severity
    `).run(process.id, body.layer_count, body.wrinkle_description || null, body.wrinkle_severity || null);

    if (body.complete) {
      const ts = now();
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(ts, process.id);
    }
    return { process_id: process.id };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/drying-record', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  if (body.duration_minutes === undefined) {
    return c.json({ code: 400, message: 'duration_minutes (干燥时长/分钟) 必填' }, 400);
  }

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const active = getActiveProcess(id);
    if (active && active.process_type !== 'drying') {
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(now(), active.id);
    }

    let process;
    const existingDrying = db.prepare(`
      SELECT * FROM process_records WHERE shade_id=? AND process_type='drying' AND end_time IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(id);

    if (existingDrying) {
      process = existingDrying;
    } else {
      const ts = now();
      const info = db.prepare(`
        INSERT INTO process_records (shade_id, process_type, start_time, technician_id, notes)
        VALUES (?, 'drying', ?, ?, ?)
      `).run(id, ts, body.technician_id || null, body.notes || null);
      process = { id: info.lastInsertRowid };
    }

    db.prepare(`
      INSERT INTO drying_details (process_id, duration_minutes, temp_celsius, humidity_percent)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(process_id) DO UPDATE SET
        duration_minutes=excluded.duration_minutes,
        temp_celsius=excluded.temp_celsius,
        humidity_percent=excluded.humidity_percent
    `).run(process.id, body.duration_minutes, body.temp_celsius || null, body.humidity_percent || null);

    if (body.complete) {
      const ts = now();
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(ts, process.id);
      if (lamp.status === 'forming') {
        assertTransition(lamp.status, 'pending_inspection');
        db.prepare(`UPDATE lampshades SET status='pending_inspection', updated_at=? WHERE id=?`).run(ts, id);
      }
    }
    return { process_id: process.id };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/submit-inspection', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const active = getActiveProcess(id);
    if (active) {
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(now(), active.id);
    }

    if (lamp.status === 'forming' || lamp.status === 'in_repair') {
      db.prepare(`UPDATE lampshades SET status='pending_inspection', updated_at=? WHERE id=?`).run(now(), id);
    } else if (lamp.status !== 'pending_inspection') {
      throw new Error(`当前状态 ${lamp.status} 不可提交巡检`);
    }
    return { status: 'pending_inspection' };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/inspect', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  if (!body.light_uniformity_grade || !body.conclusion) {
    return c.json({ code: 400, message: 'light_uniformity_grade 和 conclusion 必填' }, 400);
  }
  if (!['A','B','C','D'].includes(body.light_uniformity_grade)) {
    return c.json({ code: 400, message: '透光等级必须为 A/B/C/D' }, 400);
  }
  if (!['deliverable','repair','pause'].includes(body.conclusion)) {
    return c.json({ code: 400, message: '结论必须为 deliverable/repair/pause' }, 400);
  }

  const run = db.transaction(() => {
    const lamp = db.prepare(`
      SELECT l.*, ic.cycle_hours
      FROM lampshades l
      LEFT JOIN inspection_cycles ic ON ic.spec_id=l.spec_id
      WHERE l.id=?
    `).get(id);
    if (!lamp) throw new Error('灯罩不存在');
    if (lamp.status !== 'pending_inspection') throw new Error(`当前状态 ${lamp.status}，不在待巡检状态`);

    const active = getActiveProcess(id);
    if (active) {
      db.prepare(`UPDATE process_records SET end_time=? WHERE id=?`).run(now(), active.id);
    }

    const ts = now();
    const cycleHours = lamp.cycle_hours || 24;
    const nextInspection = body.conclusion === 'repair'
      ? db.prepare(`SELECT datetime(?, '+' || ? || ' hours') AS t`).get(ts, cycleHours).t
      : null;

    const procInfo = db.prepare(`
      INSERT INTO process_records (shade_id, process_type, start_time, end_time, technician_id, notes)
      VALUES (?, 'inspection', ?, ?, ?, ?)
    `).run(id, ts, ts, body.inspector_id || null, body.notes || null);

    db.prepare(`
      INSERT INTO inspection_details
        (process_id, light_uniformity_grade, wrinkle_severity, conclusion, inspector_id, inspection_time, next_inspection_at, final_recommendation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      procInfo.lastInsertRowid,
      body.light_uniformity_grade,
      body.wrinkle_severity || null,
      body.conclusion,
      body.inspector_id || null,
      ts,
      nextInspection,
      body.final_recommendation || null
    );

    let nextStatus;
    if (body.conclusion === 'deliverable') nextStatus = 'deliverable';
    else if (body.conclusion === 'repair') nextStatus = 'in_repair';
    else nextStatus = 'paused';

    assertTransition(lamp.status, nextStatus);
    db.prepare(`UPDATE lampshades SET status=?, updated_at=? WHERE id=?`).run(nextStatus, ts, id);

    return { inspection_id: procInfo.lastInsertRowid, next_status: nextStatus };
  });

  try {
    const result = run();
    const lamp = getLamp(id);
    return c.json({ code: 0, data: result, lamp });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/start-repair', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const active = getActiveProcess(id);
    if (active) throw new Error(`存在未结束的活跃工序: ${active.process_type}`);

    if (lamp.status === 'pending_inspection') {
      db.prepare(`UPDATE lampshades SET status='in_repair', updated_at=? WHERE id=?`).run(now(), id);
    } else if (lamp.status !== 'in_repair') {
      throw new Error(`当前状态 ${lamp.status} 不可返修`);
    }

    const ts = now();
    const procInfo = db.prepare(`
      INSERT INTO process_records (shade_id, process_type, start_time, technician_id, notes)
      VALUES (?, 'repair', ?, ?, ?)
    `).run(id, ts, body.technician_id || null, body.notes || null);

    return { process_id: procInfo.lastInsertRowid };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/repair-record', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();

  if (!body.repair_action) {
    return c.json({ code: 400, message: 'repair_action (返修动作) 必填' }, 400);
  }

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const process = db.prepare(`
      SELECT * FROM process_records WHERE shade_id=? AND process_type='repair' AND end_time IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(id);
    if (!process) throw new Error('未找到活跃的返修工序，请先开始返修');

    const ts = now();
    db.prepare(`
      INSERT INTO repair_details (process_id, repair_action, result_notes, conclusion_submitted, repaired_by, repaired_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(process_id) DO UPDATE SET
        repair_action=excluded.repair_action,
        result_notes=excluded.result_notes,
        conclusion_submitted=excluded.conclusion_submitted,
        repaired_by=excluded.repaired_by,
        repaired_at=excluded.repaired_at
    `).run(
      process.id,
      body.repair_action,
      body.result_notes || null,
      body.conclusion_submitted ? 1 : 0,
      body.repaired_by || body.technician_id || null,
      ts
    );

    let result = { process_id: process.id };
    if (body.conclusion_submitted) {
      db.prepare(`UPDATE process_records SET end_time=?, notes=COALESCE(?, notes) WHERE id=?`).run(ts, body.notes || null, process.id);
      assertTransition(lamp.status, 'pending_inspection');
      db.prepare(`UPDATE lampshades SET status='pending_inspection', updated_at=? WHERE id=?`).run(ts, id);
      result.next_status = 'pending_inspection';
    }
    return result;
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/pause', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');

    const active = getActiveProcess(id);
    if (active) {
      db.prepare(`UPDATE process_records SET end_time=?, notes=COALESCE(?, notes) WHERE id=?`).run(now(), body.reason || null, active.id);
    }

    db.prepare(`UPDATE lampshades SET status='paused', updated_at=? WHERE id=?`).run(now(), id);
    return { status: 'paused' };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/resume', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const target = body.resume_to || 'pending_forming';

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');
    if (lamp.status !== 'paused') throw new Error('仅暂停状态可恢复');

    assertTransition('paused', target);
    db.prepare(`UPDATE lampshades SET status=?, updated_at=? WHERE id=?`).run(target, now(), id);
    return { status: target };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.post('/lampshades/:id/deliver', async (c) => {
  const id = parseInt(c.req.param('id'));

  const run = db.transaction(() => {
    const lamp = db.prepare('SELECT * FROM lampshades WHERE id=?').get(id);
    if (!lamp) throw new Error('灯罩不存在');
    if (lamp.status !== 'deliverable') throw new Error(`当前状态 ${lamp.status}，不可交付`);

    const ts = now();
    db.prepare(`UPDATE lampshades SET delivered_at=?, updated_at=? WHERE id=?`).run(ts, ts, id);
    return { delivered_at: ts };
  });

  try {
    const result = run();
    return c.json({ code: 0, data: result, lamp: getLamp(id) });
  } catch (e) {
    return c.json({ code: 400, message: e.message }, 400);
  }
});

proc.get('/lampshades/:id/timeline', (c) => {
  const id = parseInt(c.req.param('id'));
  const lamp = getLamp(id);
  if (!lamp) return c.json({ code: 404, message: 'not found' }, 404);

  const processes = db.prepare(`
    SELECT pr.*, w.name AS technician_name
    FROM process_records pr
    LEFT JOIN workers w ON w.id=pr.technician_id
    WHERE pr.shade_id=?
    ORDER BY pr.id ASC
  `).all(id);

  for (const p of processes) {
    if (p.process_type === 'forming') {
      p.detail = db.prepare('SELECT * FROM forming_details WHERE process_id=?').get(p.id);
    } else if (p.process_type === 'pasting') {
      p.detail = db.prepare('SELECT * FROM pasting_details WHERE process_id=?').get(p.id);
    } else if (p.process_type === 'drying') {
      p.detail = db.prepare('SELECT * FROM drying_details WHERE process_id=?').get(p.id);
    } else if (p.process_type === 'inspection') {
      p.detail = db.prepare(`
        SELECT id.*, w.name AS inspector_name
        FROM inspection_details id
        LEFT JOIN workers w ON w.id=id.inspector_id
        WHERE id.process_id=?
      `).get(p.id);
    } else if (p.process_type === 'repair') {
      p.detail = db.prepare(`
        SELECT rd.*, w.name AS repairer_name
        FROM repair_details rd
        LEFT JOIN workers w ON w.id=rd.repaired_by
        WHERE rd.process_id=?
      `).get(p.id);
    }
  }

  return c.json({ code: 0, data: { lamp, processes } });
});

export default proc;
