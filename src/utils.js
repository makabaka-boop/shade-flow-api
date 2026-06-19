import db from './db.js';
import { STATUS, ALERT_TYPES, STATUS_LABELS } from './constants.js';

const ROLE_LABELS = { admin: '管理员', operator: '工艺员', inspector: '巡检员' };

export function now() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function getPerson(id) {
  return db.prepare(`SELECT * FROM persons WHERE id = ? AND active = 1`).get(id);
}

export function validatePerson(id, allowedRoles, fieldName = 'operator_id') {
  if (!id) return { error: `${fieldName} 必填` };
  const p = getPerson(id);
  if (!p) return { error: `人员不存在或已停用 (id=${id})` };
  if (allowedRoles && allowedRoles.length && !allowedRoles.includes(p.role)) {
    const roles = allowedRoles.map(r => ROLE_LABELS[r] || r).join('/');
    return { error: `${p.name}(${p.employee_no}) 是${ROLE_LABELS[p.role]}，需要 ${roles} 权限` };
  }
  return { person: p };
}

export function getShadeById(id) {
  return db.prepare(`
    SELECT s.*,
           pb.batch_no AS paper_batch_no,
           ss.spec_code AS skeleton_spec_code,
           ss.name AS skeleton_spec_name,
           ss.dimensions AS skeleton_dimensions,
           st.station_code, st.name AS station_name,
           rp.employee_no AS responsible_employee_no, rp.name AS responsible_person_name,
           fo.name AS forming_operator_name,
           po.name AS pasting_operator_name,
           do.name AS drying_operator_name,
           insp.inspector_id AS last_inspector_id, insp2.name AS last_inspector_name,
           insp.wrinkle_description AS last_wrinkle_description,
           insp.light_uniformity_grade AS last_light_grade,
           insp.light_uniformity_score AS last_light_score,
           insp.final_recommendation AS last_recommendation,
           insp.rework_action AS last_rework_action,
           insp.inspected_at AS last_inspected_at
    FROM shades s
    LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id
    LEFT JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
    LEFT JOIN stations st ON st.id = s.station_id
    LEFT JOIN persons rp ON rp.id = s.responsible_person_id
    LEFT JOIN persons fo ON fo.id = s.forming_operator_id
    LEFT JOIN persons po ON po.id = s.pasting_operator_id
    LEFT JOIN persons do ON do.id = s.drying_operator_id
    LEFT JOIN inspections insp ON insp.id = s.last_inspection_id
    LEFT JOIN persons insp2 ON insp2.id = insp.inspector_id
    WHERE s.id = ?
  `).get(id);
}

export function getShadeByNo(shadeNo) {
  return db.prepare(`
    SELECT s.*,
           pb.batch_no AS paper_batch_no,
           ss.spec_code AS skeleton_spec_code,
           ss.name AS skeleton_spec_name,
           st.station_code, st.name AS station_name,
           rp.name AS responsible_person_name
    FROM shades s
    LEFT JOIN paper_batches pb ON pb.id = s.paper_batch_id
    LEFT JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
    LEFT JOIN stations st ON st.id = s.station_id
    LEFT JOIN persons rp ON rp.id = s.responsible_person_id
    WHERE s.shade_no = ?
  `).get(shadeNo);
}

