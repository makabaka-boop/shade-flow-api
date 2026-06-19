import { Hono } from 'hono';
import db from '../db.js';
import { STATUS, ACTIONS, canTransition } from '../constants.js';
import { now, getShadeById, logOperation, validatePerson } from '../utils.js';

const admin = new Hono();

function requireAdmin(operatorId) {
  return validatePerson(operatorId, ['admin'], 'operator_id');
}

admin.post('/shades', async (c) => {
  const body = await c.req.json();
  const {
    shade_no, paper_batch_id, skeleton_spec_id,
    station_id, responsible_person_id, inspection_cycle_hours, operator_id
  } = body;

  const auth = requireAdmin(operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (!shade_no || !paper_batch_id || !skeleton_spec_id || !station_id || !responsible_person_id) {
    return c.json({ code: 1, message: 'shade_no, paper_batch_id, skeleton_spec_id, station_id, responsible_person_id 必填' }, 400);
  }

  const pb = db.prepare(`SELECT id FROM paper_batches WHERE id = ?`).get(paper_batch_id);
  if (!pb) return c.json({ code: 1, message: '纸材批次不存在' }, 400);
  const ss = db.prepare(`SELECT id FROM skeleton_specs WHERE id = ?`).get(skeleton_spec_id);
  if (!ss) return c.json({ code: 1, message: '骨架规格不存在' }, 400);
  const st = db.prepare(`SELECT id FROM stations WHERE id = ?`).get(station_id);
  if (!st) return c.json({ code: 1, message: '成型台位不存在' }, 400);
  const rp = db.prepare(`SELECT id FROM persons WHERE id = ? AND active = 1`).get(responsible_person_id);
  if (!rp) return c.json({ code: 1, message: '责任人不存在或已停用' }, 400);

  try {
    const info = db.prepare(`
      INSERT INTO shades (shade_no, paper_batch_id, skeleton_spec_id, station_id, responsible_person_id, inspection_cycle_hours, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      shade_no, paper_batch_id, skeleton_spec_id, station_id, responsible_person_id,
      inspection_cycle_hours || 24, STATUS.PENDING_FORMING
    );
    const shade = getShadeById(info.lastInsertRowid);
    logOperation(info.lastInsertRowid, operator_id, 'create_shade', null, STATUS.PENDING_FORMING, { shade_no });
    return c.json({ code: 0, data: shade });
  } catch (e) {
    return c.json({ code: 1, message: e.message }, 400);
  }
});

admin.put('/shades/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  const isActiveProcess = [STATUS.FORMING, STATUS.PASTING, STATUS.DRYING, STATUS.REWORKING].includes(shade.status);
  if (isActiveProcess) {
    const hasProcessChange =
      body.paper_batch_id !== undefined ||
      body.skeleton_spec_id !== undefined ||
      body.station_id !== undefined;
    if (hasProcessChange) {
      return c.json({ code: 1, message: '工序进行中（成型/裱贴/干燥/返修）不可修改批次/规格/台位' }, 400);
    }
  }

  if (body.paper_batch_id !== undefined) {
    const pb = db.prepare(`SELECT id FROM paper_batches WHERE id = ?`).get(body.paper_batch_id);
    if (!pb) return c.json({ code: 1, message: '纸材批次不存在' }, 400);
  }
  if (body.skeleton_spec_id !== undefined) {
    const ss = db.prepare(`SELECT id FROM skeleton_specs WHERE id = ?`).get(body.skeleton_spec_id);
    if (!ss) return c.json({ code: 1, message: '骨架规格不存在' }, 400);
  }
  if (body.station_id !== undefined) {
    const st = db.prepare(`SELECT id FROM stations WHERE id = ?`).get(body.station_id);
    if (!st) return c.json({ code: 1, message: '成型台位不存在' }, 400);
  }
  if (body.responsible_person_id !== undefined) {
    const rp = db.prepare(`SELECT id FROM persons WHERE id = ? AND active = 1`).get(body.responsible_person_id);
    if (!rp) return c.json({ code: 1, message: '责任人不存在或已停用' }, 400);
  }

  db.prepare(`
    UPDATE shades SET
      shade_no = ?, paper_batch_id = ?, skeleton_spec_id = ?,
      station_id = ?, responsible_person_id = ?, inspection_cycle_hours = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    body.shade_no ?? shade.shade_no,
    body.paper_batch_id ?? shade.paper_batch_id,
    body.skeleton_spec_id ?? shade.skeleton_spec_id,
    body.station_id ?? shade.station_id,
    body.responsible_person_id ?? shade.responsible_person_id,
    body.inspection_cycle_hours ?? shade.inspection_cycle_hours,
    now(), id
  );
  return c.json({ code: 0, data: getShadeById(id) });
});

admin.post('/shades/:id/suspend', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status === STATUS.SUSPENDED) return c.json({ code: 1, message: '已是暂停展示状态' }, 400);
  if (shade.status === STATUS.DELIVERABLE) return c.json({ code: 1, message: '可交付状态无需暂停' }, 400);

  db.prepare(`
    UPDATE shades SET status = ?, suspended_at = ?, suspend_reason = ?, active_process_token = NULL, updated_at = ? WHERE id = ?
  `).run(STATUS.SUSPENDED, now(), body.reason || null, now(), id);

  logOperation(id, body.operator_id || null, ACTIONS.SUSPEND, shade.status, STATUS.SUSPENDED, { reason: body.reason });
  return c.json({ code: 0, data: getShadeById(id) });
});

admin.post('/shades/:id/resume', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.SUSPENDED) return c.json({ code: 1, message: '仅暂停状态可恢复' }, 400);

  const targetStatus = body.target_status || STATUS.PENDING_FORMING;
  if (![STATUS.PENDING_FORMING, STATUS.FORMING, STATUS.PASTING, STATUS.DRYING, STATUS.PENDING_INSPECTION, STATUS.REWORKING, STATUS.DELIVERABLE].includes(targetStatus)) {
    return c.json({ code: 1, message: '目标状态非法' }, 400);
  }

  db.prepare(`
    UPDATE shades SET status = ?, suspended_at = NULL, suspend_reason = NULL, updated_at = ? WHERE id = ?
  `).run(targetStatus, now(), id);

  logOperation(id, body.operator_id || null, ACTIONS.RESUME, STATUS.SUSPENDED, targetStatus, {});
  return c.json({ code: 0, data: getShadeById(id) });
});

admin.get('/shades/:id', (c) => {
  const id = Number(c.req.param('id'));
  const shade = getShadeById(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);
  return c.json({ code: 0, data: shade });
});

export default admin;
