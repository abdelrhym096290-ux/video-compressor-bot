import { id, now, eventRecord } from './contracts.js';

const EMPTY = Object.freeze({ summary:'', facts:[], decisions:[], next:'', constraints:[], revision:0 });
export function emptyContext(){ return structuredClone(EMPTY); }
export function normalizeContext(value){ const x=typeof value==='string'?JSON.parse(value||'{}'):(value||{}); return { ...emptyContext(), ...x, facts:Array.isArray(x.facts)?x.facts:[], decisions:Array.isArray(x.decisions)?x.decisions:[], constraints:Array.isArray(x.constraints)?x.constraints:[], revision:Number(x.revision||0) }; }
export function contextPacket(state, recent=[]){ const s=normalizeContext(state); return { revision:s.revision, summary:s.summary, facts:s.facts, decisions:s.decisions, constraints:s.constraints, next:s.next, recent:recent.slice(-14).map(m=>({role:m.role,content:String(m.content||'')})) }; }
export function renderHandoff(state,recent=[]){ const p=contextPacket(state,recent); return ['## الهدف والملخص',p.summary||'غير محدد','## الحقائق المؤكدة',p.facts.join(' | ')||'لا يوجد','## القرارات',p.decisions.join(' | ')||'لا يوجد','## القيود',p.constraints.join(' | ')||'لا يوجد','## الخطوة التالية',p.next||'تحديد المطلوب','## آخر التبادلات',p.recent.map(x=>`${x.role}: ${x.content}`).join('\\n')||'لا يوجد'].join('\\n'); }
export function mergeContext(previous,patch){ const a=normalizeContext(previous),b=normalizeContext(patch); return { ...a, ...b, facts:[...new Set([...a.facts,...b.facts])].slice(-50), decisions:[...new Set([...a.decisions,...b.decisions])].slice(-50), constraints:[...new Set([...a.constraints,...b.constraints])].slice(-30), revision:a.revision+1 }; }
export function createContextEvent(taskId,type,payload){ return eventRecord({taskId,type,payload}); }

export function d1ContextStore(db){
  return {
    async get(chatId){ const row=await db.prepare('SELECT state_json FROM context_state WHERE chat_id = ?').bind(chatId).first(); return normalizeContext(row?.state_json||'{}'); },
    async put(chatId,state){ const s=normalizeContext(state),t=now(); await db.prepare('INSERT INTO context_state (chat_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET state_json = ?, updated_at = ?').bind(chatId,JSON.stringify(s),t,JSON.stringify(s),t).run(); return s; },
    async appendEvent(event){ await db.prepare('INSERT INTO context_events (id, chat_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(event.id,event.taskId,event.type,JSON.stringify(event.payload),event.createdAt).run(); return event; },
    async listEvents(chatId,limit=50){ const r=await db.prepare('SELECT * FROM context_events WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').bind(chatId,limit).all(); return r.results||[]; }
  };
}

export function memoryContextStore(){ const states=new Map(),events=new Map(); return { async get(id){return normalizeContext(states.get(id));},async put(id,s){const x=normalizeContext(s);states.set(id,x);return x;},async appendEvent(e){const a=events.get(e.taskId)||[];a.push(e);events.set(e.taskId,a);return e;},async listEvents(id){return events.get(id)||[];} }; }