export function logOperation(shadeId, operatorId, action, fromStatus, toStatus, details) {
  db.prepare(`
    INSERT INTO operation_logs (shade_id, operator_id, action, from_status, to_status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(shadeId, operatorId, action, fromStatus, toStatus, details ? JSON.stringify(details) : null);
}

export function updateShadeStatus(id, newStatus) {
  db.prepare(`UPDATE shades SET status = ?, updated_at = ? WHERE id = ?`).run(newStatus, now(), id);
}

export function scanAlerts() {
  const created = [];
  const nowTs = Date.now();

  const existingOverdue = new Set(
    db.prepare(`SELECT related_id FROM alerts WHERE alert_type = ? AND resolved = 0`)
      .all(ALERT_TYPES.OVERDUE_INSPECTION).map(r => r.related_id)
  );

  const pendingInspectionShades = db.prepare(`
    SELECT s.id, s.shade_no, s.inspection_cycle_hours, s.drying_completed_at,
           rp.name AS responsible_person_name
    FROM shades s
    LEFT JOIN persons rp ON rp.id = s.responsible_person_id
    WHERE s.status = ?
  `).all(STATUS.PENDING_INSPECTION);

  for (const s of pendingInspectionShades) {
    if (!s.drying_completed_at) continue;
    const dryingEnd = new Date(s.drying_completed_at.replace(' ', 'T')).getTime();
    const overdueMs = s.inspection_cycle_hours * 3600 * 1000;
    if (nowTs - dryingEnd > overdueMs) {
      if (!existingOverdue.has(s.id)) {
        const hoursOverdue = Math.floor((nowTs - dryingEnd) / 3600000);
        const info = db.prepare(`
          INSERT INTO alerts (alert_type, severity, related_id, related_type, title, description)
          VALUES (?, ?, ?, 'shade', ?, ?)
        `).run(
          ALERT_TYPES.OVERDUE_INSPECTION, 'warning', s.id,
          `巡检超期：${s.shade_no}`,
          `灯罩 ${s.shade_no} 已超期 ${hoursOverdue} 小时未巡检，责任人：${s.responsible_person_name || '未分配'}`
        );
        created.push({ id: info.lastInsertRowid, type: ALERT_TYPES.OVERDUE_INSPECTION, shade_id: s.id });
      }
    }
  }

  const reworkingShades = db.prepare(`
    SELECT s.id, s.shade_no,
           (SELECT MAX(inspected_at) FROM inspections i WHERE i.shade_id = s.id) AS last_insp_at,
           rp.name AS responsible_person_name
    FROM shades s
    LEFT JOIN persons rp ON rp.id = s.responsible_person_id
    WHERE s.status = ?
  `).all(STATUS.REWORKING);

  const existingRework = new Set(
    db.prepare(`SELECT related_id FROM alerts WHERE alert_type = ? AND resolved = 0`)
      .all(ALERT_TYPES.REWORK_NO_CONCLUSION).map(r => r.related_id)
  );

  for (const s of reworkingShades) {
    if (!existingRework.has(s.id)) {
      const info = db.prepare(`
        INSERT INTO alerts (alert_type, severity, related_id, related_type, title, description)
        VALUES (?, ?, ?, 'shade', ?, ?)
      `).run(
        ALERT_TYPES.REWORK_NO_CONCLUSION, 'warning', s.id,
        `返修待结论：${s.shade_no}`,
        `灯罩 ${s.shade_no} 已进入返修状态但尚未提交新的巡检结论，责任人：${s.responsible_person_name || '未分配'}`
      );
      created.push({ id: info.lastInsertRowid, type: ALERT_TYPES.REWORK_NO_CONCLUSION, shade_id: s.id });
    }
  }

  const batchStats = db.prepare(`
    SELECT s.paper_batch_id, pb.batch_no,
           COUNT(*) AS total,
           SUM(CASE WHEN i.wrinkles_found = 1 THEN 1 ELSE 0 END) AS wrinkle_count
    FROM shades s
    JOIN paper_batches pb ON pb.id = s.paper_batch_id
    LEFT JOIN inspections i ON i.shade_id = s.id AND i.id = s.last_inspection_id
    WHERE s.last_inspection_id IS NOT NULL
    GROUP BY s.paper_batch_id
    HAVING total >= 3 AND wrinkle_count * 1.0 / total >= 0.4
  `).all();

  const existingBatchAlerts = new Set(
    db.prepare(`SELECT related_id FROM alerts WHERE alert_type = ? AND resolved = 0`)
      .all(ALERT_TYPES.HIGH_WRINKLE_BATCH).map(r => r.related_id)
  );

  for (const b of batchStats) {
    if (!existingBatchAlerts.has(b.paper_batch_id)) {
      const rate = ((b.wrinkle_count / b.total) * 100).toFixed(1);
      const info = db.prepare(`
        INSERT INTO alerts (alert_type, severity, related_id, related_type, title, description)
        VALUES (?, ?, ?, 'batch', ?, ?)
      `).run(
        ALERT_TYPES.HIGH_WRINKLE_BATCH, 'critical', b.paper_batch_id,
        `褶皱高发批次：${b.batch_no}`,
        `纸材批次 ${b.batch_no} 褶皱率 ${rate}%（${b.wrinkle_count}/${b.total}），超过 40% 预警线`
      );
      created.push({ id: info.lastInsertRowid, type: ALERT_TYPES.HIGH_WRINKLE_BATCH, batch_id: b.paper_batch_id });
    }
  }

  const specStats = db.prepare(`
    SELECT s.skeleton_spec_id, ss.spec_code, ss.name,
           COUNT(*) AS total,
           SUM(CASE WHEN i.final_recommendation IN ('rework','suspend') OR i.light_uniformity_grade IN ('C','D') OR i.wrinkles_found = 1 THEN 1 ELSE 0 END) AS anomaly_count
    FROM shades s
    JOIN skeleton_specs ss ON ss.id = s.skeleton_spec_id
    LEFT JOIN inspections i ON i.shade_id = s.id AND i.id = s.last_inspection_id
    WHERE s.last_inspection_id IS NOT NULL
    GROUP BY s.skeleton_spec_id
    HAVING total >= 3 AND anomaly_count * 1.0 / total >= 0.4
  `).all();

  const existingSpecAlerts = new Set(
    db.prepare(`SELECT related_id FROM alerts WHERE alert_type = ? AND resolved = 0`)
      .all(ALERT_TYPES.SPEC_ANOMALY_CONCENTRATION).map(r => r.related_id)
  );

  for (const sp of specStats) {
    if (!existingSpecAlerts.has(sp.skeleton_spec_id)) {
      const rate = ((sp.anomaly_count / sp.total) * 100).toFixed(1);
      const info = db.prepare(`
        INSERT INTO alerts (alert_type, severity, related_id, related_type, title, description)
        VALUES (?, ?, ?, 'spec', ?, ?)
      `).run(
        ALERT_TYPES.SPEC_ANOMALY_CONCENTRATION, 'critical', sp.skeleton_spec_id,
        `规格异常集中：${sp.spec_code}`,
        `骨架规格 ${sp.spec_code}（${sp.name}）异常率 ${rate}%（${sp.anomaly_count}/${sp.total}），建议核查工艺`
      );
      created.push({ id: info.lastInsertRowid, type: ALERT_TYPES.SPEC_ANOMALY_CONCENTRATION, spec_id: sp.skeleton_spec_id });
    }
  }

  return created;
}

export function resolveAlertsForShade(shadeId) {
  db.prepare(`
    UPDATE alerts SET resolved = 1, resolved_at = ?
    WHERE (related_id = ? AND related_type = 'shade')
       OR (alert_type IN (?, ?))
  `).run(
    now(), shadeId,
    ALERT_TYPES.OVERDUE_INSPECTION, ALERT_TYPES.REWORK_NO_CONCLUSION
  );

  db.prepare(`
    UPDATE alerts SET resolved = 1, resolved_at = ?
    WHERE alert_type = ? AND related_id = ?
  `).run(now(), ALERT_TYPES.OVERDUE_INSPECTION, shadeId);

  db.prepare(`
    UPDATE alerts SET resolved = 1, resolved_at = ?
    WHERE alert_type = ? AND related_id = ?
  `).run(now(), ALERT_TYPES.REWORK_NO_CONCLUSION, shadeId);
}

export function getInspectionsForShade(shadeId) {
  return db.prepare(`
    SELECT i.*, p.name AS inspector_name, p.employee_no AS inspector_employee_no
    FROM inspections i
    LEFT JOIN persons p ON p.id = i.inspector_id
    WHERE i.shade_id = ?
    ORDER BY i.inspected_at DESC, i.id DESC
  `).all(shadeId);
}

export function getOperationLogs(shadeId) {
  return db.prepare(`
    SELECT ol.*, p.name AS operator_name
    FROM operation_logs ol
    LEFT JOIN persons p ON p.id = ol.operator_id
    WHERE ol.shade_id = ?
    ORDER BY ol.created_at DESC, ol.id DESC
  `).all(shadeId);
}
