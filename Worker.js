// =====================================================================
// FOX AI — Worker جامع نهائي v7.2
// التعديلات: تعليق تلقائي على نتيجة الأداة + tool_proposed + schema caching
// =====================================================================

import { publicCatalog, getModel, chooseModel, scoreDifficulty, routeAuto } from './src/catalog.js';
import { routeCompletion, streamCompletion, ProviderError } from './src/providers.js';
import { d1ContextStore, contextPacket, renderHandoff, mergeContext, createContextEvent } from './src/context.js';
import { createTask, startPlanning, createPlan, approvePlan, startStep, completeStep, failStep, retryStep, taskEvent } from './src/tasks.js';
import { detectToolProposal, approvalRecord, experimentRecord, dispatchExperiment, cancelExperiment, verifyResult, retryExperiment, verifyWebhook, validateCommand } from './src/tools.js';
import { uploadReleaseAsset, downloadReleaseAsset, MAX_DIRECT_UPLOAD } from './src/storage.js';
import { multimodalMessages, modelCapabilities } from './src/media.js';
import { advanceTask, addIntervention, taskEvents } from './src/orchestrator.js';
import { buildSystemPrompt, buildToolCommentaryPrompt, classifyQuestion, toolResultMessage } from './src/prompts.js';

// ============ ثوابت ============
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-FOX-Signature,X-Requested-With',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', ...CORS },
});
const text = x => String(x || '').trim();

// ⭐ الحصة
const TOOL_BUDGET_GRANT = 10;
const TOOL_BUDGET_EXPIRY_MS = 20 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 60 * 1000;

// ⭐ الحدود
const LIMITS = {
  MAX_MESSAGE_TEXT: 200000,
  MAX_FILE_TEXT: 2000000,
  MAX_CONTEXT_MESSAGES: 100,
  MAX_MESSAGES_LOADED: 500,
  MAX_OUTPUT_DISPLAY: 500000,
  MAX_FILES_PER_MSG: 20,
};

// ⭐ schema caching — مرة واحدة لكل Worker instance
let _schemaReady = false;

// ============ Schema ============
async function schema(env) {
  if (_schemaReady) return;
  const q = [
    'CREATE TABLE IF NOT EXISTS context_state (chat_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS context_events (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, task_json TEXT NOT NULL, plan_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, exit_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC)',
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tool_budgets (chat_id TEXT PRIMARY KEY, granted INTEGER NOT NULL, used INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS conversation_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content_text TEXT, data_url TEXT, storage TEXT, asset_id TEXT, asset_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_files_chat ON conversation_files(chat_id,created_at DESC)',
    'CREATE TABLE IF NOT EXISTS task_control (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id,created_at ASC)',
    "CREATE TABLE IF NOT EXISTS task_runtime (task_id TEXT PRIMARY KEY, lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'idle', last_error TEXT, next_run_at INTEGER, updated_at INTEGER NOT NULL)",
    'CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, updated_at INTEGER NOT NULL)',
  ];
  for (const sql of q) {
    try { await env.DB.prepare(sql).run(); } catch (e) { console.warn('schema:', e.message); }
  }
  // migrations
  const migrations = [
    'ALTER TABLE experiments ADD COLUMN task_id TEXT',
    'ALTER TABLE experiments ADD COLUMN step_id TEXT',
    'ALTER TABLE experiments ADD COLUMN run_id TEXT',
    'ALTER TABLE experiments ADD COLUMN attempt INTEGER DEFAULT 1',
    'ALTER TABLE experiments ADD COLUMN parent_id TEXT',
    'ALTER TABLE conversation_files ADD COLUMN storage TEXT',
    'ALTER TABLE conversation_files ADD COLUMN asset_id TEXT',
    'ALTER TABLE conversation_files ADD COLUMN asset_url TEXT',
    'ALTER TABLE tool_budgets ADD COLUMN expires_at INTEGER',
  ];
  for (const sql of migrations) {
    try { await env.DB.prepare(sql).run(); } catch {}
  }
  _schemaReady = true;
}

// ============ Class توافق قديم ============
export class ExperimentState {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() { return json({ name: 'ExperimentState', status: 'compatible' }); }
}

// ============ دوال مساعدة ============
async function isSessionValid(env, token) {
  if (!token) return false;
  try {
    const nowMs = Date.now();
    const session = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(token).first();
    if (!session) return false;
    if (session.expires_at <= nowMs) {
      env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run().catch(() => {});
      return false;
    }
    return true;
  } catch { return false; }
}

async function safeEvent(store, chatId, type, payload) {
  const safePayload = payload === undefined ? {} : payload;
  try {
    const evt = createContextEvent(chatId, type, safePayload);
    await store.appendEvent(chatId, evt);
  } catch (e) {
    console.error('safeEvent primary failed:', e.message);
    try {
      await store.appendEvent({
        id: crypto.randomUUID ? crypto.randomUUID() : ('evt_' + Math.random().toString(36).slice(2)),
        chatId,
        taskId: chatId,
        type,
        payload: safePayload,
        createdAt: Date.now(),
      });
    } catch (e2) {
      console.error('safeEvent fallback failed:', e2.message);
    }
  }
}

// ⭐ الإحصاءات
async function getUsageFromGateway(env) {
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    try {
      const ACCOUNT_ID = env.CF_ACCOUNT_ID;
      const nowD = new Date();
      const startISO = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate())).toISOString();
      const endISO = nowD.toISOString();
      const query = `query { viewer { accounts(filter: { accountTag: "${ACCOUNT_ID}" }) { aiGatewayRequestsAdaptiveGroups(filter: { datetimeHour_geq: "${startISO}", datetimeHour_leq: "${endISO}" } limit: 1000) { count dimensions { model provider gateway datetimeHour } sum { tokensIn tokensOut totalTokens cost } } } } }`;
      const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CF_API_TOKEN },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
      const groups = data.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups || [];
      let totalRequests = 0, totalTokensIn = 0, totalTokensOut = 0, totalTokens = 0, totalCost = 0;
      const modelStats = {};
      groups.forEach(g => {
        totalRequests += g.count || 0;
        totalTokensIn += g.sum?.tokensIn || 0;
        totalTokensOut += g.sum?.tokensOut || 0;
        totalTokens += g.sum?.totalTokens || 0;
        totalCost += g.sum?.cost || 0;
        const modelKey = g.dimensions?.model || 'unknown';
        if (!modelStats[modelKey]) modelStats[modelKey] = { requests: 0, tokensIn: 0, tokensOut: 0 };
        modelStats[modelKey].requests += g.count || 0;
        modelStats[modelKey].tokensIn += g.sum?.tokensIn || 0;
        modelStats[modelKey].tokensOut += g.sum?.tokensOut || 0;
      });
      return {
        source: 'gateway',
        period: { from: startISO, to: endISO },
        totals: { requests: totalRequests, tokensIn: totalTokensIn, tokensOut: totalTokensOut, totalTokens, cost: totalCost },
        byModel: modelStats,
      };
    } catch (e) {
      console.warn('Gateway failed, falling back to D1:', e.message);
    }
  }

  try {
    const nowD = new Date();
    const todayStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate())).getTime();
    const [msgs, exps, convs] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM messages WHERE created_at > ?').bind(todayStart).first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM experiments WHERE created_at > ?').bind(todayStart).first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM conversations').first(),
    ]);
    return {
      source: 'd1',
      period: { from: new Date(todayStart).toISOString(), to: nowD.toISOString() },
      totals: {
        requests: msgs?.c || 0,
        tokensIn: 0, tokensOut: 0, totalTokens: 0, cost: 0,
      },
      byModel: {},
      experiments: exps?.c || 0,
      conversations: convs?.c || 0,
      note: 'إحصاءات محلية من D1 — أضف CF_API_TOKEN للحصول على تكلفة AI Gateway',
    };
  } catch (e) {
    return { source: 'error', error: e.message, totals: { requests: 0, tokensIn: 0, tokensOut: 0, totalTokens: 0, cost: 0 }, byModel: {} };
  }
}

