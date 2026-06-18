import { Hono } from 'hono';
import db from '../db/index.js';

const process = new Hono();

const getActiveFlow = (shadeId) => {
  return db.prepare('SELECT * FROM process_flows WHERE shade_id = ? AND is_active = 1').get(shadeId);
};

const updateShadeStatus = (shadeId, status) => {
  db.prepare(`UPDATE lampshades SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(status, shadeId);
};

process.post('/flows/start', async (c) => {
  const body = await c.req.json();
  const { shade_id } = body;
  if (!shade_id) return c.json({ code: 400, message: '灯罩ID必填' }, 400);
  
  const shade = db.prepare('SELECT * FROM lampshades WHERE id = ?').get(shade_id);
  if (!shade) return c.json({ code: 404, message: '灯罩不存在' }, 404);
  
  const active = getActiveFlow(shade_id);
  if (active) return c.json({ code: 409, message: '该灯罩已有活跃流程，无法重复启动' }, 409);
  
  if (!['pending_forming', 'deliverable'].includes(shade.status) && shade.status !== 'suspended') {
    return c.json({ code: 400, message: `当前状态(${shade.status})无法启动新流程` }, 400);
  }

  const txn = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO process_flows (shade_id, started_at) VALUES (?, datetime('now', 'localtime'))
    `).run(shade_id);
    const flowId = info.lastInsertRowid;
    db.prepare('UPDATE lampshades SET current_flow_id = ?, started_at = datetime(\'now\', \'localtime\'), status = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?')
      .run(flowId, 'forming', shade_id);
    return flowId;
  });
  
  const flowId = txn();
  return c.json({ code: 0, data: { flow_id: flowId } });
});

process.post('/forming', async (c) => {
  const body = await c.req.json();
  const { flow_id, operator_id, correction_notes, correction_applied } = body;
  if (!flow_id) return c.json({ code: 400, message: '流程ID必填' }, 400);
  
  const flow = db.prepare('SELECT * FROM process_flows WHERE id = ?').get(flow_id);
  if (!flow) return c.json({ code: 404, message: '流程不存在' }, 404);
  if (!flow.is_active) return c.json({ code: 400, message: '流程已结束' }, 400);
  
  const existing = db.prepare('SELECT id FROM forming_records WHERE flow_id = ?').get(flow_id);
  if (existing) return c.json({ code: 409, message: '该流程已有成型记录' }, 409);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO forming_records (flow_id, operator_id, correction_notes, correction_applied, formed_at)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    `).run(flow_id, operator_id, correction_notes, correction_applied ? 1 : 0);
    updateShadeStatus(flow.shade_id, 'forming');
  });
  txn();
  return c.json({ code: 0 });
});

process.post('/mounting', async (c) => {
  const body = await c.req.json();
  const { flow_id, operator_id, layer_count, wrinkle_notes, has_wrinkle } = body;
  if (!flow_id || !layer_count) return c.json({ code: 400, message: '流程ID和裱贴层数必填' }, 400);
  
  const flow = db.prepare('SELECT * FROM process_flows WHERE id = ?').get(flow_id);
  if (!flow) return c.json({ code: 404, message: '流程不存在' }, 404);
  if (!flow.is_active) return c.json({ code: 400, message: '流程已结束' }, 400);
  
  const forming = db.prepare('SELECT id FROM forming_records WHERE flow_id = ?').get(flow_id);
  if (!forming) return c.json({ code: 400, message: '请先完成骨架成型记录' }, 400);

  db.prepare(`
    INSERT INTO mounting_records (flow_id, operator_id, layer_count, wrinkle_notes, has_wrinkle, mounted_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
  `).run(flow_id, operator_id, layer_count, wrinkle_notes, has_wrinkle ? 1 : 0);
  
  return c.json({ code: 0 });
});

process.post('/drying', async (c) => {
  const body = await c.req.json();
  const { flow_id, operator_id, duration_hours, temperature, humidity } = body;
  if (!flow_id || !duration_hours) return c.json({ code: 400, message: '流程ID和干燥时长必填' }, 400);
  
  const flow = db.prepare('SELECT * FROM process_flows WHERE id = ?').get(flow_id);
  if (!flow) return c.json({ code: 404, message: '流程不存在' }, 404);
  if (!flow.is_active) return c.json({ code: 400, message: '流程已结束' }, 400);
  
  const mounting = db.prepare('SELECT id FROM mounting_records WHERE flow_id = ?').get(flow_id);
  if (!mounting) return c.json({ code: 400, message: '请先完成裱贴记录' }, 400);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO drying_records (flow_id, operator_id, duration_hours, temperature, humidity, dried_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `).run(flow_id, operator_id, duration_hours, temperature, humidity);
    
    const shade = db.prepare('SELECT inspection_cycle_hours FROM lampshades WHERE id = ?').get(flow.shade_id);
    const nextInsp = new Date(Date.now() + shade.inspection_cycle_hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    
    db.prepare(`
      INSERT INTO inspection_records (flow_id, light_uniformity, conclusion, inspected_at, next_inspection_at)
      VALUES (?, 0, 'pending', datetime('now', 'localtime'), ?)
    `).run(flow_id, nextInsp);
    
    updateShadeStatus(flow.shade_id, 'pending_inspection');
  });
  txn();
  
  return c.json({ code: 0 });
});

