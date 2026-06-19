import { Hono } from 'hono';
import db from '../db.js';
import { STATUS, ACTIONS, LIGHT_GRADES, generateProcessToken, canTransition } from '../constants.js';
import { now, getShadeById, logOperation, resolveAlertsForShade, scanAlerts, getInspectionsForShade, getOperationLogs, validatePerson } from '../utils.js';

const process_ = new Hono();

const requireOperator = (id) => validatePerson(id, ['operator', 'admin'], 'operator_id');
const requireInspector = (id) => validatePerson(id, ['inspector', 'admin'], 'inspector_id');
const requireAnyStaff = (id, field = 'operator_id') => validatePerson(id, ['operator', 'inspector', 'admin'], field);

process_.post('/shades/:id/start-forming', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.PENDING_FORMING && shade.status !== STATUS.SUSPENDED) {
    return c.json({ code: 1, message: '仅待成型或暂停状态可启动成型' }, 400);
  }
  if (shade.active_process_token) {
    return c.json({ code: 1, message: '该灯罩存在活跃流程，请勿重复操作' }, 409);
  }

  const token = generateProcessToken();
  db.prepare(`
    UPDATE shades SET status = ?, forming_started_at = ?, forming_operator_id = ?, active_process_token = ?, updated_at = ? WHERE id = ?
  `).run(STATUS.FORMING, now(), body.operator_id, token, now(), id);

  logOperation(id, body.operator_id, ACTIONS.START_FORMING, shade.status, STATUS.FORMING, {});
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id), process_token: token });
});

process_.post('/shades/:id/forming-complete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.FORMING) {
    return c.json({ code: 1, message: `当前状态为 ${shade.status}，无法完成成型（需要 成型中）` }, 400);
  }
  if (!shade.forming_started_at) {
    return c.json({ code: 1, message: '成型未启动，请先调用 start-forming' }, 400);
  }

  const { skeleton_correction_notes, skeleton_corrected } = body;

  db.prepare(`
    UPDATE shades SET
      forming_completed_at = ?,
      skeleton_correction_notes = ?,
      skeleton_corrected = ?,
      status = ?,
      active_process_token = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    now(),
    skeleton_correction_notes || null,
    skeleton_corrected ? 1 : 0,
    STATUS.PASTING,
    now(), id
  );

  logOperation(id, body.operator_id, ACTIONS.COMPLETE_FORMING, STATUS.FORMING, STATUS.PASTING, {
    skeleton_correction_notes, skeleton_corrected: !!skeleton_corrected
  });
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id) });
});

process_.post('/shades/:id/start-pasting', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.PASTING) {
    if (shade.status === STATUS.FORMING) {
      return c.json({ code: 1, message: '请先完成骨架成型记录' }, 400);
    }
    return c.json({ code: 1, message: '当前状态不可启动裱贴' }, 400);
  }
  if (shade.pasting_started_at) {
    return c.json({ code: 1, message: '裱贴已启动，请勿重复操作' }, 409);
  }
  if (shade.active_process_token) {
    return c.json({ code: 1, message: '该灯罩存在活跃流程，请勿重复操作' }, 409);
  }

  const token = generateProcessToken();
  db.prepare(`
    UPDATE shades SET pasting_started_at = ?, pasting_operator_id = ?, active_process_token = ?, updated_at = ? WHERE id = ?
  `).run(now(), body.operator_id, token, now(), id);

  logOperation(id, body.operator_id, ACTIONS.START_PASTING, STATUS.PASTING, STATUS.PASTING, {});
  return c.json({ code: 0, data: getShadeById(id), process_token: token });
});

process_.post('/shades/:id/pasting-complete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.PASTING) {
    return c.json({ code: 1, message: `当前状态为 ${shade.status}，无法完成裱贴（需要 裱贴中）` }, 400);
  }
  if (!shade.pasting_started_at) {
    return c.json({ code: 1, message: '裱贴未启动，请先调用 start-pasting' }, 400);
  }

  const { paste_layers, paste_notes } = body;
  if (!paste_layers || paste_layers < 1) return c.json({ code: 1, message: '裱贴层数必须为正整数' }, 400);

  db.prepare(`
    UPDATE shades SET
      pasting_completed_at = ?, paste_layers = ?, paste_notes = ?,
      status = ?, active_process_token = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), paste_layers, paste_notes || null, STATUS.DRYING, now(), id);

  logOperation(id, body.operator_id, ACTIONS.COMPLETE_PASTING, STATUS.PASTING, STATUS.DRYING, { paste_layers, paste_notes });
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id) });
});