// ============ Auth ============
async function login(env, body, request) {
  const clientIP = request?.headers?.get('CF-Connecting-IP') || 'unknown';
  try {
    const lockCheck = await env.DB.prepare('SELECT attempts, locked_until FROM login_attempts WHERE ip = ?').bind(clientIP).first();
    const nowMs = Date.now();
    if (lockCheck?.locked_until && lockCheck.locked_until > nowMs) {
      const remainingMin = Math.ceil((lockCheck.locked_until - nowMs) / 60000);
      return json({ error: `تم حظرك مؤقتاً. حاول بعد ${remainingMin} دقيقة.`, locked: true }, 429);
    }
    if (env.ACCESS_PASSWORD && body.accessPassword !== env.ACCESS_PASSWORD) {
      const currentAttempts = (lockCheck?.attempts || 0) + 1;
      const shouldLock = currentAttempts >= 5;
      const lockedUntil = shouldLock ? nowMs + 10 * 60 * 1000 : null;
      await env.DB.prepare(
        `INSERT INTO login_attempts (ip, attempts, locked_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET attempts = ?, locked_until = ?, updated_at = ?`
      ).bind(clientIP, currentAttempts, lockedUntil, nowMs, currentAttempts, lockedUntil, nowMs).run();
      return json({ error: shouldLock ? 'كلمة مرور خاطئة. تم حظرك 10 دقائق.' : `كلمة مرور خاطئة. المتبقي: ${5 - currentAttempts}`, authRequired: true }, 401);
    }
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, attempts, locked_until, updated_at) VALUES (?, 0, NULL, ?)
       ON CONFLICT(ip) DO UPDATE SET attempts = 0, locked_until = NULL, updated_at = ?`
    ).bind(clientIP, nowMs, nowMs).run();
    const token = crypto.randomUUID();
    const expiresAt = nowMs + 86400000;
    await env.DB.prepare('INSERT INTO sessions (token,created_at,expires_at) VALUES (?,?,?)').bind(token, nowMs, expiresAt).run();
    return json({ success: true, token, expiresAt });
  } catch (e) {
    return json({ error: 'خطأ في تسجيل الدخول: ' + e.message }, 500);
  }
}

async function logout(env, b) {
  if (b.sessionToken) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(b.sessionToken).run().catch(() => {});
  return json({ success: true });
}

async function checkSession(env, b) {
  const valid = await isSessionValid(env, b.sessionToken);
  return json({ valid });
}

async function session(env, token) {
  if (!env.ACCESS_PASSWORD) return true;
  return await isSessionValid(env, token);
}

// ============ persist / load ============
async function persistMessage(env, chatId, role, content, modelId = null) {
  const t = Date.now();
  const textContent = String(content || '').slice(0, LIMITS.MAX_MESSAGE_TEXT);
  await env.DB.prepare('INSERT INTO messages (id,chat_id,role,content,model_id,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), chatId, role, textContent, modelId, t).run();
  await env.DB.prepare('INSERT INTO conversations (id,title,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=?').bind(chatId, textContent.slice(0, 80) || 'محادثة جديدة', t, t, t).run();
}

async function persistFiles(env, chatId, files = []) {
  for (const f of Array.isArray(files) ? files : []) {
    const fid = crypto.randomUUID();
    const name = text(f.name).slice(0, 180) || 'file';
    const mime = text(f.mime || f.type).slice(0, 120) || 'application/octet-stream';
    const size = Math.max(0, Number(f.size) || 0);
    const content = f.text != null ? String(f.text).slice(0, LIMITS.MAX_FILE_TEXT) : null;
    let data = null, storage = null, assetId = null, assetUrl = null;
    if (f.data) {
      const raw = String(f.data);
      const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
      if (match) {
        const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
        if (bytes.byteLength > MAX_DIRECT_UPLOAD) throw new Error(`الملف يتجاوز الحد: ${name}`);
        if (bytes.byteLength > 700000) {
          const asset = await uploadReleaseAsset(env, { name, mime, bytes });
          storage = asset.storage; assetId = String(asset.assetId); assetUrl = asset.url;
        } else data = raw;
      }
    }
    await env.DB.prepare('INSERT INTO conversation_files (id,chat_id,name,mime,size,content_text,data_url,storage,asset_id,asset_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(fid, chatId, name, mime, size, content, data, storage, assetId, assetUrl, Date.now(), Date.now()).run();
  }
}

async function loadMessages(env, chatId) {
  const r = await env.DB.prepare('SELECT id,role,content,model_id,created_at FROM messages WHERE chat_id=? ORDER BY created_at ASC LIMIT ?').bind(chatId, LIMITS.MAX_MESSAGES_LOADED).all();
  return (r.results || []).map(x => ({ id: x.id, role: x.role, content: x.content, model: x.model_id || null, createdAt: x.created_at }));
}

// ============ deepAnswer — v7.2: cf-* فقط ============
async function deepAnswer(env, sysContent, packetRecent, media) {
  const modelA = getModel('cf-gpt-oss-120b');
  const modelB = getModel('cf-qwen3');
  const baseMessages = [{ role: 'system', content: sysContent }, ...packetRecent.slice(0, -1), ...media.messages];
  const [ra, rb] = await Promise.all([
    routeCompletion(env, modelA.id, baseMessages, { maxTokens: 4096 }),
    routeCompletion(env, modelB.id, baseMessages, { maxTokens: 4096 }),
  ]);
  const reviewPrompt = `لديك إجابتان مستقلتان لنفس السؤال. قارن بينهما بدقة. إن اتفقتا، أعد أفضل صياغة موحدة. إن اختلفتا، وضّح نقطة الخلاف وأعد إجابة نهائية موثوقة.\n\n## الأولى (${modelA.name})\n${ra.text}\n\n## الثانية (${modelB.name})\n${rb.text}`;
  const reviewer = getModel('cf-qwen3');
  const rr = await routeCompletion(env, reviewer.id, [{ role: 'system', content: sysContent }, { role: 'user', content: reviewPrompt }], { maxTokens: 2200, temperature: 0.2 });
  const disagreed = /يختلف|تعارض|تناقض|اختلاف جوهري|خلاف/.test(rr.text.slice(0, 400));
  return { text: rr.text, actual: rr.actual, deep: { modelA: ra.actual.id, modelB: rb.actual.id, reviewer: rr.actual.id, agreed: !disagreed } };
}

