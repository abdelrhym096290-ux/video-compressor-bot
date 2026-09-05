

// ===== Embedded FOX// AI modules =====
const MODEL_CATALOG = [
  { id: 'cerebras-gemma-4-31b', provider: 'cerebras', model: 'gemma-4-31b', name: 'Gemma 4 31B', company: 'Cerebras', kind: 'chat' },
  { id: 'cerebras-qwen-3.8-27b', provider: 'cerebras', model: 'qwen-3.8-27b', name: 'Qwen 3.8 27B', company: 'Cerebras', kind: 'chat' },
  { id: 'cerebras-gpt-oss-120b', provider: 'cerebras', model: 'gpt-oss-120b', name: 'GPT-OSS 120B', company: 'Cerebras', kind: 'chat' },
  { id: 'gemini-5-flash-lite', provider: 'gemini', model: 'gemini-5.0-flash-lite', name: 'Flash 5 Lite', company: 'Google', kind: 'chat' },
  { id: 'gemini-5-flash', provider: 'gemini', model: 'gemini-5.0-flash', name: 'Flash 5', company: 'Google', kind: 'chat' },
  { id: 'gemini-6-flash', provider: 'gemini', model: 'gemini-6.0-flash', name: 'Flash 6', company: 'Google', kind: 'chat' },
  { id: 'gemini-7-flash', provider: 'gemini', model: 'gemini-7.0-flash', name: 'Flash 7', company: 'Google', kind: 'chat' },
  { id: 'cf-glm-flash', provider: 'workers-ai', model: '@cf/zai-org/glm-4.7-flash', name: 'GLM 4.7 Flash', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-qwen3-coder', provider: 'workers-ai', model: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 Coder', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-coder', provider: 'workers-ai', model: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen Coder', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-qwen3', provider: 'workers-ai', model: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen 3', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-gpt-oss-20b', provider: 'workers-ai', model: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-gemma-4', provider: 'workers-ai', model: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-nemotron', provider: 'workers-ai', model: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-gpt-oss-120b', provider: 'workers-ai', model: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-deepseek-r1', provider: 'workers-ai', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-qwq', provider: 'workers-ai', model: '@cf/qwen/qwq-32b', name: 'QwQ', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-llama-4', provider: 'workers-ai', model: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-mistral', provider: 'workers-ai', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-llama-70b', provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 70B', company: 'Cloudflare', kind: 'chat' },
  { id: 'cf-llama-vision', provider: 'workers-ai', model: '@cf/meta/llama-3.2-11b-vision-instruct', name: 'Llama Vision', company: 'Cloudflare', kind: 'vision' },
  { id: 'cf-granite', provider: 'workers-ai', model: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite', company: 'Cloudflare', kind: 'chat' },
];

function getModel(id) { return MODEL_CATALOG.find(x => x.id === id) || MODEL_CATALOG[0]; }
function chooseModel(text = '') { const t = String(text).toLowerCase(); if (/code|كود|برمج|terminal|طرفية|debug|تصحيح/.test(t)) return getModel('cerebras-qwen-3.8-27b'); if (/image|صورة|vision|صوّر/.test(t)) return getModel('cf-llama-vision'); if (/plan|خطة|حلل|بحث|research|تحليل/.test(t)) return getModel('cerebras-gpt-oss-120b'); return getModel('cerebras-gemma-4-31b'); }

async function complete(env, modelId, messages, options = {}) {
  const spec = getModel(modelId);
  if (spec.provider === 'cerebras') return openAICompatible(env.CEREBRAS_API_KEY, 'https://api.cerebras.ai/v1/chat/completions', spec.model, messages, options);
  if (spec.provider === 'gemini') return gemini(env.GEMINI_API_KEY, spec.model, messages, options);
  if (spec.provider === 'workers-ai') return workersAI(env, spec.model, messages, options);
  throw new Error(`مزود غير مدعوم: ${spec.provider}`);
}

async function openAICompatible(key, url, model, messages, options) {
  if (!key) throw new Error('مفتاح مزود النموذج غير موجود في أسرار العامل');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 4096 }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Provider error ${r.status}`);
  return d.choices?.[0]?.message?.content || '';
}

async function gemini(key, model, messages, options) {
  if (!key) throw new Error('GEMINI_API_KEY غير موجود');
  const system = messages.find(m => m.role === 'system')?.content;
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Gemini error ${r.status}`);
  return d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