process_.post('/shades/:id/start-drying', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.DRYING) return c.json({ code: 1, message: '当前状态不可启动干燥' }, 400);
  if (shade.drying_started_at) return c.json({ code: 1, message: '干燥已启动，请勿重复操作' }, 409);
  if (shade.active_process_token) return c.json({ code: 1, message: '该灯罩存在活跃流程' }, 409);

  const token = generateProcessToken();
  db.prepare(`
    UPDATE shades SET drying_started_at = ?, drying_operator_id = ?, active_process_token = ?, updated_at = ? WHERE id = ?
  `).run(now(), body.operator_id, token, now(), id);

  logOperation(id, body.operator_id, ACTIONS.START_DRYING, STATUS.DRYING, STATUS.DRYING, {});
  return c.json({ code: 0, data: getShadeById(id), process_token: token });
});

process_.post('/shades/:id/drying-complete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.DRYING) {
    return c.json({ code: 1, message: `当前状态为 ${shade.status}，无法完成干燥（需要 干燥中）` }, 400);
  }
  if (!shade.drying_started_at) {
    return c.json({ code: 1, message: '干燥未启动，请先调用 start-drying' }, 400);
  }

  const { drying_duration_hours } = body;
  if (drying_duration_hours == null || drying_duration_hours <= 0) {
    return c.json({ code: 1, message: '干燥时长必须为正数（小时）' }, 400);
  }

  db.prepare(`
    UPDATE shades SET
      drying_completed_at = ?, drying_duration_hours = ?,
      status = ?, active_process_token = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), drying_duration_hours, STATUS.PENDING_INSPECTION, now(), id);

  logOperation(id, body.operator_id, ACTIONS.COMPLETE_DRYING, STATUS.DRYING, STATUS.PENDING_INSPECTION, { drying_duration_hours });
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id) });
});

process_.post('/shades/:id/inspections', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireInspector(body.inspector_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.PENDING_INSPECTION && shade.status !== STATUS.REWORKING) {
    return c.json({ code: 1, message: '仅待巡检或返修中状态可提交巡检' }, 400);
  }

  const {
    wrinkle_description, wrinkles_found,
    light_uniformity_grade, light_uniformity_score,
    rework_action, final_recommendation, conclusion
  } = body;

  if (!LIGHT_GRADES.includes(light_uniformity_grade)) {
    return c.json({ code: 1, message: '透光等级必须为 A/B/C/D' }, 400);
  }
  if (!['deliver', 'rework', 'suspend'].includes(final_recommendation)) {
    return c.json({ code: 1, message: 'final_recommendation 必须为 deliver/rework/suspend' }, 400);
  }

  const isRework = !!shade.next_inspection_is_rework || shade.status === STATUS.REWORKING;
  const reworkCount = shade.rework_count || 0;

  const tx = db.transaction(() => {
    const inspInfo = db.prepare(`
      INSERT INTO inspections (
        shade_id, inspector_id, inspected_at, is_rework_inspection, rework_count,
        wrinkle_description, wrinkles_found, light_uniformity_grade, light_uniformity_score,
        rework_action, final_recommendation, conclusion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, body.inspector_id, now(), isRework ? 1 : 0, isRework ? reworkCount : 0,
      wrinkle_description || null, wrinkles_found ? 1 : 0,
      light_uniformity_grade, light_uniformity_score ?? null,
      rework_action || null, final_recommendation, conclusion || null
    );

    let nextStatus;
    switch (final_recommendation) {
      case 'deliver':
        nextStatus = STATUS.DELIVERABLE;
        break;
      case 'rework':
        nextStatus = STATUS.REWORKING;
        break;
      case 'suspend':
        nextStatus = STATUS.SUSPENDED;
        break;
    }

    db.prepare(`
      UPDATE shades SET
        last_inspection_id = ?, status = ?, updated_at = ?,
        delivered_at = CASE WHEN ? = ? THEN ? ELSE delivered_at END,
        suspended_at = CASE WHEN ? = ? THEN ? ELSE suspended_at END,
        suspend_reason = CASE WHEN ? = ? THEN ? ELSE suspend_reason END,
        active_process_token = NULL,
        rework_count = CASE WHEN ? = ? THEN rework_count + 1 ELSE rework_count END,
        next_inspection_is_rework = CASE WHEN ? = ? THEN 1 ELSE 0 END
      WHERE id = ?
    `).run(
      inspInfo.lastInsertRowid, nextStatus, now(),
      nextStatus, STATUS.DELIVERABLE, now(),
      nextStatus, STATUS.SUSPENDED, now(),
      nextStatus, STATUS.SUSPENDED, '巡检判定暂停：' + (conclusion || final_recommendation),
      nextStatus, STATUS.REWORKING,
      nextStatus, STATUS.REWORKING,
      id
    );

    return { inspectionId: inspInfo.lastInsertRowid, nextStatus };
  });

  const result = tx();

  logOperation(id, body.inspector_id, ACTIONS.SUBMIT_INSPECTION, shade.status, result.nextStatus, {
    inspection_id: result.inspectionId,
    light_uniformity_grade, wrinkles_found: !!wrinkles_found, final_recommendation, rework_action
  });

  resolveAlertsForShade(id);
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id), inspection_id: result.inspectionId });
});

