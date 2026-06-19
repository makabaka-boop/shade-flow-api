import { Hono } from 'hono';
import db from '../db.js';
import { validatePerson } from '../utils.js';

const basic = new Hono();

function requireAdmin(operatorId) {
  return validatePerson(operatorId, ['admin'], 'operator_id');
}

basic.get('/paper-batches', (c) => {
  const rows = db.prepare(`SELECT * FROM paper_batches ORDER BY created_at DESC`).all();
  return c.json({ code: 0, data: rows });
});

basic.post('/paper-batches', async (c) => {
  const body = await c.req.json();
  const { batch_no, supplier, received_date, notes, operator_id } = body;
  const auth = requireAdmin(operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  if (!batch_no) return c.json({ code: 1, message: 'batch_no 必填' }, 400);
  try {
    const info = db.prepare(`
      INSERT INTO paper_batches (batch_no, supplier, received_date, notes)
      VALUES (?, ?, ?, ?)
    `).run(batch_no, supplier || null, received_date || null, notes || null);
    return c.json({ code: 0, data: { id: info.lastInsertRowid } });
  } catch (e) {
    return c.json({ code: 1, message: e.message }, 400);
  }
});

basic.put('/paper-batches/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const existing = db.prepare(`SELECT * FROM paper_batches WHERE id = ?`).get(id);
  if (!existing) return c.json({ code: 1, message: '批次不存在' }, 404);
  db.prepare(`
    UPDATE paper_batches SET batch_no = ?, supplier = ?, received_date = ?, notes = ? WHERE id = ?
  `).run(
    body.batch_no ?? existing.batch_no,
    body.supplier ?? existing.supplier,
    body.received_date ?? existing.received_date,
    body.notes ?? existing.notes,
    id
  );
  return c.json({ code: 0, data: db.prepare(`SELECT * FROM paper_batches WHERE id = ?`).get(id) });
});

basic.get('/skeleton-specs', (c) => {
  const rows = db.prepare(`SELECT * FROM skeleton_specs ORDER BY created_at DESC`).all();
  return c.json({ code: 0, data: rows });
});

basic.post('/skeleton-specs', async (c) => {
  const body = await c.req.json();
  const { spec_code, name, dimensions, description, operator_id } = body;
  const auth = requireAdmin(operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  if (!spec_code || !name) return c.json({ code: 1, message: 'spec_code 和 name 必填' }, 400);
  try {
    const info = db.prepare(`
      INSERT INTO skeleton_specs (spec_code, name, dimensions, description)
      VALUES (?, ?, ?, ?)
    `).run(spec_code, name, dimensions || null, description || null);
    return c.json({ code: 0, data: { id: info.lastInsertRowid } });
  } catch (e) {
    return c.json({ code: 1, message: e.message }, 400);
  }
});

basic.put('/skeleton-specs/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const existing = db.prepare(`SELECT * FROM skeleton_specs WHERE id = ?`).get(id);
  if (!existing) return c.json({ code: 1, message: '规格不存在' }, 404);
  db.prepare(`
    UPDATE skeleton_specs SET spec_code = ?, name = ?, dimensions = ?, description = ? WHERE id = ?
  `).run(
    body.spec_code ?? existing.spec_code,
    body.name ?? existing.name,
    body.dimensions ?? existing.dimensions,
    body.description ?? existing.description,
    id
  );
  return c.json({ code: 0, data: db.prepare(`SELECT * FROM skeleton_specs WHERE id = ?`).get(id) });
});

basic.get('/stations', (c) => {
  const onlyActive = c.req.query('active') === '1';
  const sql = onlyActive
    ? `SELECT * FROM stations WHERE active = 1 ORDER BY station_code`
    : `SELECT * FROM stations ORDER BY station_code`;
  return c.json({ code: 0, data: db.prepare(sql).all() });
});

basic.post('/stations', async (c) => {
  const body = await c.req.json();
  const { station_code, name, location, operator_id } = body;
  const auth = requireAdmin(operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  if (!station_code || !name) return c.json({ code: 1, message: 'station_code 和 name 必填' }, 400);
  try {
    const info = db.prepare(`
      INSERT INTO stations (station_code, name, location) VALUES (?, ?, ?)
    `).run(station_code, name, location || null);
    return c.json({ code: 0, data: { id: info.lastInsertRowid } });
  } catch (e) {
    return c.json({ code: 1, message: e.message }, 400);
  }
});

basic.put('/stations/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const existing = db.prepare(`SELECT * FROM stations WHERE id = ?`).get(id);
  if (!existing) return c.json({ code: 1, message: '台位不存在' }, 404);
  db.prepare(`
    UPDATE stations SET station_code = ?, name = ?, location = ?, active = ? WHERE id = ?
  `).run(
    body.station_code ?? existing.station_code,
    body.name ?? existing.name,
    body.location ?? existing.location,
    body.active ?? existing.active,
    id
  );
  return c.json({ code: 0, data: db.prepare(`SELECT * FROM stations WHERE id = ?`).get(id) });
});

basic.get('/persons', (c) => {
  const role = c.req.query('role');
  const onlyActive = c.req.query('active') === '1';
  let sql = `SELECT * FROM persons WHERE 1=1`;
  const params = [];
  if (role) { sql += ` AND role = ?`; params.push(role); }
  if (onlyActive) { sql += ` AND active = 1`; }
  sql += ` ORDER BY employee_no`;
  return c.json({ code: 0, data: db.prepare(sql).all(...params) });
});

basic.post('/persons', async (c) => {
  const body = await c.req.json();
  const { employee_no, name, role, operator_id } = body;
  const auth = requireAdmin(operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  if (!employee_no || !name || !role) return c.json({ code: 1, message: 'employee_no, name, role 必填' }, 400);
  if (!['admin', 'operator', 'inspector'].includes(role)) {
    return c.json({ code: 1, message: 'role 必须是 admin/operator/inspector' }, 400);
  }
  try {
    const info = db.prepare(`
      INSERT INTO persons (employee_no, name, role) VALUES (?, ?, ?)
    `).run(employee_no, name, role);
    return c.json({ code: 0, data: { id: info.lastInsertRowid } });
  } catch (e) {
    return c.json({ code: 1, message: e.message }, 400);
  }
});

basic.put('/persons/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const auth = requireAdmin(body.operator_id);
  if (auth.error) return c.json({ code: 1, message: auth.error }, 403);
  const existing = db.prepare(`SELECT * FROM persons WHERE id = ?`).get(id);
  if (!existing) return c.json({ code: 1, message: '人员不存在' }, 404);
  db.prepare(`
    UPDATE persons SET employee_no = ?, name = ?, role = ?, active = ? WHERE id = ?
  `).run(
    body.employee_no ?? existing.employee_no,
    body.name ?? existing.name,
    body.role ?? existing.role,
    body.active ?? existing.active,
    id
  );
  return c.json({ code: 0, data: db.prepare(`SELECT * FROM persons WHERE id = ?`).get(id) });
});

export default basic;