// ============ SSE helpers ============
function sseEncode(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseStream(handler) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        try { controller.enqueue(encoder.encode(sseEncode(event, data))); } catch {}
      };
      try {
        await handler(send, controller);
      } catch (e) {
        try { send('error', { message: e.message || 'خطأ داخلي' }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });
}

// ============ chat — Streaming SSE ============
async function chat(env, b) {
  if (!b.chatId || !Array.isArray(b.messages) || !b.messages.length) {
    return json({ error: 'chatId والرسائل مطلوبان' }, 400);
  }

  const stream = sseStream(async (send, controller) => {
    const store = d1ContextStore(env.DB);
    const state = await store.get(b.chatId);
    const recent = b.messages.slice(-LIMITS.MAX_CONTEXT_MESSAGES);
    const lastContent = recent.at(-1)?.content || '';
    const hasImage = (b.attachments || []).some(x => String(x.mime || x.type || '').startsWith('image/'));

    let requested, routeInfo = null;
    if (!b.model || b.model === 'auto') {
      const score = scoreDifficulty(lastContent, { fileCount: (b.attachments || []).length, priorFailures: b.priorFailures || 0 });
      const routed = routeAuto(score);
      routeInfo = { score, tier: routed.tier };
      requested = routed.model;
    } else {
      requested = getModel(b.model);
    }
    const model = hasImage && requested.kind !== 'vision' ? getModel('cf-llama-vision') : requested;
    const packet = contextPacket(state, recent);
    const media = multimodalMessages([{ role: 'user', content: lastContent }], b.attachments || [], model.id);
    const promptType = classifyQuestion(lastContent);
    const sysContent = buildSystemPrompt(promptType, renderHandoff(state, recent), renderHandoff(state, []));

    const wantsDeep = b.mode === 'deep' || (routeInfo && routeInfo.tier === 'deep' && !hasImage);

    await safeEvent(store, b.chatId, 'generation_started', {
      requested: model.id, mode: b.mode || 'auto', route: routeInfo,
      deep: wantsDeep, contextMessages: packet.recent.length,
    });

    send('start', { requested: model.id, route: routeInfo, deep: wantsDeep });

    const startTime = Date.now();
    let fullText = '';
    let actualModel = model;
    let fallback = false;
    let fallbackReason = null;
    let deepMeta = null;

    try {
      if (wantsDeep && !hasImage) {
        const r = await deepAnswer(env, sysContent, packet.recent, media);
        fullText = r.text;
        actualModel = r.actual;
        deepMeta = r.deep;
        const words = String(fullText).split(/(\s+)/);
        let buffer = '';
        for (const w of words) {
          buffer += w;
          if (buffer.length >= 12) {
            send('chunk', { text: buffer });
            buffer = '';
            await new Promise(r => setTimeout(r, 15));
          }
        }
        if (buffer) send('chunk', { text: buffer });
      } else {
        const result = await streamCompletion(env, model.id, [
          { role: 'system', content: sysContent },
          ...packet.recent.slice(0, -1),
          ...media.messages,
        ], { maxTokens: 4096 });

        actualModel = result.actual;
        fallback = result.fallback;
        fallbackReason = result.fallbackReason;

        const reader = result.stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            fullText += chunk;
            send('chunk', { text: chunk });
          }
        }
      }
    } catch (err) {
      await safeEvent(store, b.chatId, 'generation_failed', { requested: model.id, error: err.message });
      send('error', { message: err.message || 'فشل التوليد' });
      return;
    }

    const last = text(lastContent).slice(0, LIMITS.MAX_MESSAGE_TEXT);
    await persistFiles(env, b.chatId, b.attachments || []);
    await persistMessage(env, b.chatId, 'user', last, null);
    await persistMessage(env, b.chatId, 'assistant', fullText, actualModel.id);

    const next = mergeContext(state, {
      summary: last.slice(0, 500),
      facts: state.facts,
      decisions: state.decisions,
      next: 'متابعة طلب المستخدم',
      constraints: state.constraints,
    });
    await store.put(b.chatId, next);

    await safeEvent(store, b.chatId, 'model_called', {
      requested: model.id, actual: actualModel.id,
      fallback, fallbackReason: fallbackReason || null,
      media: !!b.attachments?.length, route: routeInfo, deep: deepMeta,
    });
    await safeEvent(store, b.chatId, 'context_updated', { revision: next.revision });
    await safeEvent(store, b.chatId, 'generation_completed', {
      actual: actualModel.id, provider: actualModel.provider,
      latencyMs: Date.now() - startTime,
    });

    // ⭐ إرسال meta + حفظ الاقتراح
    const pendingExecution = detectToolProposal(fullText);

    // ⭐ حفظ الاقتراح في DB لاستمرارية البطاقة
    if (pendingExecution) {
      await safeEvent(store, b.chatId, 'tool_proposed', {
        proposalId: pendingExecution.id,
        command: pendingExecution.command,
        language: pendingExecution.language,
        explanation: pendingExecution.explanation || '',
        requiresApproval: true,
      });
    }

    send('meta', {
      response: fullText,
      model: actualModel,
      requestedModel: requested,
      pendingExecution,
      unsupportedAttachments: media.unsupported,
      memory: renderHandoff(next, []),
      route: routeInfo,
      deep: deepMeta,
      fallback,
      fallbackReason,
      latencyMs: Date.now() - startTime,
      trace: {
        provider: actualModel.provider,
        model: actualModel.model,
        contextMessages: packet.recent.length,
        media: !!b.attachments?.length,
        memoryUpdated: true,
      },
    });

    send('done', { ok: true });
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream;charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      ...CORS,
    },
  });
}