process_.post('/shades/:id/start-rework', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireAnyStaff(body.operator_id, 'operator_id');
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.PENDING_INSPECTION) {
    return c.json({ code: 1, message: '仅待巡检状态可手动发起返修（巡检不通过时会自动进入返修）' }, 400);
  }
  if (shade.active_process_token) return c.json({ code: 1, message: '该灯罩存在活跃流程' }, 409);

  const token = generateProcessToken();
  db.prepare(`
    UPDATE shades SET
      status = ?, rework_count = rework_count + 1, next_inspection_is_rework = 1,
      active_process_token = ?, updated_at = ?
    WHERE id = ?
  `).run(STATUS.REWORKING, token, now(), id);

  logOperation(id, body.operator_id, ACTIONS.START_REWORK, shade.status, STATUS.REWORKING, { rework_action: body.rework_action });
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id), process_token: token });
});

process_.post('/shades/:id/rework-complete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const shade = db.prepare(`SELECT * FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);

  const auth = requireOperator(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);

  if (shade.status !== STATUS.REWORKING) return c.json({ code: 1, message: '当前不在返修中' }, 400);

  db.prepare(`
    UPDATE shades SET status = ?, active_process_token = NULL, updated_at = ? WHERE id = ?
  `).run(STATUS.PENDING_INSPECTION, now(), id);

  logOperation(id, body.operator_id, 'complete_rework', STATUS.REWORKING, STATUS.PENDING_INSPECTION, body);
  resolveAlertsForShade(id);
  scanAlerts();
  return c.json({ code: 0, data: getShadeById(id) });
});

process_.get('/shades/:id/inspections', (c) => {
  const id = Number(c.req.param('id'));
  const shade = db.prepare(`SELECT id FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);
  return c.json({ code: 0, data: getInspectionsForShade(id) });
});

process_.get('/shades/:id/logs', (c) => {
  const id = Number(c.req.param('id'));
  const shade = db.prepare(`SELECT id FROM shades WHERE id = ?`).get(id);
  if (!shade) return c.json({ code: 1, message: '灯罩不存在' }, 404);
  return c.json({ code: 0, data: getOperationLogs(id) });
});

export default process_;
