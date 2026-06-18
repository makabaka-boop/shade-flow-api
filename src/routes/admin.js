import { Hono } from 'hono';
import { db } from '../db.js';

const admin = new Hono();

function crud(table, fields, uniqueField) {
  const r = new Hono();

  r.get('/', (c) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
    return c.json({ data: rows });
  });

  r.get('/:id', (c) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(c.req.param('id'));
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ data: row });
  });

  r.post('/', async (c) => {
    const body = await c.req.json();
    if (uniqueField && !body[uniqueField]) {
      return c.json({ error: `${uniqueField} 必填` }, 400);
    }
    const cols = fields.filter((f) => body[f] !== undefined);
    const placeholders = cols.map(() => '?').join(',');
    const values = cols.map((f) => body[f]);
    try {
      const info = db
        .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`)
        .run(...values);
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
      return c.json({ data: row }, 201);
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });

  r.put('/:id', async (c) => {
    const body = await c.req.json();
    const cols = fields.filter((f) => body[f] !== undefined);
    if (cols.length === 0) return c.json({ error: '无更新字段' }, 400);
    const sets = cols.map((f) => `${f} = ?`).join(',');
    const values = cols.map((f) => body[f]);
    values.push(c.req.param('id'));
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(c.req.param('id'));
    return c.json({ data: row });
  });

  r.delete('/:id', (c) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(c.req.param('id'));
    return c.json({ ok: true });
  });

  return r;
}

admin.route('/paper-batches', crud('paper_batch', ['batch_no', 'material', 'supplier', 'arrived_at', 'remark'], 'batch_no'));
admin.route('/frame-specs', crud('frame_spec', ['spec_code', 'shape', 'diameter_mm', 'height_mm', 'wire_gauge', 'remark'], 'spec_code'));
admin.route('/stations', crud('station', ['code', 'name', 'location', 'active'], 'code'));
admin.route('/workers', crud('worker', ['employee_no', 'name', 'role', 'phone', 'active'], 'employee_no'));

export default admin;