process.post('/inspection', async (c) => {
  const body = await c.req.json();
  const { flow_id, operator_id, light_uniformity, wrinkle_severity, conclusion, rework_action, final_recommendation, inspector_note } = body;
  if (!flow_id || light_uniformity === undefined || !conclusion) {
    return c.json({ code: 400, message: '流程ID、透光均匀度和结论必填' }, 400);
  }
  if (!['pass', 'rework', 'reject', 'pending'].includes(conclusion)) {
    return c.json({ code: 400, message: '结论必须是pass/rework/reject/pending' }, 400);
  }
  
  const flow = db.prepare('SELECT * FROM process_flows WHERE id = ?').get(flow_id);
  if (!flow) return c.json({ code: 404, message: '流程不存在' }, 404);
  if (!flow.is_active) return c.json({ code: 400, message: '流程已结束' }, 400);
  
  const drying = db.prepare('SELECT id FROM drying_records WHERE flow_id = ?').get(flow_id);
  if (!drying) return c.json({ code: 400, message: '请先完成干燥记录' }, 400);

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE inspection_records 
      SET operator_id=?, light_uniformity=?, wrinkle_severity=?, conclusion=?, rework_action=?, 
          final_recommendation=?, inspector_note=?, inspected_at=datetime('now', 'localtime'),
          next_inspection_at=NULL
      WHERE flow_id = ? AND conclusion = 'pending'
    `).run(operator_id, light_uniformity, wrinkle_severity || 0, conclusion, rework_action, 
          final_recommendation, inspector_note, flow_id);
    
    let newStatus = 'pending_inspection';
    if (conclusion === 'pass') newStatus = 'deliverable';
    else if (conclusion === 'rework') newStatus = 'reworking';
    else if (conclusion === 'reject') newStatus = 'suspended';
    
    if (conclusion === 'pass' || conclusion === 'reject') {
      db.prepare('UPDATE process_flows SET is_active = 0, ended_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(flow_id);
      if (conclusion === 'pass') {
        db.prepare('UPDATE lampshades SET delivered_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(flow.shade_id);
      }
    }
    updateShadeStatus(flow.shade_id, newStatus);
  });
  txn();
  
  return c.json({ code: 0 });
});

process.post('/rework', async (c) => {
  const body = await c.req.json();
  const { flow_id, operator_id, rework_type, action_detail, result, completed } = body;
  if (!flow_id || !rework_type || !action_detail) {
    return c.json({ code: 400, message: '流程ID、返修类型和动作详情必填' }, 400);
  }
  
  const flow = db.prepare('SELECT * FROM process_flows WHERE id = ?').get(flow_id);
  if (!flow) return c.json({ code: 404, message: '流程不存在' }, 404);
  if (!flow.is_active) return c.json({ code: 400, message: '流程已结束' }, 400);

  const txn = db.transaction(() => {
    if (completed) {
      db.prepare(`
        INSERT INTO rework_records (flow_id, operator_id, rework_type, action_detail, result, completed, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, datetime('now', 'localtime'), datetime('now', 'localtime'))
      `).run(flow_id, operator_id, rework_type, action_detail, result);
      updateShadeStatus(flow.shade_id, 'pending_inspection');
      
      const shade = db.prepare('SELECT inspection_cycle_hours FROM lampshades WHERE id = ?').get(flow.shade_id);
      const nextInsp = new Date(Date.now() + shade.inspection_cycle_hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`
        INSERT INTO inspection_records (flow_id, light_uniformity, conclusion, inspected_at, next_inspection_at)
        VALUES (?, 0, 'pending', datetime('now', 'localtime'), ?)
      `).run(flow_id, nextInsp);
    } else {
      db.prepare(`
        INSERT INTO rework_records (flow_id, operator_id, rework_type, action_detail, result, completed, created_at)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))
      `).run(flow_id, operator_id, rework_type, action_detail, result);
      updateShadeStatus(flow.shade_id, 'reworking');
    }
  });
  txn();
  
  return c.json({ code: 0 });
});

process.post('/suspend/:shadeId', async (c) => {
  const shadeId = c.req.param('shadeId');
  const shade = db.prepare('SELECT * FROM lampshades WHERE id = ?').get(shadeId);
  if (!shade) return c.json({ code: 404, message: '灯罩不存在' }, 404);
  if (shade.status === 'suspended') return c.json({ code: 400, message: '灯罩已是暂停状态' }, 400);
  
  db.prepare(`UPDATE lampshades SET pre_suspend_status = status, status = 'suspended', updated_at = datetime('now', 'localtime') WHERE id = ?`).run(shadeId);
  return c.json({ code: 0 });
});

process.post('/resume/:shadeId', async (c) => {
  const shadeId = c.req.param('shadeId');
  const shade = db.prepare('SELECT * FROM lampshades WHERE id = ?').get(shadeId);
  if (!shade) return c.json({ code: 404, message: '灯罩不存在' }, 404);
  if (shade.status !== 'suspended') return c.json({ code: 400, message: '仅暂停状态可恢复' }, 400);
  
  const resumeStatus = shade.pre_suspend_status || 'pending_forming';
  db.prepare(`UPDATE lampshades SET status = ?, pre_suspend_status = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(resumeStatus, shadeId);
  return c.json({ code: 0, data: { resumed_status: resumeStatus } });
});

