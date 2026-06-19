import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import db from './db/index.js';
import masterRoutes from './routes/master.js';
import processRoutes from './routes/process.js';
import queryRoutes from './routes/query.js';

const app = new Hono();

app.use('*', cors());

app.get('/', (c) => {
  return c.json({
    name: 'shade-flow-api',
    version: '1.0.0',
    status: 'running',
    port: 8118
  });
});

app.route('/api/master', masterRoutes);
app.route('/api/process', processRoutes);
app.route('/api/query', queryRoutes);

app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({ code: 500, message: err.message }, 500);
});

const port = 8118;
console.log(`shade-flow-api starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port
});

console.log(`Server running at http://localhost:${port}`);
