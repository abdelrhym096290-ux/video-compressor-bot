// ============================================================
// src/context.js
// إدارة السياق + مخزن D1 (نسخة مُحصّنة ضد undefined)
// ============================================================
import { id, now, eventRecord } from './contracts.js';

const EMPTY = Object.freeze({ summary:'', facts:[], decisions:[], next:'', constraints:[], revision:0 });

export function emptyContext(){
  return structuredClone(EMPTY);
}

export function normalizeContext(value){
  const x = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
  return {
    ...emptyContext(),
    ...x,
    facts: Array.isArray(x.facts) ? x.facts : [],
    decisions: Array.isArray(x.decisions) ? x.decisions : [],
    constraints: Array.isArray(x.constraints) ? x.constraints : [],
    revision: Number(x.revision || 0),
  };
}

export function contextPacket(state, recent = []){
  const s = normalizeContext(state);
  return {
    revision: s.revision,
    summary: s.summary,
    facts: s.facts,
    decisions: s.decisions,
    constraints: s.constraints,
    next: s.next,
    recent: recent.slice(-14).map(m => ({ role: m.role, content: String(m.content || '') })),
  };
}

export function renderHandoff(state, recent = []){
  const p = contextPacket(state, recent);
  return [
    '## الهدف والملخص', p.summary || 'غير محدد',
    '## الحقائق المؤكدة', p.facts.join(' | ') || 'لا يوجد',
    '## القرارات', p.decisions.join(' | ') || 'لا يوجد',
    '## القيود', p.constraints.join(' | ') || 'لا يوجد',
    '## الخطوة التالية', p.next || 'تحديد المطلوب',
    '## آخر التبادلات', p.recent.map(x => `${x.role}: ${x.content}`).join('\n') || 'لا يوجد',
  ].join('\n');
}

export function mergeContext(previous, patch){
  const a = normalizeContext(previous), b = normalizeContext(patch);
  return {
    ...a, ...b,
    facts: [...new Set([...a.facts, ...b.facts])].slice(-50),
    decisions: [...new Set([...a.decisions, ...b.decisions])].slice(-50),
    constraints: [...new Set([...a.constraints, ...b.constraints])].slice(-30),
    revision: a.revision + 1,
  };
}

export function createContextEvent(chatIdOrTaskId, type, payload){
  const safePayload = payload === undefined ? {} : payload;
  const rec = eventRecord({ taskId: chatIdOrTaskId, type, payload: safePayload });
  return {
    ...rec,
    chatId: rec.chatId ?? rec.taskId ?? chatIdOrTaskId,
    taskId: rec.taskId ?? chatIdOrTaskId,
    type: rec.type ?? type,
    payload: rec.payload ?? safePayload,
    createdAt: Number(rec.createdAt) || Date.now(),
  };
}

export function d1ContextStore(db){
  return {
    async get(chatId){
      const row = await db.prepare('SELECT state_json FROM context_state WHERE chat_id = ?').bind(chatId).first();
      return normalizeContext(row?.state_json || '{}');
    },

    async put(chatId, state){
      const s = normalizeContext(state), t = now();
      await db.prepare(
        'INSERT INTO context_state (chat_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET state_json = ?, updated_at = ?'
      ).bind(chatId, JSON.stringify(s), t, JSON.stringify(s), t).run();
      return s;
    },

    // ⭐ تقبل appendEvent(event) أو appendEvent(chatId, event)
    async appendEvent(chatIdOrEvent, maybeEvent){
      let chatId, event;

      if (maybeEvent === undefined) {
        event = chatIdOrEvent || {};
        chatId = event.chatId ?? event.taskId ?? null;
      } else {
        chatId = chatIdOrEvent;
        event = maybeEvent || {};
      }

      const safeId = event.id ?? (crypto.randomUUID ? crypto.randomUUID() : 'evt_' + Math.random().toString(36).slice(2));
      const safeChatId = chatId ?? event.chatId ?? event.taskId ?? null;
      const safeType = event.type ?? 'unknown';
      const safePayload = event.payload === undefined ? {} : event.payload;
      const safeCreatedAt = Number(event.createdAt) || Date.now();

      if (!safeChatId) {
        console.error('appendEvent: chatId مفقود، تجاهل الحدث', event);
        return event;
      }

      await db.prepare(
        'INSERT INTO context_events (id, chat_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        safeId,
        safeChatId,
        safeType,
        JSON.stringify(safePayload),
        safeCreatedAt
      ).run();

      return { id: safeId, chatId: safeChatId, taskId: safeChatId, type: safeType, payload: safePayload, createdAt: safeCreatedAt };
    },

    async listEvents(chatId, limit = 50){
      const r = await db.prepare('SELECT * FROM context_events WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').bind(chatId, limit).all();
      return r.results || [];
    },
  };
}

export function memoryContextStore(){
  const states = new Map(), events = new Map();
  return {
    async get(id){ return normalizeContext(states.get(id)); },
    async put(id, s){ const x = normalizeContext(s); states.set(id, x); return x; },
    async appendEvent(e){
      const key = e.chatId ?? e.taskId;
      if (!key) return e;
      const a = events.get(key) || [];
      a.push({ ...e, chatId: key, taskId: key });
      events.set(key, a);
      return e;
    },
    async listEvents(id){ return events.get(id) || []; },
  };
}