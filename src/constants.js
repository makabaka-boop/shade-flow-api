export const STATUS = {
  PENDING_FORMING: 'pending_forming',
  FORMING: 'forming',
  PASTING: 'pasting',
  DRYING: 'drying',
  PENDING_INSPECTION: 'pending_inspection',
  REWORKING: 'reworking',
  DELIVERABLE: 'deliverable',
  SUSPENDED: 'suspended',
};

export const STATUS_LABELS = {
  [STATUS.PENDING_FORMING]: '待成型',
  [STATUS.FORMING]: '成型中',
  [STATUS.PASTING]: '裱贴中',
  [STATUS.DRYING]: '干燥中',
  [STATUS.PENDING_INSPECTION]: '待巡检',
  [STATUS.REWORKING]: '返修中',
  [STATUS.DELIVERABLE]: '可交付',
  [STATUS.SUSPENDED]: '暂停展示',
};

export const LIGHT_GRADES = ['A', 'B', 'C', 'D'];
export const LIGHT_GRADE_LABELS = { A: '优秀', B: '良好', C: '合格', D: '不合格' };

export const ALERT_TYPES = {
  HIGH_WRINKLE_BATCH: 'high_wrinkle_batch',
  OVERDUE_INSPECTION: 'overdue_inspection',
  REWORK_NO_CONCLUSION: 'rework_no_conclusion',
  SPEC_ANOMALY_CONCENTRATION: 'spec_anomaly_concentration',
};

export const ALERT_TYPE_LABELS = {
  [ALERT_TYPES.HIGH_WRINKLE_BATCH]: '褶皱高发批次',
  [ALERT_TYPES.OVERDUE_INSPECTION]: '巡检超期',
  [ALERT_TYPES.REWORK_NO_CONCLUSION]: '返修后未提交结论',
  [ALERT_TYPES.SPEC_ANOMALY_CONCENTRATION]: '同规格异常集中',
};

export const ACTIONS = {
  START_FORMING: 'start_forming',
  COMPLETE_FORMING: 'complete_forming',
  START_PASTING: 'start_pasting',
  COMPLETE_PASTING: 'complete_pasting',
  START_DRYING: 'start_drying',
  COMPLETE_DRYING: 'complete_drying',
  SUBMIT_INSPECTION: 'submit_inspection',
  START_REWORK: 'start_rework',
  MARK_DELIVERABLE: 'mark_deliverable',
  SUSPEND: 'suspend',
  RESUME: 'resume',
};

export const ALLOWED_TRANSITIONS = {
  [STATUS.PENDING_FORMING]: [STATUS.FORMING, STATUS.SUSPENDED],
  [STATUS.FORMING]: [STATUS.PASTING, STATUS.SUSPENDED],
  [STATUS.PASTING]: [STATUS.DRYING, STATUS.SUSPENDED],
  [STATUS.DRYING]: [STATUS.PENDING_INSPECTION, STATUS.SUSPENDED],
  [STATUS.PENDING_INSPECTION]: [STATUS.DELIVERABLE, STATUS.REWORKING, STATUS.SUSPENDED],
  [STATUS.REWORKING]: [STATUS.PENDING_INSPECTION, STATUS.SUSPENDED],
  [STATUS.DELIVERABLE]: [STATUS.SUSPENDED],
  [STATUS.SUSPENDED]: [STATUS.PENDING_FORMING, STATUS.FORMING, STATUS.PASTING, STATUS.DRYING, STATUS.PENDING_INSPECTION, STATUS.REWORKING, STATUS.DELIVERABLE],
};

export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function generateProcessToken() {
  return `proc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
