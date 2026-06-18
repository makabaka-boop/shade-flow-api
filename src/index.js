import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import admin from './routes/admin.js';
import proc from './routes/process.js';
import query from './routes/query.js';
import { STATUS_LABELS, GRADE_LABELS, WRINKLE_LABELS } from './db/schema.js';

const PORT = parseInt(process.env.PORT || '8118');

const app = new Hono();

app.use('*', cors());

app.get('/', (c) => {
  return c.json({
    name: 'shade-flow-api',
    version: '1.0.0',
    description: '纸艺灯罩工艺管理系统 API',
    port: PORT,
    statuses: STATUS_LABELS,
    grades: GRADE_LABELS,
    wrinkles: WRINKLE_LABELS,
    endpoints: {
      admin: {
        'POST/GET /api/batches': '纸材批次',
        'POST/GET /api/specs': '骨架规格',
        'POST/GET /api/stations': '成型台位',
        'POST/GET /api/workers': '责任人/工艺员',
        'GET/POST /api/inspection-cycles': '巡检周期配置',
        'POST /api/lampshades (admin)': '创建灯罩'
      },
      process: {
        'POST /api/lampshades/:id/start-forming': '开始骨架成型',
        'POST /api/lampshades/:id/forming-record': '提交骨架校正记录',
        'POST /api/lampshades/:id/pasting-record': '提交裱贴记录',
        'POST /api/lampshades/:id/drying-record': '提交干燥记录',
        'POST /api/lampshades/:id/submit-inspection': '提交待巡检',
        'POST /api/lampshades/:id/inspect': '巡检判定',
        'POST /api/lampshades/:id/start-repair': '开始返修',
        'POST /api/lampshades/:id/repair-record': '提交返修动作/结论',
        'POST /api/lampshades/:id/pause': '暂停展示',
        'POST /api/lampshades/:id/resume': '恢复',
        'POST /api/lampshades/:id/deliver': '确认交付',
        'GET /api/lampshades/:id/timeline': '时间线/工艺记录'
      },
      query: {
        'GET /api/lampshades': '组合检索 (batch_id, spec_id, station_id, responsible_id, status, date_from, date_to, light_grade, wrinkle_severity, keyword)',
        'GET /api/lampshades/:id': '灯罩详情',
        'GET /api/dashboard/abnormal-specs': '异常规格排行',
        'GET /api/dashboard/inspection-todos': '巡检待办',
        'GET /api/dashboard/delivery-cycle': '交付周期分布',
        'GET /api/alerts/wrinkle-batches': '褶皱高发批次',
        'GET /api/alerts/overdue-inspections': '巡检超期',
        'GET /api/alerts/repair-no-conclusion': '返修后未提交结论',
        'GET /api/alerts/spec-abnormal-cluster': '同规格异常集中',
        'GET /api/summary': '全局概览'
      }
    }
  });
});

app.route('/api', admin);
app.route('/api', proc);
app.route('/api', query);

app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ code: 500, message: err.message }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n🪔 shade-flow-api running at http://localhost:${info.port}`);
  console.log(`   数据库: data/shade-flow.db`);
  console.log(`   状态定义:`, STATUS_LABELS);
});
