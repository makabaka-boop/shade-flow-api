import { Hono } from 'hono';
import db from '../db/index.js';

const master = new Hono();

const VALID_STATUSES = ['pending_forming', 'forming', 'pending_inspection', 'reworking', 'deliverable', 'suspended'];

master.get('/paper-batches', (c) => {
  const rows = db.prepare(`
    SELECT pb.*, 
      (SELECT COUNT(*) FROM lampshades l WHERE l.paper_batch_id = pb.id) as shade_count
    FROM paper_batches pb ORDER BY pb.created_at DESC
  `).all();
  return c.json({ code: 0, data: rows });
});

master.post('/paper-batches', async (c) => {
  const body = await c.req.json();
  const { batch_code, supplier, paper_type, gram_weight, received_date, remark } = body;
  if (!batch_code || !received_date) {
    return c.json({ code: 400, message: '批次编号和收货日期必填' }, 400);
  }
  const exists = db.prepare('SELECT id FROM paper_batches WHERE batch_code = ?').get(batch_code);
  if (exists) return c.json({ code: 409, message: '批次编号已存在' }, 409);
  const info = db.prepare(`
    INSERT INTO paper_batches (batch_code, supplier, paper_type, gram_weight, received_date, remark)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(batch_code, supplier, paper_type, gram_weight, received_date, remark);
  return c.json({ code: 0, data: { id: info.lastInsertRowid } });
});

master.put('/paper-batches/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = [];
  const params = [];
  const allowed = ['batch_code', 'supplier', 'paper_type', 'gram_weight', 'received_date', 'remark'];
  for (const f of allowed) {
    if (body[f] !== undefined) { fields.push(`${f}=?`); params.push(body[f]); }
  }
  if (fields.length) {
    params.push(id);
    db.prepare(`UPDATE paper_batches SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  return c.json({ code: 0 });
});

master.delete('/paper-batches/:id', (c) => {
  const id = c.req.param('id');
  const used = db.prepare('SELECT COUNT(*) as cnt FROM lampshades WHERE paper_batch_id = ?').get(id);
  if (used.cnt > 0) return c.json({ code: 400, message: '该批次已有灯罩关联，无法删除' }, 400);
  db.prepare('DELETE FROM paper_batches WHERE id = ?').run(id);
  return c.json({ code: 0 });
});

master.get('/skeleton-specs', (c) => {
  const rows = db.prepare(`
    SELECT ss.*,
      (SELECT COUNT(*) FROM lampshades l WHERE l.skeleton_spec_id = ss.id) as shade_count
    FROM skeleton_specs ss ORDER BY ss.created_at DESC
  `).all();
  return c.json({ code: 0, data: rows });
});

master.post('/skeleton-specs', async (c) => {
  const body = await c.req.json();
  const { spec_code, name, diameter, height, rib_count, material, remark } = body;
  if (!spec_code || !name) return c.json({ code: 400, message: '规格编码和名称必填' }, 400);
  const exists = db.prepare('SELECT id FROM skeleton_specs WHERE spec_code = ?').get(spec_code);
  if (exists) return c.json({ code: 409, message: '规格编码已存在' }, 409);
  const info = db.prepare(`
    INSERT INTO skeleton_specs (spec_code, name, diameter, height, rib_count, material, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(spec_code, name, diameter, height, rib_count, material, remark);
  return c.json({ code: 0, data: { id: info.lastInsertRowid } });
});

master.put('/skeleton-specs/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = [];
  const params = [];
  const allowed = ['spec_code', 'name', 'diameter', 'height', 'rib_count', 'material', 'remark'];
  for (const f of allowed) {
    if (body[f] !== undefined) { fields.push(`${f}=?`); params.push(body[f]); }
  }
  if (fields.length) {
    params.push(id);
    db.prepare(`UPDATE skeleton_specs SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  return c.json({ code: 0 });
});

master.delete('/skeleton-specs/:id', (c) => {
  const id = c.req.param('id');
  const used = db.prepare('SELECT COUNT(*) as cnt FROM lampshades WHERE skeleton_spec_id = ?').get(id);
  if (used.cnt > 0) return c.json({ code: 400, message: '该规格已有灯罩关联，无法删除' }, 400);
  db.prepare('DELETE FROM skeleton_specs WHERE id = ?').run(id);
  return c.json({ code: 0 });
});

master.get('/workstations', (c) => {
  const rows = db.prepare('SELECT * FROM workstations ORDER BY station_code').all();
  return c.json({ code: 0, data: rows });
});

master.post('/workstations', async (c) => {
  const body = await c.req.json();
  const { station_code, name, location, status } = body;
  if (!station_code || !name) return c.json({ code: 400, message: '台位编号和名称必填' }, 400);
  const exists = db.prepare('SELECT id FROM workstations WHERE station_code = ?').get(station_code);
  if (exists) return c.json({ code: 409, message: '台位编号已存在' }, 409);
  const info = db.prepare(`
    INSERT INTO workstations (station_code, name, location, status) VALUES (?, ?, ?, ?)
  `).run(station_code, name, location, status || 'active');
  return c.json({ code: 0, data: { id: info.lastInsertRowid } });
});

master.put('/workstations/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = [];
  const params = [];
  const allowed = ['station_code', 'name', 'location', 'status'];
  for (const f of allowed) {
    if (body[f] !== undefined) { fields.push(`${f}=?`); params.push(body[f]); }
  }
  if (fields.length) {
    params.push(id);
    db.prepare(`UPDATE workstations SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  return c.json({ code: 0 });
});

master.delete('/workstations/:id', (c) => {
  const id = c.req.param('id');
  const used = db.prepare('SELECT COUNT(*) as cnt FROM lampshades WHERE workstation_id = ?').get(id);
  if (used.cnt > 0) return c.json({ code: 400, message: '该台位已有灯罩关联，无法删除' }, 400);
  db.prepare('DELETE FROM workstations WHERE id = ?').run(id);
  return c.json({ code: 0 });
});

master.get('/operators', (c) => {
  const { role } = c.req.query();
  let sql = 'SELECT * FROM operators';
  const params = [];
  if (role) { sql += ' WHERE role = ?'; params.push(role); }
  sql += ' ORDER BY employee_no';
  return c.json({ code: 0, data: db.prepare(sql).all(...params) });
});

master.post('/operators', async (c) => {
  const body = await c.req.json();
  const { employee_no, name, role, phone, status } = body;
  if (!employee_no || !name || !role) return c.json({ code: 400, message: '工号、姓名和角色必填' }, 400);
  if (!['admin', 'technician'].includes(role)) return c.json({ code: 400, message: '角色必须是admin或technician' }, 400);
  const exists = db.prepare('SELECT id FROM operators WHERE employee_no = ?').get(employee_no);
  if (exists) return c.json({ code: 409, message: '工号已存在' }, 409);
  const info = db.prepare(`
    INSERT INTO operators (employee_no, name, role, phone, status) VALUES (?, ?, ?, ?, ?)
  `).run(employee_no, name, role, phone, status || 'active');
  return c.json({ code: 0, data: { id: info.lastInsertRowid } });
});

master.put('/operators/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (body.role && !['admin', 'technician'].includes(body.role)) {
    return c.json({ code: 400, message: '角色必须是admin或technician' }, 400);
  }
  const fields = [];
  const params = [];
  const allowed = ['employee_no', 'name', 'role', 'phone', 'status'];
  for (const f of allowed) {
    if (body[f] !== undefined) { fields.push(`${f}=?`); params.push(body[f]); }
  }
  if (fields.length) {
    params.push(id);
    db.prepare(`UPDATE operators SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  return c.json({ code: 0 });
});

master.delete('/operators/:id', (c) => {
  const id = c.req.param('id');
  const used = db.prepare('SELECT COUNT(*) as cnt FROM lampshades WHERE responsible_id = ?').get(id);
  if (used.cnt > 0) return c.json({ code: 400, message: '该人员已有灯罩关联，无法删除' }, 400);
  db.prepare('DELETE FROM operators WHERE id = ?').run(id);
  return c.json({ code: 0 });
});

master.get('/lampshades', (c) => {
  const rows = db.prepare(`
    SELECT l.*, 
      pb.batch_code as paper_batch_code,
      ss.spec_code as skeleton_spec_code,
      ss.name as skeleton_spec_name,
      ws.station_code as workstation_code,
      ws.name as workstation_name,
      op.name as responsible_name,
      op.employee_no as responsible_no
    FROM lampshades l
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN workstations ws ON l.workstation_id = ws.id
    LEFT JOIN operators op ON l.responsible_id = op.id
    ORDER BY l.created_at DESC
  `).all();
  return c.json({ code: 0, data: rows });
});

master.get('/lampshades/:id', (c) => {
  const id = c.req.param('id');
  const row = db.prepare(`
    SELECT l.*, 
      pb.batch_code as paper_batch_code,
      ss.spec_code as skeleton_spec_code,
      ss.name as skeleton_spec_name,
      ws.station_code as workstation_code,
      ws.name as workstation_name,
      op.name as responsible_name,
      op.employee_no as responsible_no
    FROM lampshades l
    LEFT JOIN paper_batches pb ON l.paper_batch_id = pb.id
    LEFT JOIN skeleton_specs ss ON l.skeleton_spec_id = ss.id
    LEFT JOIN workstations ws ON l.workstation_id = ws.id
    LEFT JOIN operators op ON l.responsible_id = op.id
    WHERE l.id = ?
  `).get(id);
  if (!row) return c.json({ code: 404, message: '灯罩不存在' }, 404);
  return c.json({ code: 0, data: row });
});

master.post('/lampshades', async (c) => {
  const body = await c.req.json();
  const { shade_code, paper_batch_id, skeleton_spec_id, workstation_id, responsible_id, inspection_cycle_hours, remark } = body;
  if (!shade_code) return c.json({ code: 400, message: '灯罩编号必填' }, 400);
  const exists = db.prepare('SELECT id FROM lampshades WHERE shade_code = ?').get(shade_code);
  if (exists) return c.json({ code: 409, message: '灯罩编号已存在' }, 409);
  const info = db.prepare(`
    INSERT INTO lampshades (shade_code, paper_batch_id, skeleton_spec_id, workstation_id, responsible_id, inspection_cycle_hours, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(shade_code, paper_batch_id, skeleton_spec_id, workstation_id, responsible_id, inspection_cycle_hours || 24, remark);
  return c.json({ code: 0, data: { id: info.lastInsertRowid } });
});

master.put('/lampshades/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const current = db.prepare('SELECT * FROM lampshades WHERE id = ?').get(id);
  if (!current) return c.json({ code: 404, message: '灯罩不存在' }, 404);
  
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return c.json({ code: 400, message: '无效状态' }, 400);
  }

  const fields = [];
  const params = [];
  const allowedFields = ['shade_code', 'paper_batch_id', 'skeleton_spec_id', 'workstation_id', 
                         'responsible_id', 'inspection_cycle_hours', 'status', 'remark'];
  
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      fields.push(`${field} = ?`);
      params.push(body[field]);
    }
  }
  
  if (fields.length === 0) return c.json({ code: 0 });
  
  fields.push(`updated_at = datetime('now', 'localtime')`);
  params.push(id);
  
  db.prepare(`UPDATE lampshades SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return c.json({ code: 0 });
});

master.delete('/lampshades/:id', (c) => {
  const id = c.req.param('id');
  const hasFlow = db.prepare('SELECT COUNT(*) as cnt FROM process_flows WHERE shade_id = ?').get(id);
  if (hasFlow.cnt > 0) return c.json({ code: 400, message: '该灯罩已有流程记录，无法删除' }, 400);
  db.prepare('DELETE FROM lampshades WHERE id = ?').run(id);
  return c.json({ code: 0 });
});

export default master;
