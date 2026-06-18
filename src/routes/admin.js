import { Hono } from 'hono';
import db, { now } from '../db/index.js';

const admin = new Hono();

function crudRoutes(path, table, requiredFields = [], searchableFields = []) {
  const r = new Hono();

  r.get('/', (c) => {
    const { search = '', page = '1', pageSize = '50' } = c.req.query();
    const p = Math.max(1, parseInt(page));
    const ps = Math.min(200, Math.max(1, parseInt(pageSize)));
    const offset = (p - 1) * ps;

    let where = '';
    const params = {};
    if (search && searchableFields.length) {
      where = 'WHERE ' + searchableFields.map(f => `${f} LIKE @search`).join(' OR ');
      params.search = `%${search}%`;
    }

    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get(params);
    const rows = db.prepare(`SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({
      ...params, limit: ps, offset
    });

    return c.json({ code: 0, data: rows, total: countRow.c, page: p, pageSize: ps });
  });

  r.get('/:id', (c) => {
    const id = parseInt(c.req.param('id'));
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) return c.json({ code: 404, message: 'not found' }, 404);
    return c.json({ code: 0, data: row });
  });

  r.post('/', async (c) => {
    const body = await c.req.json();
    const fields = Object.keys(body);
    if (requiredFields.length) {
      for (const f of requiredFields) {
        if (body[f] === undefined || body[f] === null || body[f] === '') {
          return c.json({ code: 400, message: `missing field: ${f}` }, 400);
        }
      }
    }
    const ts = now();
    body.created_at = ts;
    body.updated_at = ts;
    const cols = Object.keys(body).join(',');
    const placeholders = Object.keys(body).map(k => `@${k}`).join(',');
    try {
      const info = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(body);
      return c.json({ code: 0, data: { id: info.lastInsertRowid, ...body } }, 201);
    } catch (e) {
      return c.json({ code: 500, message: e.message }, 400);
    }
  });

  r.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    body.updated_at = now();
    delete body.id;
    delete body.created_at;
    const sets = Object.keys(body).map(k => `${k}=@${k}`).join(',');
    try {
      const info = db.prepare(`UPDATE ${table} SET ${sets} WHERE id=@id`).run({ ...body, id });
      if (info.changes === 0) return c.json({ code: 404, message: 'not found' }, 404);
      return c.json({ code: 0, data: { id, ...body } });
    } catch (e) {
      return c.json({ code: 500, message: e.message }, 400);
    }
  });

  r.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'));
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      if (info.changes === 0) return c.json({ code: 404, message: 'not found' }, 404);
      return c.json({ code: 0, message: 'deleted' });
    } catch (e) {
      return c.json({ code: 500, message: e.message }, 400);
    }
  });

  admin.route(path, r);
}

crudRoutes('/batches', 'paper_batches', ['batch_no'], ['batch_no', 'supplier', 'notes']);
crudRoutes('/specs', 'skeleton_specs', ['spec_code', 'name'], ['spec_code', 'name', 'material', 'notes']);
crudRoutes('/stations', 'stations', ['station_code', 'name'], ['station_code', 'name', 'location']);
crudRoutes('/workers', 'workers', ['worker_code', 'name', 'role'], ['worker_code', 'name', 'phone']);

admin.get('/inspection-cycles', (c) => {
  const rows = db.prepare(`
    SELECT ic.*, ss.spec_code, ss.name AS spec_name
    FROM inspection_cycles ic
    JOIN skeleton_specs ss ON ss.id = ic.spec_id
    ORDER BY ic.id DESC
  `).all();
  return c.json({ code: 0, data: rows });
});

admin.post('/inspection-cycles', async (c) => {
  const body = await c.req.json();
  if (!body.spec_id || !body.cycle_hours) {
    return c.json({ code: 400, message: 'spec_id and cycle_hours required' }, 400);
  }
  const ts = now();
  try {
    const info = db.prepare(`
      INSERT INTO inspection_cycles (spec_id, cycle_hours, created_at, updated_at)
      VALUES (@spec_id, @cycle_hours, @ts, @ts)
      ON CONFLICT(spec_id) DO UPDATE SET cycle_hours=@cycle_hours, updated_at=@ts
    `).run({ spec_id: body.spec_id, cycle_hours: body.cycle_hours, ts });
    return c.json({ code: 0, data: { id: info.lastInsertRowid, ...body } });
  } catch (e) {
    return c.json({ code: 500, message: e.message }, 400);
  }
});

admin.post('/lampshades', async (c) => {
  const body = await c.req.json();
  const required = ['shade_no', 'batch_id', 'spec_id', 'station_id', 'responsible_id'];
  for (const f of required) {
    if (!body[f]) return c.json({ code: 400, message: `missing field: ${f}` }, 400);
  }
  try {
    const existing = db.prepare('SELECT id, status FROM lampshades WHERE shade_no=?').get(body.shade_no);
    if (existing) {
      return c.json({ code: 409, message: `灯罩编号已存在，当前状态: ${existing.status}` }, 409);
    }
    const batch = db.prepare('SELECT id FROM paper_batches WHERE id=?').get(body.batch_id);
    if (!batch) return c.json({ code: 400, message: '纸材批次不存在' }, 400);
    const spec = db.prepare('SELECT id FROM skeleton_specs WHERE id=?').get(body.spec_id);
    if (!spec) return c.json({ code: 400, message: '骨架规格不存在' }, 400);
    const station = db.prepare('SELECT id FROM stations WHERE id=?').get(body.station_id);
    if (!station) return c.json({ code: 400, message: '成型台位不存在' }, 400);
    const worker = db.prepare('SELECT id FROM workers WHERE id=?').get(body.responsible_id);
    if (!worker) return c.json({ code: 400, message: '责任人不存在' }, 400);

    const ts = now();
    const info = db.prepare(`
      INSERT INTO lampshades (shade_no, batch_id, spec_id, station_id, responsible_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending_forming', ?, ?)
    `).run(body.shade_no, body.batch_id, body.spec_id, body.station_id, body.responsible_id, ts, ts);

    return c.json({ code: 0, data: { id: info.lastInsertRowid, shade_no: body.shade_no, status: 'pending_forming' } }, 201);
  } catch (e) {
    return c.json({ code: 500, message: e.message }, 400);
  }
});

export default admin;