async function workersAI(env, model, messages, options) {
  const d = await env.AI.run(model, { messages, max_tokens: options.maxTokens ?? 4096 });
  return d.response || d.choices?.[0]?.message?.content || '';
}

function publicCatalog() { return MODEL_CATALOG.map(({ id, name, company, provider }) => ({ id, name, company, provider })); }

const LIMIT = 14;

async function loadContext(env, chatId, messages = []) {
  let memory = '';
  if (chatId) {
    const row = await env.DB.prepare('SELECT content FROM project_memory WHERE chat_id = ?').bind(chatId).first();
    memory = row?.content || '';
  }
  return { memory, recent: messages.slice(-LIMIT).map(m => ({ role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user', content: String(m.content || '') })) };
}

function systemPrompt(memory) { return `أنت FOX// AI، وكيل شخصي يخطط بوضوح وينفذ الأدوات فقط بعد موافقة المستخدم. افصل بين ما تعرفه وما تقترحه. لا تدّع تنفيذ شيء لم تنفذه. استخدم العربية إن كانت رسالة المستخدم عربية.\n\n## ملخص التسليم من الذاكرة\n${memory || '(لا يوجد ملخص بعد)'}`; }

async function refreshMemory(env, chatId, oldMemory, user, answer, complete) {
  if (!chatId) return oldMemory || '';
  const prompt = `أنشئ ملخص تسليم دقيقًا ومضغوطًا ليستطيع نموذج آخر متابعة هذه المحادثة. العناوين الإلزامية: الهدف، متطلبات المستخدم، القرارات، ما تم، المشاكل/القيود، الخطوة التالية. لا تضف تخمينًا.\n\nالملخص السابق:\n${oldMemory || '(فارغ)'}\n\nالمستخدم:\n${user}\n\nالرد:\n${answer}`;
  const next = await complete([{ role: 'system', content: 'أنت مدير ذاكرة سياقية.' }, { role: 'user', content: prompt }], { maxTokens: 1800 });
  const value = next.trim() || oldMemory || '';
  await env.DB.prepare('INSERT INTO project_memory (chat_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET content = ?, updated_at = ?').bind(chatId, value, Date.now(), value, Date.now()).run();
  return value;
}

function detectProposedCommand(text) {
  const m = String(text || '').match(/```(?:bash|sh|shell|python)\n([\s\S]*?)```/i);
  return m ? { command: m[1].trim(), language: /python/i.test(m[0]) ? 'python' : 'bash', requiresApproval: true } : null;
}

function agentPolicy() {
  return 'الأدوات المتاحة حاليًا: اقتراح أوامر فقط. لا تنفّذ أمرًا ولا تطلب صلاحيات إضافية تلقائيًا. إذا احتاجت المهمة تنفيذًا، قدم خطة ثم كتلة أمر واضحة ليوافق المستخدم عليها صراحة.';
}


async function createPlan(env, modelId, task, memory = '') {
  const prompt = `حوّل المهمة التالية إلى خطة تنفيذ عملية من 3 إلى 8 خطوات. أعد JSON فقط بالشكل {"goal":"...","steps":[{"id":"step-1","title":"...","description":"...","tool":"none|terminal|files|web","verification":"..."}]}. لا تنفذ شيئًا ولا تخترع وصولًا.\nالمهمة: ${task}\nالسياق: ${memory}`;
  try {
    const raw = await complete(env, modelId, [{ role: 'system', content: agentPolicy() }, { role: 'user', content: prompt }], { maxTokens: 1800, temperature: 0.1 });
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (Array.isArray(parsed.steps) && parsed.steps.length) return normalizePlan(parsed, task);
  } catch (e) { console.error('planner', e); }
  return normalizePlan({ goal: task, steps: [{ title: 'تحليل المتطلبات', description: task, tool: 'none', verification: 'تأكيد المطلوب' }, { title: 'اقتراح التنفيذ', description: 'إعداد خطة قابلة للمراجعة', tool: 'none', verification: 'مراجعة المستخدم' }] }, task);
}
function normalizePlan(plan, task) { return { id: crypto.randomUUID(), goal: plan.goal || task, status: 'draft', steps: plan.steps.map((s, i) => ({ id: s.id || `step-${i + 1}`, title: s.title || `الخطوة ${i + 1}`, description: s.description || '', tool: s.tool || 'none', verification: s.verification || '', status: 'pending', attempts: 0, output: '' })) }; }
async function saveRun(env, chatId, plan) { const now = Date.now(); await env.DB.prepare('INSERT INTO agent_runs (id, chat_id, goal, plan_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(plan.id, chatId, plan.goal, JSON.stringify(plan), plan.status, now, now).run(); return plan; }
async function readRun(env, id) { const row = await env.DB.prepare('SELECT * FROM agent_runs WHERE id = ?').bind(id).first(); if (!row) return null; return { ...row, plan: JSON.parse(row.plan_json) }; }
async function updateRun(env, run) { const now = Date.now(); await env.DB.prepare('UPDATE agent_runs SET plan_json = ?, status = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(run.plan), run.plan.status, now, run.id).run(); return run; }
async function approvePlan(env, runId) { const run = await readRun(env, runId); if (!run) throw new Error('المهمة غير موجودة'); run.plan.status = 'running'; run.plan.steps[0].status = 'running'; await updateRun(env, run); return run; }

async function updateStep(env, runId, stepId, patch = {}) {
  const run = await readRun(env, runId); if (!run) throw new Error('المهمة غير موجودة');
  const step = run.plan.steps.find(s => s.id === stepId); if (!step) throw new Error('الخطوة غير موجودة');
  if (patch.status === 'retrying') { step.attempts = (step.attempts || 0) + 1; step.status = step.attempts > 3 ? 'failed' : 'running'; }
  else Object.assign(step, { status: patch.status || step.status, output: patch.output ?? step.output });
  if (step.status === 'completed') { const next = run.plan.steps.find(s => s.status === 'pending'); if (next) next.status = 'running'; else run.plan.status = 'completed'; }
  if (step.status === 'failed') run.plan.status = 'paused';
  await updateRun(env, run); return run;
}


async function advanceRun(env, runId, modelId) {
  const run = await readRun(env, runId);
  if (!run) throw new Error('المهمة غير موجودة');
  if (run.plan.status === 'draft') throw new Error('الخطة تحتاج موافقة صريحة أولاً');
  const step = run.plan.steps.find(s => s.status === 'running' || s.status === 'pending');
  if (!step) return run;
  if (step.status === 'pending') { step.status = 'running'; await updateRun(env, run); }
  const prompt = `نفّذ تحليليًا الخطوة التالية ضمن وكيل آمن. لا تدّع تنفيذ أدوات خارجية. أعد JSON فقط: {"result":"...","needsTerminal":false,"command":"","verification":"...","success":true}.\nالهدف: ${run.goal}\nالخطوة: ${step.title}\nالوصف: ${step.description}\nالتحقق المطلوب: ${step.verification}`;
  const raw = await complete(env, modelId, [{ role: 'system', content: 'أنت منفذ خطوات دقيق. لا تنفذ أوامر تلقائيًا.' }, { role: 'user', content: prompt }], { maxTokens: 1600, temperature: 0.1 });
  let result; try { result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch { result = { result: raw, success: true }; }
  step.output = result.result || raw; step.verification = result.verification || step.verification;
  if (result.needsTerminal && result.command) { step.status = 'awaiting_approval'; step.command = result.command; run.plan.status = 'paused'; }
  else if (result.success === false) { step.status = 'failed'; run.plan.status = 'paused'; }
  else { step.status = 'completed'; const next = run.plan.steps.find(s => s.status === 'pending'); if (next) next.status = 'running'; else run.plan.status = 'completed'; }
  await updateRun(env, run); return run;
}

async function dispatchCommand(env, chatId, command) {
  if (!command || command.length > 12000) throw new Error('أمر غير صالح أو طويل جدًا');
  const id = Date.now(); const now = id;
  await env.DB.prepare('INSERT INTO experiments (id, chat_id, command, status, output, exit_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, chatId, command, 'pending', '', null, now, now).run();
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN غير مهيأ');
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO || 'abdelrhym096290-ux/video-compressor-bot'}/actions/workflows/${env.GITHUB_WORKFLOW || 'terminal.yml'}/dispatches`, { method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, body: JSON.stringify({ ref: 'main', inputs: { command, experimentId: id } }) });
  if (!r.ok) { await env.DB.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').bind('failed', Date.now(), id).run(); throw new Error(`فشل إرسال التجربة: ${r.status}`); }
  return { id, status: 'pending', command };
}
async function listExperiments(env) { const r = await env.DB.prepare('SELECT id, chat_id, command, status, output, exit_code, created_at, updated_at FROM experiments ORDER BY created_at DESC LIMIT 30').all(); return r.results || []; }

// ===== FOX// AI Worker API =====

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

export default { async fetch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method === 'GET') return json({ name: 'FOX// AI', status: 'ready', version: '2.0.0' });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    if (new URL(request.url).pathname === '/result') return receiveResult(env, request);
    const body = await request.json();
    await ensureAgentSchema(env);
    const action = body.action;
    if (action === 'models') return json({ models: publicCatalog() });
    if (action === 'login') return login(env, request, body);
    if (action === 'check_session') return json({ valid: await validSession(env, body.sessionToken) });
    if (action === 'logout') { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(body.sessionToken || '').run(); return json({ success: true }); }
    if (!await validSession(env, body.sessionToken)) return json({ error: 'الجلسة غير صالحة', authRequired: true }, 401);
    if (action === 'get_memory') return getMemory(env, body.chatId);
    if (action === 'memory_update') return saveMemory(env, body.chatId, body.content || '');
    if (action === 'plan_task') return planTask(env, body);
    if (action === 'get_run') return json(await readRun(env, body.runId) || { error: 'المهمة غير موجودة' }, 200);
    if (action === 'approve_plan') return json(await approvePlan(env, body.runId));
    if (action === 'update_step') return json(await updateStep(env, body.runId, body.stepId, { status: body.status, output: body.output }));
    if (action === 'retry_step') return json(await updateStep(env, body.runId, body.stepId, { status: 'retrying' }));
    if (action === 'advance_run') return json(await advanceRun(env, body.runId, body.model || body.provider));
    if (action === 'get_experiments') return json({ experiments: await listExperiments(env) });
    if (action === 'run_command') return json(await dispatchCommand(env, body.chatId, body.command));
    if (action === 'chat') return chat(env, body);
    if (action === 'approve_tool') return json({ error: 'تنفيذ الأدوات يحتاج ربط منفصل وموافقة صريحة' }, 501);
    return json({ error: 'إجراء غير معروف' }, 400);
  } catch (e) { console.error(e); return json({ error: e.message || 'خطأ داخلي' }, 500); }
} };

async function login(env, request, body) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const row = await env.DB.prepare('SELECT attempts, locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
  const now = Date.now();
  if (row?.locked_until > now) return json({ error: 'محاولات كثيرة، حاول لاحقًا' }, 429);
  if (body.accessPassword !== env.ACCESS_PASSWORD) {
    const attempts = (row?.attempts || 0) + 1; const lock = attempts >= 5 ? now + 600000 : null;
    await env.DB.prepare('INSERT INTO login_attempts (ip, attempts, locked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET attempts = ?, locked_until = ?, updated_at = ?').bind(ip, attempts, lock, now, attempts, lock, now).run();
    return json({ error: 'كلمة المرور غير صحيحة', authRequired: true }, 401);
  }
  const token = crypto.randomUUID(); const expires = now + 86400000;
  await env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)').bind(token, now, expires).run();
  return json({ success: true, token, expiresAt: expires });
}

async function validSession(env, token) {
  if (!token) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(token).first();
  return !!row && row.expires_at > Date.now();
}

async function getMemory(env, chatId) {
  if (!chatId) return json({ error: 'chatId مطلوب' }, 400);
  const row = await env.DB.prepare('SELECT content, updated_at FROM project_memory WHERE chat_id = ?').bind(chatId).first();
  return json({ content: row?.content || '', updatedAt: row?.updated_at || null });
}

async function saveMemory(env, chatId, content) {
  if (!chatId) return json({ error: 'chatId مطلوب' }, 400);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO project_memory (chat_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET content = ?, updated_at = ?').bind(chatId, content, now, content, now).run();
  return json({ success: true, content });
}

async function chat(env, body) {
  if (!body.chatId || !Array.isArray(body.messages) || !body.messages.length) return json({ error: 'chatId والرسائل مطلوبان' }, 400);
  const selected = body.model || body.provider ? getModel(body.model || body.provider) : chooseModel(body.messages.at(-1)?.content);
  const context = await loadContext(env, body.chatId, body.messages);
  const messages = [{ role: 'system', content: systemPrompt(context.memory) + '\n\n' + agentPolicy() }, ...context.recent];
  const answer = await complete(env, selected.id, messages, { maxTokens: 4096 });
  const last = context.recent.filter(m => m.role === 'user').at(-1)?.content || '';
  let memory = context.memory;
  try { memory = await refreshMemory(env, body.chatId, context.memory, last, answer, (m, o) => complete(env, selected.id, m, o)); } catch (e) { console.error('context refresh', e); }
  return json({ response: answer, model: selected, memory, pendingExecution: detectProposedCommand(answer), trace: { provider: selected.provider, model: selected.model, contextMessages: context.recent.length, memoryUpdated: memory !== context.memory } });
}

async function planTask(env, body) {
  if (!body.chatId || !body.task) return json({ error: 'chatId و task مطلوبان' }, 400);
  const context = await loadContext(env, body.chatId, []);
  const selected = body.model || body.provider ? getModel(body.model || body.provider) : chooseModel(body.task);
  const plan = await createPlan(env, selected.id, body.task, context.memory);
  await saveRun(env, body.chatId, plan);
  return json({ plan });
}

async function receiveResult(env, request) {
  const raw = await request.text();
  const signature = (request.headers.get('X-FOX-Signature') || '').replace('sha256=', '');
  if (!env.HMAC_SECRET || !(await verifyHmac(raw, signature, env.HMAC_SECRET))) return json({ error: 'توقيع النتيجة غير صالح' }, 403);
  const body = JSON.parse(raw);
  if (!body.experimentId) return json({ error: 'experimentId مطلوب' }, 400);
  await env.DB.prepare('UPDATE experiments SET status = ?, output = ?, exit_code = ?, updated_at = ? WHERE id = ?').bind(body.exit_code === 0 ? 'completed' : 'failed', body.output || '', body.exit_code ?? 1, Date.now(), body.experimentId).run();
  return json({ success: true, experimentId: body.experimentId });
}

async function verifyHmac(text, expected, secret) {
  if (!expected) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  const actual = Array.from(new Uint8Array(sig)).map(x => x.toString(16).padStart(2, '0')).join('');
  return actual.length === expected.length && actual.split('').every((x, i) => x === expected[i]);
}

async function ensureAgentSchema(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, goal TEXT NOT NULL, plan_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_id, updated_at DESC)').run();
}

export class ExperimentState { constructor(state) { this.state = state; } async fetch() { return json({ error: 'Execution service is isolated from the agent core' }, 501); } }
