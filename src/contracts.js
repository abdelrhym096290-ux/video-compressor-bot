// ============================================================
// src/contracts.js
// عقود البيانات: أنواع الحالات، الأنواع المسموح بها للأحداث
// ============================================================

export const TASK_STATUS = Object.freeze([
  'received','submitted','clarifying','planning','awaiting_approval','waiting_for_input',
  'running','verifying','producing','recovering','paused','completed','failed','cancelled'
]);

export const STEP_STATUS = Object.freeze([
  'pending','running','awaiting_approval','verifying','completed','failed','retrying','cancelled'
]);

export const EVENT_TYPES = Object.freeze([
  // أحداث المهام
  'task_received','task_submitted','plan_created','approval_requested','approval_granted',
  'step_started','tool_requested','tool_completed','verification_passed','verification_failed',
  'context_updated','model_called','user_intervention','task_paused','task_completed','task_failed',
  // أحداث التوليد (chat)
  'generation_started','generation_completed','generation_failed',
  // أحداث الطرفية
  'tool_executed',
  'tool_result_ready',
  // أحداث الميزانية
  'tool_budget_exhausted','tool_budget_renewed',
  // أحداث التصحيح التلقائي
  'tool_correction_proposed','tool_correction_aborted','tool_correction_rejected','tool_auto_corrected'
]);

export const ROLES = Object.freeze(['system','user','assistant','tool']);

export function id(prefix='id'){
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now(){
  return Date.now();
}

export function assertStatus(value, allowed, label='status'){
  if(!allowed.includes(value)) throw new Error(`${label} غير صالح: ${value}`);
  return value;
}

export function taskRecord({conversationId, goal}){
  if(!goal?.trim()) throw new Error('الهدف مطلوب');
  return {
    id: id('task'),
    conversationId,
    goal: goal.trim(),
    status: 'received',
    currentStepId: null,
    createdAt: now(),
    updatedAt: now()
  };
}

export function stepRecord(input={}, position=0){
  return {
    id: input.id || id('step'),
    position,
    title: input.title || `الخطوة ${position+1}`,
    description: input.description || '',
    tool: input.tool || 'none',
    successCriteria: input.verification || '',
    status: 'pending',
    attempts: 0,
    output: null
  };
}

export function eventRecord({taskId, type, payload={}}){
  assertStatus(type, EVENT_TYPES, 'event');
  return {
    id: id('evt'),
    taskId,
    type,
    payload,
    createdAt: now()
  };
}