process.get('/flows/:shadeId', (c) => {
  const shadeId = c.req.param('shadeId');
  const flows = db.prepare(`
    SELECT pf.*,
      (SELECT json_group_array(json_object(
        'id', fr.id, 'operator_id', fr.operator_id, 'correction_notes', fr.correction_notes,
        'correction_applied', fr.correction_applied, 'formed_at', fr.formed_at
      )) FROM forming_records fr WHERE fr.flow_id = pf.id) as forming,
      (SELECT json_group_array(json_object(
        'id', mr.id, 'operator_id', mr.operator_id, 'layer_count', mr.layer_count,
        'wrinkle_notes', mr.wrinkle_notes, 'has_wrinkle', mr.has_wrinkle, 'mounted_at', mr.mounted_at
      )) FROM mounting_records mr WHERE mr.flow_id = pf.id) as mounting,
      (SELECT json_group_array(json_object(
        'id', dr.id, 'operator_id', dr.operator_id, 'duration_hours', dr.duration_hours,
        'temperature', dr.temperature, 'humidity', dr.humidity, 'dried_at', dr.dried_at
      )) FROM drying_records dr WHERE dr.flow_id = pf.id) as drying,
      (SELECT json_group_array(json_object(
        'id', ir.id, 'operator_id', ir.operator_id, 'light_uniformity', ir.light_uniformity,
        'wrinkle_severity', ir.wrinkle_severity, 'conclusion', ir.conclusion,
        'rework_action', ir.rework_action, 'final_recommendation', ir.final_recommendation,
        'inspected_at', ir.inspected_at, 'next_inspection_at', ir.next_inspection_at
      )) FROM inspection_records ir WHERE ir.flow_id = pf.id) as inspections,
      (SELECT json_group_array(json_object(
        'id', rr.id, 'operator_id', rr.operator_id, 'rework_type', rr.rework_type,
        'action_detail', rr.action_detail, 'result', rr.result, 'completed', rr.completed,
        'completed_at', rr.completed_at
      )) FROM rework_records rr WHERE rr.flow_id = pf.id) as reworks
    FROM process_flows pf WHERE pf.shade_id = ? ORDER BY pf.started_at DESC
  `).all(shadeId);
  
  const data = flows.map(f => ({
    ...f,
    forming: JSON.parse(f.forming || '[]'),
    mounting: JSON.parse(f.mounting || '[]'),
    drying: JSON.parse(f.drying || '[]'),
    inspections: JSON.parse(f.inspections || '[]'),
    reworks: JSON.parse(f.reworks || '[]')
  }));
  
  return c.json({ code: 0, data });
});

process.get('/active', (c) => {
  const rows = db.prepare(`
    SELECT l.id as shade_id, l.shade_code, l.status, l.inspection_cycle_hours,
      pf.id as flow_id, pf.started_at,
      op.name as responsible_name,
      ss.spec_code as skeleton_spec_code,
      pb.batch_code as paper_batch_code,
      ws.station_code as workstation_code
    FROM lampshades l
    JOIN process_flows pf ON l.current_flow_id = pf.id AND pf.is_active = 1
    LEFT JOIN operators op ON l.responsible_id = op.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    LEFT JOIN workstations ws ON l.workstation_id = ws.id
    ORDER BY pf.started_at
  `).all();
  return c.json({ code: 0, data: rows });
});

export default process;