// ============ plan ============
async function plan(env, b) {
  if (!b.chatId || !text(b.task)) return json({ error: 'chatId و task مطلوبان' }, 400);
  const state = await d1ContextStore(env.DB).get(b.chatId);
  const model = getModel(b.model || chooseModel(b.task).id);
  const prompt = `أنشئ خطة JSON فقط بالشكل {"goal":"...","steps":[{"title":"...","description":"...","verification":"...","tool":"none"}]}. المهمة: ${b.task}\nالسياق: ${renderHandoff(state, [])}`;
  const r = await routeCompletion(env, model.id, [
    { role: 'system', content: buildSystemPrompt('analysis', renderHandoff(state, []), '') + ' لا تنفذ شيئًا. أعد JSON صحيحًا فقط.' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1800, temperature: .1 });
  let raw = r.text.match(/\{[\s\S]*\}/)?.[0] || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { goal: b.task, steps: [{ title: 'تحليل المتطلبات', description: b.task, verification: 'وجود خطة', tool: 'none' }] }; }
  const task = startPlanning(createTask({ conversationId: b.chatId, goal: parsed.goal || b.task }));
  const planObj = createPlan(task, { goal: parsed.goal || b.task, steps: Array.isArray(parsed.steps) && parsed.steps.length ? parsed.steps : [{ title: 'تحليل المتطلبات', description: b.task, verification: 'وجود خطة', tool: 'none' }] });
  await env.DB.prepare('INSERT INTO tasks (id,chat_id,task_json,plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(task.id, b.chatId, JSON.stringify(task), JSON.stringify(planObj), Date.now(), Date.now()).run();
  return json({ task: { ...task, plan: planObj }, plan: planObj, model: r.actual });
}

// ============ getRun / getTaskControl / stepControl ============
async function getRun(env, b) {
  const r = await env.DB.prepare('SELECT task_json,plan_json FROM tasks WHERE id=?').bind(b.runId).first();
  if (!r) return json({ error: 'المهمة غير موجودة' }, 404);
  return json({ task: JSON.parse(r.task_json), plan: JSON.parse(r.plan_json) });
}

async function getTaskControl(env, b) {
  if (!b.taskId) return json({ error: 'taskId مطلوب' }, 400);
  const task = await env.DB.prepare('SELECT id,task_json,plan_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!task) return json({ error: 'المهمة غير موجودة' }, 404);
  const control = await env.DB.prepare('SELECT task_id,status,updated_at FROM task_control WHERE task_id=?').bind(b.taskId).first();
  return json({ task: JSON.parse(task.task_json), plan: task.plan_json ? JSON.parse(task.plan_json) : null, control: control || { task_id: b.taskId, status: JSON.parse(task.task_json).status, updated_at: null } });
}

async function stepControl(env, b) {
  if (!b.taskId || !b.stepId || !['start_step', 'complete_step', 'fail_step', 'retry_step'].includes(b.action)) return json({ error: 'taskId و stepId وإجراء الخطوة مطلوبون' }, 400);
  const row = await env.DB.prepare('SELECT task_json,plan_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!row) return json({ error: 'المهمة غير موجودة' }, 404);
  let task = JSON.parse(row.task_json), plan = JSON.parse(row.plan_json || 'null');
  if (!plan) return json({ error: 'الخطة غير موجودة' }, 404);
  const control = await env.DB.prepare('SELECT status FROM task_control WHERE task_id=?').bind(b.taskId).first();
  if (['paused', 'cancelled'].includes(control?.status)) return json({ error: `المهمة ${control.status === 'paused' ? 'متوقفة مؤقتًا' : 'ملغاة'}` }, 409);
  let result;
  if (b.action === 'start_step') {
    if (task.status === 'planning' || task.status === 'awaiting_approval') result = approvePlan(task, plan);
    else result = startStep(task, plan, b.stepId);
  } else if (b.action === 'complete_step') result = completeStep(task, plan, b.stepId, text(b.output) || 'تمت الخطوة يدويًا', Array.isArray(b.evidence) ? b.evidence : []);
  else if (b.action === 'fail_step') result = failStep(task, plan, b.stepId, text(b.error) || 'فشلت الخطوة');
  else result = retryStep(task, plan, b.stepId);
  task = result.task; plan = result.plan;
  await env.DB.prepare('UPDATE tasks SET task_json=?,plan_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(task), JSON.stringify(plan), Date.now(), b.taskId).run();
  return json({ success: true, task, plan, retry: result.retry ?? false });
}

// ============ experiments ============
async function getExperiment(env, b) {
  if (!b.experimentId) return json({ error: 'experimentId مطلوب' }, 400);
  const r = await env.DB.prepare('SELECT id,chat_id,command,status,output,exit_code,created_at,updated_at FROM experiments WHERE id=?').bind(b.experimentId).first();
  if (!r) return json({ error: 'التجربة غير موجودة' }, 404);
  const output = (r.output || '').slice(0, LIMITS.MAX_OUTPUT_DISPLAY);
  return json({ experiment: { ...r, output, exitCode: r.exit_code, createdAt: r.created_at, updatedAt: r.updated_at } });
}

async function getExperiments(env, b) {
  const results = await env.DB.prepare('SELECT id,command,status,exit_code,created_at,updated_at FROM experiments ORDER BY created_at DESC LIMIT 20').all();
  return json({ experiments: results.results || [] });
}

async function cancelExperimentRun(env, b) {
  if (!b.experimentId) return json({ error: 'experimentId مطلوب' }, 400);
  const row = await env.DB.prepare('SELECT id,chat_id,run_id,status FROM experiments WHERE id=?').bind(b.experimentId).first();
  if (!row) return json({ error: 'التجربة غير موجودة' }, 404);
  if (['completed', 'failed', 'cancelled'].includes(row.status)) return json({ success: true, status: row.status, alreadyFinished: true });
  const result = await cancelExperiment(env, { runId: row.run_id });
  await env.DB.prepare('UPDATE experiments SET status=?,updated_at=? WHERE id=?').bind(result.status === 'already_finished' ? 'completed' : 'cancellation_requested', Date.now(), b.experimentId).run();
  return json({ success: true, experimentId: b.experimentId, ...result });
}

// ============ tool budget ============
async function toolBudget(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const r = await env.DB.prepare('SELECT chat_id,granted,used,expires_at,updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  if (!r) return json({ budget: { granted: 0, used: 0, remaining: 0, expiresAt: null, expired: false } });
  const expired = r.expires_at && Number(r.expires_at) < Date.now();
  return json({
    budget: {
      granted: r.granted, used: r.used,
      remaining: Math.max(0, Number(r.granted) - Number(r.used)),
      expiresAt: r.expires_at, expired: !!expired,
    },
  });
}

async function renewToolBudget(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const nowMs = Date.now();
  const newExpiry = nowMs + TOOL_BUDGET_EXPIRY_MS;
  await env.DB.prepare(
    'INSERT INTO tool_budgets (chat_id, granted, used, expires_at, updated_at) VALUES (?, ?, 0, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET granted = ?, used = 0, expires_at = ?, updated_at = ?'
  ).bind(b.chatId, TOOL_BUDGET_GRANT, newExpiry, nowMs, TOOL_BUDGET_GRANT, newExpiry, nowMs).run();

  const store = d1ContextStore(env.DB);
  await safeEvent(store, b.chatId, 'tool_budget_renewed', { granted: TOOL_BUDGET_GRANT, expiresAt: newExpiry });

  return json({
    success: true,
    budget: { granted: TOOL_BUDGET_GRANT, used: 0, remaining: TOOL_BUDGET_GRANT, expiresAt: newExpiry, expired: false },
  });
}

// ============ toolProposal ============
async function toolProposal(env, b) {
  const proposal = detectToolProposal(b.text || b.content || '');
  return json({ proposal });
}

// ============ runTool ============
async function runTool(env, b) {
  const proposal = b.proposal;
  if (!proposal) return json({ error: 'proposal مطلوب' }, 400);
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);

  if (proposal.command === 'renew' || proposal.id === 'renew') {
    return json({ error: 'استخدم renew_tool_budget لتجديد الحصة' }, 400);
  }

  let budget = await env.DB.prepare('SELECT chat_id,granted,used,expires_at,updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  const nowMs = Date.now();

  if (b.approved !== true) {
    return json({
      needsApproval: true,
      reason: 'لا يمكن تشغيل الطرفية دون موافقة',
      proposal,
      suggestedBudget: TOOL_BUDGET_GRANT,
      expiryMinutes: Math.round(TOOL_BUDGET_EXPIRY_MS / 60000),
      budget: budget ? { granted: budget.granted, used: budget.used, remaining: Math.max(0, budget.granted - budget.used), expiresAt: budget.expires_at, expired: !!(budget.expires_at && budget.expires_at < nowMs) } : null,
    }, 403);
  }

  if (!b.force) {
    try {
      const cmdClean = validateCommand(proposal.command);
      const dup = await env.DB.prepare(
        'SELECT id FROM experiments WHERE chat_id = ? AND command = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1'
      ).bind(b.chatId, cmdClean, nowMs - DUPLICATE_WINDOW_MS).first();
      if (dup) {
        return json({
          error: 'هذا الأمر أُرسل خلال آخر دقيقة',
          existingId: dup.id,
          hint: 'انتظر اكتماله أو أضف force:true',
          duplicate: true,
        }, 409);
      }
    } catch {}
  }

  if (!budget) {
    await env.DB.prepare('INSERT INTO tool_budgets (chat_id,granted,used,expires_at,updated_at) VALUES (?,?,?,?,?)')
      .bind(b.chatId, TOOL_BUDGET_GRANT, 0, nowMs + TOOL_BUDGET_EXPIRY_MS, nowMs).run();
    budget = { chat_id: b.chatId, granted: TOOL_BUDGET_GRANT, used: 0, expires_at: nowMs + TOOL_BUDGET_EXPIRY_MS, updated_at: nowMs };
  } else {
    const expired = budget.expires_at && Number(budget.expires_at) < nowMs;
    const exhausted = Number(budget.used) >= Number(budget.granted);
    if (expired || exhausted) {
      if (b.renew === true) {
        const newExpiry = nowMs + TOOL_BUDGET_EXPIRY_MS;
        await env.DB.prepare('UPDATE tool_budgets SET granted=?,used=0,expires_at=?,updated_at=? WHERE chat_id=?')
          .bind(TOOL_BUDGET_GRANT, newExpiry, nowMs, b.chatId).run();
        budget = { ...budget, granted: TOOL_BUDGET_GRANT, used: 0, expires_at: newExpiry, updated_at: nowMs };
      } else {
        return json({
          needsApproval: true,
          reason: expired ? `انتهت الحصة. جدّدها.` : `استُهلكت الحصة (${TOOL_BUDGET_GRANT}). جدّدها.`,
          proposal, canRenew: true, suggestedBudget: TOOL_BUDGET_GRANT, expiryMinutes: Math.round(TOOL_BUDGET_EXPIRY_MS/60000),
          budget: { granted: budget.granted, used: budget.used, remaining: 0, expiresAt: budget.expires_at, expired: !!expired },
        }, 403);
      }
    }
  }

  const remaining = Number(budget.granted) - Number(budget.used);
  const approval = approvalRecord({ proposalId: proposal.id, approved: true, scope: `budget_${budget.granted}` });
  const experiment = { ...experimentRecord({ chatId: b.chatId, proposal, approval }), taskId: b.taskId || null, stepId: b.stepId || null };

  await env.DB.prepare('UPDATE tool_budgets SET used=used+1,updated_at=? WHERE chat_id=?').bind(Date.now(), b.chatId).run();
  await env.DB.prepare('INSERT INTO experiments (id,chat_id,command,status,output,exit_code,created_at,updated_at,task_id,step_id,run_id,attempt,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(experiment.id, experiment.chatId, experiment.command, experiment.status, '', null, experiment.createdAt, experiment.updatedAt, experiment.taskId, experiment.stepId, null, 1, null).run();

  const dispatched = await dispatchExperiment(env, experiment);
  await env.DB.prepare('UPDATE experiments SET status=?,run_id=?,updated_at=? WHERE id=?')
    .bind(dispatched.status, dispatched.runId || null, dispatched.updatedAt, dispatched.id).run();

  const store = d1ContextStore(env.DB);
  await safeEvent(store, b.chatId, 'tool_executed', {
    experimentId: dispatched.id,
    command: dispatched.command,
    language: dispatched.language,
    runId: dispatched.runId,
    status: dispatched.status,
  });

  return json({
    experiment: dispatched,
    budget: { granted: budget.granted, used: Number(budget.used) + 1, remaining: remaining - 1, expiresAt: budget.expires_at },
  });
}

// ============ workspaceStatus ============
async function workspaceStatus(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const files = await env.DB.prepare('SELECT id,name,mime,size,storage,asset_id,asset_url,created_at FROM conversation_files WHERE chat_id=? ORDER BY created_at DESC LIMIT 100').bind(b.chatId).all();
  const experiments = await env.DB.prepare('SELECT id,command,status,exit_code,created_at,updated_at FROM experiments WHERE chat_id=? ORDER BY created_at DESC LIMIT 30').bind(b.chatId).all();
  const budget = await env.DB.prepare('SELECT granted,used,expires_at,updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  const nowMs = Date.now();
  return json({
    workspace: {
      type: 'fox-session', persistentFiles: true, terminal: 'github-actions',
      storage: env.GITHUB_ASSET_REPO ? 'github-release+d1' : 'd1-only',
      files: files.results || [], experiments: experiments.results || [],
      budget: budget ? {
        granted: budget.granted, used: budget.used,
        remaining: Math.max(0, Number(budget.granted) - Number(budget.used)),
        expiresAt: budget.expires_at,
        expired: !!(budget.expires_at && budget.expires_at < nowMs),
      } : { granted: 0, used: 0, remaining: 0, expiresAt: null, expired: false },
    },
  });
}

// =====================================================================
// ⭐ receiveToolResult — v7.2: تعليق تلقائي على النتيجة
// =====================================================================
async function receiveToolResult(env, request) {
  const raw = await request.text();
  const sig = request.headers.get('X-FOX-Signature') || '';
  if (!await verifyWebhook(raw, sig, env.HMAC_SECRET)) {
    return json({ error: 'توقيع النتيجة غير صالح' }, 403);
  }
  const b = JSON.parse(raw);
  const row = await env.DB.prepare('SELECT id,chat_id,command,status,output,exit_code,created_at,updated_at,task_id,step_id,run_id,attempt,parent_id FROM experiments WHERE id=?').bind(b.experimentId).first();
  if (!row) return json({ error: 'التجربة غير موجودة' }, 404);

  const result = verifyResult({ ...row, id: row.id }, { output: b.output || '', exitCode: b.exit_code ?? 1 });
  await env.DB.prepare('UPDATE experiments SET status=?,output=?,exit_code=?,updated_at=? WHERE id=?')
    .bind(result.status, result.output, result.exitCode, result.updatedAt, result.id).run();

  const store = d1ContextStore(env.DB);
  await safeEvent(store, row.chat_id, 'tool_result_ready', {
    experimentId: row.id,
    status: result.status,
    exitCode: result.exitCode,
    outputPreview: String(result.output || '').slice(0, 500),
  });

  // ⭐ حالة 1: مرتبط بمهمة → منطق المهام أولاً
  if (row.task_id && row.step_id) {
    const tr = await env.DB.prepare('SELECT task_json,plan_json FROM tasks WHERE id=?').bind(row.task_id).first();
    if (tr && tr.plan_json) {
      const task = JSON.parse(tr.task_json);
      const plan = JSON.parse(tr.plan_json);
      const rest = plan.steps.filter(x => x.id !== row.step_id && x.status === 'pending');
      const next = rest[0];
      const nextSteps = plan.steps.map(x =>
        x.id === row.step_id ? { ...x, status: result.status === 'completed' ? 'completed' : 'failed', output: result.output, exitCode: result.exitCode, completedAt: Date.now() }
        : next && x.id === next.id ? { ...x, status: 'running', startedAt: Date.now() }
        : x
      );
      const nextTask = { ...task, status: result.status === 'completed' ? (next ? 'running' : 'completed') : 'failed', currentStepId: next?.id || null, updatedAt: Date.now() };
      await env.DB.prepare('UPDATE tasks SET task_json=?,plan_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(nextTask), JSON.stringify({ ...plan, steps: nextSteps }), Date.now(), row.task_id).run();
      if (result.status === 'completed' && next) {
        const t = await advanceTask(env, row.task_id, { maxSteps: 3 });
        return json({ success: true, experiment: result, run: t });
      }
      if (result.status === 'failed') {
        const corrected = await tryAutoCorrect(env, row, result);
        if (corrected) return json({ success: true, experiment: result, correction: corrected });
      }
      return json({ success: true, experiment: result, run: { task: nextTask, plan: { ...plan, steps: nextSteps }, status: nextTask.status } });
    }
  }

  // ⭐ حالة 2: تجربة حرة → التعليق التلقائي
  let correctionResult = null;
  if (result.status === 'failed') {
    correctionResult = await tryAutoCorrect(env, row, result);
  }

  // ⭐ التعليق التلقائي على النتيجة
  const commentary = await generateToolCommentary(env, row, result, correctionResult);

  return json({
    success: true,
    experiment: result,
    correction: correctionResult,
    commentary,
  });
}

// =====================================================================
// ⭐ generateToolCommentary — يعلّق النموذج تلقائياً على النتيجة
// ⭐ لا يستهلك من حصة tool_budget
// =====================================================================
async function generateToolCommentary(env, row, result, correctionResult) {
  const chatId = row.chat_id;
  const store = d1ContextStore(env.DB);

  try {
    // 1) اجلب آخر 20 رسالة من DB
    const msgsRaw = await env.DB.prepare(
      'SELECT role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at DESC LIMIT 20'
    ).bind(chatId).all();
    const history = (msgsRaw.results || []).reverse().map(x => ({
      role: x.role === 'assistant' ? 'assistant' : 'user',
      content: String(x.content || ''),
    }));

    // 2) ابنِ الـ System Prompt لوضع "التعليق"
    const state = await store.get(chatId);
    const sysContent = buildToolCommentaryPrompt('experiment');

    // 3) صيغة نتيجة الأداة الموحّدة
    const toolMsg = toolResultMessage({
      command: row.command,
      output: result.output,
      exitCode: result.exitCode,
      status: result.status,
    });

    // 4) رسائل نهائية
    const finalMessages = [
      { role: 'system', content: sysContent },
      ...history.slice(-12),
      toolMsg,
    ];

    // 5) اختر النموذج — cf-qwen3 متوازن
    const model = getModel('cf-qwen3');

    // 6) استدعاء غير streaming (أسرع، لا يحتاج stream لعرض فوري)
    const r = await routeCompletion(env, model.id, finalMessages, { maxTokens: 1500, temperature: 0.3 });
    const commentaryText = String(r.text || '').trim();
    if (!commentaryText) return null;

    // 7) احفظه كـ assistant message
    await persistMessage(env, chatId, 'assistant', commentaryText, r.actual?.id || model.id);

    // 8) حدث حي للواجهة (لعرضه عبر polling)
    await safeEvent(store, chatId, 'tool_commentary_completed', {
      experimentId: row.id,
      text: commentaryText.slice(0, 4000),
      model: r.actual?.id || model.id,
      latencyMs: r.latencyMs || null,
    });

    // 9) حدّث السياق
    const next = mergeContext(state, {
      summary: commentaryText.slice(0, 500),
      facts: state.facts,
      decisions: state.decisions,
      next: 'متابعة بعد نتيجة التنفيذ',
      constraints: state.constraints,
    });
    await store.put(chatId, next);

    return {
      text: commentaryText,
      model: r.actual?.id || model.id,
      latencyMs: r.latencyMs || null,
    };
  } catch (e) {
    console.error('generateToolCommentary failed:', e.message);
    await safeEvent(store, chatId, 'tool_commentary_failed', {
      experimentId: row.id,
      error: e.message,
    });
    return { error: e.message };
  }
}

// ============ tryAutoCorrect — v7.2 ============
async function tryAutoCorrect(env, originalRow, failedResult) {
  const chatId = originalRow.chat_id;
  const nowMs = Date.now();

  const budget = await env.DB.prepare('SELECT granted,used,expires_at FROM tool_budgets WHERE chat_id=?').bind(chatId).first();
  if (!budget) return null;
  const expired = budget.expires_at && Number(budget.expires_at) < nowMs;
  const exhausted = Number(budget.used) >= Number(budget.granted);

  if (expired || exhausted) {
    const store = d1ContextStore(env.DB);
    await safeEvent(store, chatId, 'tool_budget_exhausted', {
      experimentId: originalRow.id, reason: expired ? 'expired' : 'exhausted',
      granted: budget.granted, used: budget.used, expiresAt: budget.expires_at,
    });
    return { requiresRenewal: true, reason: expired ? 'انتهت الصلاحية' : 'استُهلكت الحصة' };
  }

  const recent = await env.DB.prepare(
    'SELECT command FROM experiments WHERE chat_id=? ORDER BY created_at DESC LIMIT 3'
  ).bind(chatId).all();
  const sameCount = (recent.results || []).filter(x => x.command === originalRow.command).length;
  if (sameCount >= 3) {
    const store = d1ContextStore(env.DB);
    await safeEvent(store, chatId, 'tool_correction_aborted', {
      experimentId: originalRow.id, reason: 'same_command_repeated', command: originalRow.command,
    });
    return { aborted: true, reason: 'نفس الأمر تكرر 3 مرات' };
  }

  let taskGoal = '';
  if (originalRow.task_id) {
    const tr = await env.DB.prepare('SELECT task_json FROM tasks WHERE id=?').bind(originalRow.task_id).first();
    if (tr) { try { taskGoal = JSON.parse(tr.task_json).goal || ''; } catch {} }
  }

  let correction;
  try {
    const r = await routeCompletion(env, 'cf-qwen3-coder', [
      { role: 'system', content: 'أنت مصحح أوامر terminal. حلّل الخطأ وأعد JSON فقط بالشكل: {"command":"الأمر الجديد","language":"bash|python","explanation":"سبب الفشل والحل"}. لا تكرر نفس الأمر الفاشل.' },
      { role: 'user', content: `الهدف: ${taskGoal || 'غير محدد'}\nالأمر الفاشل:\n${originalRow.command}\n\nالخطأ:\n${String(failedResult.output || '').slice(0, 3000)}\n\nأعد JSON فقط.` },
    ], { maxTokens: 1200, temperature: .2 });

    const raw = r.text.match(/\{[\s\S]*\}/)?.[0] || '{}';
    correction = JSON.parse(raw);
  } catch (e) {
    return { error: 'فشل التصحيح: ' + e.message };
  }

  if (!correction.command) return { error: 'النموذج لم يقترح أمراً' };

  let safeCommand;
  try { safeCommand = validateCommand(correction.command); }
  catch (e) {
    const store = d1ContextStore(env.DB);
    await safeEvent(store, chatId, 'tool_correction_rejected', {
      experimentId: originalRow.id, command: correction.command, reason: e.message,
    });
    return { rejected: true, reason: e.message };
  }

  if (safeCommand === originalRow.command) return { aborted: true, reason: 'نفس الأمر' };

  const proposalId = 'proposal_correction_' + crypto.randomUUID();
  const store = d1ContextStore(env.DB);
  await safeEvent(store, chatId, 'tool_correction_proposed', {
    originalId: originalRow.id,
    proposalId,
    proposedCommand: safeCommand,
    explanation: correction.explanation || '',
    requiresUserApproval: true,
  });

  return {
    needsApproval: true,
    proposal: {
      id: proposalId,
      kind: 'terminal',
      language: correction.language === 'python' ? 'python' : 'bash',
      command: safeCommand,
      explanation: String(correction.explanation || '').slice(0, 500),
      requiresApproval: true,
      isCorrection: true,
      originalExperimentId: originalRow.id,
    },
    reason: 'التصحيح التلقائي يتطلب موافقتك',
  };
}

// ============ memory / messages / searchAll / listConversations / chatEvents ============
async function memory(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const store = d1ContextStore(env.DB);
  if (b.action === 'memory_update') {
    const state = mergeContext(await store.get(b.chatId), { summary: text(b.content).slice(0, 2000) });
    await store.put(b.chatId, state);
    return json({ success: true, content: renderHandoff(state, []) });
  }
  const state = await store.get(b.chatId);
  return json({ content: renderHandoff(state, []), state });
}

async function messages(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const files = await env.DB.prepare('SELECT id,name,mime,size,created_at FROM conversation_files WHERE chat_id=? ORDER BY created_at DESC').bind(b.chatId).all();
  return json({ messages: await loadMessages(env, b.chatId), files: files.results || [] });
}

async function searchAll(env, b) {
  const q = text(b.query).slice(0, 120);
  if (!q) return json({ conversations: [], messages: [], files: [] });
  const like = `%${q}%`, chatId = b.chatId || null;
  const conversations = chatId ? { results: [] } : await env.DB.prepare('SELECT id,title,updated_at FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 30').bind(like).all();
  const msgs = chatId
    ? await env.DB.prepare('SELECT id,chat_id,role,content,created_at FROM messages WHERE chat_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 50').bind(chatId, like).all()
    : await env.DB.prepare('SELECT id,chat_id,role,content,created_at FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 50').bind(like).all();
  const files = chatId
    ? await env.DB.prepare('SELECT id,chat_id,name,mime,size,content_text,created_at FROM conversation_files WHERE chat_id=? AND (name LIKE ? OR content_text LIKE ?) ORDER BY created_at DESC LIMIT 50').bind(chatId, like, like).all()
    : await env.DB.prepare('SELECT id,chat_id,name,mime,size,content_text,created_at FROM conversation_files WHERE name LIKE ? OR content_text LIKE ? ORDER BY created_at DESC LIMIT 50').bind(like, like).all();
  return json({ query: q, conversations: conversations.results || [], messages: msgs.results || [], files: files.results || [] });
}

async function listConversations(env, b) {
  const limit = Math.min(100, Math.max(1, Number(b.limit) || 50));
  const r = await env.DB.prepare(`SELECT c.id,c.title,c.updated_at,
    (SELECT t.id FROM tasks t WHERE t.chat_id=c.id ORDER BY t.created_at DESC LIMIT 1) as task_id,
    (SELECT t.task_json FROM tasks t WHERE t.chat_id=c.id ORDER BY t.created_at DESC LIMIT 1) as task_json,
    (SELECT tc.status FROM task_control tc WHERE tc.task_id=(SELECT t2.id FROM tasks t2 WHERE t2.chat_id=c.id ORDER BY t2.created_at DESC LIMIT 1)) as control_status
    FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`).bind(limit).all();
  const conversations = (r.results || []).map(row => {
    let task = null;
    if (row.task_json) { try { task = JSON.parse(row.task_json); } catch { task = null; } }
    return { id: row.id, title: row.title, updatedAt: row.updated_at, taskId: row.task_id || null, taskStatus: row.control_status || task?.status || null, taskGoal: task?.goal || null };
  });
  return json({ conversations });
}

async function chatEvents(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const r = await env.DB.prepare('SELECT id,type,payload_json,created_at FROM context_events WHERE chat_id=? ORDER BY created_at ASC LIMIT 300').bind(b.chatId).all();
  return json({ events: (r.results || []).map(x => ({ id: x.id, type: x.type, payload: JSON.parse(x.payload_json || '{}'), createdAt: x.created_at })) });
}

// ============ settings / conversationControl / taskControl / advance / intervene / events / downloadFile ============
async function settings(env, b) {
  if (b.action === 'settings_get') {
    const r = await env.DB.prepare('SELECT key,value_json FROM settings ORDER BY key').all();
    return json({ settings: (r.results || []).map(x => ({ key: x.key, value: JSON.parse(x.value_json) })) });
  }
  if (!b.key) return json({ error: 'key مطلوب' }, 400);
  if (b.key.includes('API_KEY') || b.key.includes('TOKEN') || b.key.includes('PASSWORD')) return json({ error: 'المفاتيح السرية تُدار من Cloudflare Secrets' }, 400);
  await env.DB.prepare('INSERT INTO settings (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=?,updated_at=?').bind(b.key, JSON.stringify(b.value ?? null), Date.now(), JSON.stringify(b.value ?? null), Date.now()).run();
  return json({ success: true });
}

async function conversationControl(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  if (b.action === 'rename_conversation') {
    const title = text(b.title).slice(0, 120);
    if (!title) return json({ error: 'العنوان مطلوب' }, 400);
    await env.DB.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').bind(title, Date.now(), b.chatId).run();
    return json({ success: true, title });
  }
  if (b.action === 'delete_conversation') {
    await env.DB.prepare('DELETE FROM conversation_files WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM messages WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM context_state WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM context_events WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM conversations WHERE id=?').bind(b.chatId).run();
    return json({ success: true });
  }
  return json({ error: 'إجراء محادثة غير معروف' }, 400);
}

async function taskControl(env, b) {
  if (!b.taskId) return json({ error: 'taskId مطلوب' }, 400);
  const row = await env.DB.prepare('SELECT task_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!row) return json({ error: 'المهمة غير موجودة' }, 404);
  const status = b.action === 'cancel_task' ? 'cancelled' : b.action === 'pause_task' ? 'paused' : b.action === 'resume_task' ? 'running' : null;
  if (!status) return json({ error: 'إجراء تحكم غير معروف' }, 400);
  const timestamp = Date.now();
  await env.DB.prepare('INSERT INTO task_control (task_id,status,updated_at) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=?,updated_at=?').bind(b.taskId, status, timestamp, status, timestamp).run();
  return json({ success: true, taskId: b.taskId, status, updatedAt: timestamp });
}

async function advance(env, b) {
  if (!b.taskId) return json({ error: 'taskId مطلوب' }, 400);
  const result = await advanceTask(env, b.taskId, { modelId: b.model, maxSteps: b.maxSteps || 3 });
  return json(result);
}

async function intervene(env, b) {
  if (!b.taskId || !text(b.content)) return json({ error: 'taskId و content مطلوبان' }, 400);
  const result = await addIntervention(env, b.taskId, b.content);
  const run = b.advance !== false ? await advanceTask(env, b.taskId, { modelId: b.model, maxSteps: 1 }) : null;
  return json({ success: true, ...result, run });
}

async function events(env, b) {
  if (!b.taskId) return json({ error: 'taskId مطلوب' }, 400);
  return json({ events: await taskEvents(env, b.taskId) });
}

async function downloadFile(env, b) {
  if (!b.assetId) return json({ error: 'assetId مطلوب' }, 400);
  const r = await downloadReleaseAsset(env, b.assetId);
  return new Response(r.body, { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=3600', ...CORS } });
}

async function poll(env, b) {
  if (!b.chatId) return json({ error: 'chatId مطلوب' }, 400);
  const since = Number(b.since) || 0;
  const [eventsR, expR, budgetR] = await Promise.all([
    env.DB.prepare('SELECT id,type,payload_json,created_at FROM context_events WHERE chat_id=? AND created_at > ? ORDER BY created_at ASC LIMIT 100').bind(b.chatId, since).all(),
    env.DB.prepare('SELECT id,command,status,exit_code,created_at,updated_at FROM experiments WHERE chat_id=? ORDER BY created_at DESC LIMIT 10').bind(b.chatId).all(),
    env.DB.prepare('SELECT granted,used,expires_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first(),
  ]);
  return json({
    now: Date.now(),
    events: (eventsR.results || []).map(x => ({ id: x.id, type: x.type, payload: JSON.parse(x.payload_json || '{}'), createdAt: x.created_at })),
    experiments: expR.results || [],
    budget: budgetR ? { granted: budgetR.granted, used: budgetR.used, remaining: Math.max(0, Number(budgetR.granted) - Number(budgetR.used)), expiresAt: budgetR.expires_at, expired: !!(budgetR.expires_at && budgetR.expires_at < Date.now()) } : null,
  });
}

// ============ Router ============
export { persistFiles };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const pathname = new URL(request.url).pathname;

    if (pathname === '/tool-result') return receiveToolResult(env, request);

    if (request.method === 'GET') {
      if ((pathname === '/' || pathname === '/index.html') && env.ASSETS) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      }
      return json({ name: 'FOX AI', status: 'ready', version: '7.2.0' });
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    try {
      await schema(env);
      const b = await request.json();

      if (b.action === 'models') return json({ models: publicCatalog() });
      if (b.action === 'login') return login(env, b, request);
      if (b.action === 'check_session') return checkSession(env, b);
      if (b.action === 'logout') return logout(env, b);

      if (!await session(env, b.sessionToken)) return json({ error: 'الجلسة غير صالحة', authRequired: true }, 401);

      if (b.action === 'chat') return chat(env, b);
      if (b.action === 'poll') return poll(env, b);
      if (b.action === 'get_messages') return messages(env, b);
      if (b.action === 'list_conversations') return listConversations(env, b);
      if (b.action === 'chat_events') return chatEvents(env, b);
      if (b.action === 'search_all') return searchAll(env, b);
      if (b.action === 'plan_task') return plan(env, b);
      if (b.action === 'advance_task') return advance(env, b);
      if (b.action === 'task_intervention') return intervene(env, b);
      if (b.action === 'task_events') return events(env, b);
      if (b.action === 'get_memory' || b.action === 'memory_update') return memory(env, b);
      if (b.action === 'get_run') return getRun(env, b);
      if (b.action === 'get_task_control') return getTaskControl(env, b);
      if (b.action === 'step_control') return stepControl(env, b);
      if (b.action === 'get_experiment') return getExperiment(env, b);
      if (b.action === 'get_experiments') return getExperiments(env, b);
      if (b.action === 'cancel_experiment') return cancelExperimentRun(env, b);
      if (b.action === 'download_file') return downloadFile(env, b);
      if (b.action === 'tool_proposal') return toolProposal(env, b);
      if (b.action === 'tool_budget') return toolBudget(env, b);
      if (b.action === 'renew_tool_budget') return renewToolBudget(env, b);
      if (b.action === 'workspace_status') return workspaceStatus(env, b);
      if (b.action === 'run_tool') return runTool(env, b);
      if (b.action === 'usage') return json(await getUsageFromGateway(env));
      if (['settings_get', 'settings_set'].includes(b.action)) return settings(env, b);
      if (['rename_conversation', 'delete_conversation'].includes(b.action)) return conversationControl(env, b);
      if (['cancel_task', 'pause_task', 'resume_task'].includes(b.action)) return taskControl(env, b);
      return json({ error: 'إجراء غير معروف' }, 404);
    } catch (e) {
      console.error(e);
      const status = e instanceof ProviderError ? e.status : 500;
      return json({ error: e.message || 'خطأ داخلي', provider: e.provider || null, retryable: !!e.retryable }, status);
    }
  },
};