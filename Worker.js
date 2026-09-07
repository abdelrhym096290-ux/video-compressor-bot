import { publicCatalog, getModel, chooseModel } from './src/catalog.js';
import { routeCompletion, ProviderError } from './src/providers.js';
import { d1ContextStore, contextPacket, renderHandoff, mergeContext, createContextEvent } from './src/context.js';
import { createTask, startPlanning, createPlan, approvePlan, startStep, completeStep, failStep, retryStep } from './src/tasks.js';
import { detectToolProposal, approvalRecord, experimentRecord, dispatchExperiment, cancelExperiment, verifyResult, verifyWebhook } from './src/tools.js';
import { uploadReleaseAsset, downloadReleaseAsset, MAX_DIRECT_UPLOAD } from './src/storage.js';
import { multimodalMessages } from './src/media.js';
import { advanceTask, addIntervention, taskEvents } from './src/orchestrator.js';

const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json;charset=utf-8', ...CORS}});
const text = x => String(x || '').trim();

// Compatibility export
export class ExperimentState {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() { return json({name:'ExperimentState', status:'compatible'}); }
}

// ============ Database Schema ============
async function schema(env) {
  const queries = [
    'CREATE TABLE IF NOT EXISTS context_state (chat_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS context_events (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, task_json TEXT NOT NULL, plan_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, exit_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, task_id TEXT, step_id TEXT, run_id TEXT)',
    'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at ASC)',
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tool_budgets (chat_id TEXT PRIMARY KEY, granted INTEGER NOT NULL, used INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS conversation_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content_text TEXT, data_url TEXT, storage TEXT, asset_id TEXT, asset_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_files_chat ON conversation_files(chat_id, created_at DESC)',
    'CREATE TABLE IF NOT EXISTS task_control (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at ASC)',
    'CREATE TABLE IF NOT EXISTS task_runtime (task_id TEXT PRIMARY KEY, lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT \'idle\', last_error TEXT, next_run_at INTEGER, updated_at INTEGER NOT NULL)'
  ];
  
  for (const sql of queries) {
    await env.DB.prepare(sql).run();
  }
}

// ============ Tool Proposal ============
async function toolProposal(env, b) {
  const proposal = detectToolProposal(b.text || b.content || '');
  return json({proposal});
}

// ============ Run Tool ============
async function runTool(env, b) {
  const proposal = b.proposal;
  if (!proposal) return json({error:'proposal مطلوب'}, 400);
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  
  let budget = await env.DB.prepare('SELECT chat_id, granted, used, updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  const requested = Math.max(1, Math.min(10, Number(b.approvalBudget) || 5));
  
  if (b.approved !== true) {
    return json({needsApproval:true, reason:'لا يمكن تشغيل الطرفية دون موافقة', proposal, budget: budget ? {granted:budget.granted, used:budget.used, remaining:Math.max(0, budget.granted-budget.used)} : null}, 403);
  }
  
  if (!budget) {
    const timestamp = Date.now();
    await env.DB.prepare('INSERT INTO tool_budgets (chat_id, granted, used, updated_at) VALUES (?,?,?,?)').bind(b.chatId, requested, 0, timestamp).run();
    budget = {chat_id:b.chatId, granted:requested, used:0, updated_at:timestamp};
  } else if (Number(budget.used) >= Number(budget.granted)) {
    const renewal = Math.max(1, Math.min(10, Number(b.renewBudget) || 0));
    if (!renewal) {
      return json({needsApproval:true, reason:'انتهت حصة تنفيذ الطرفية. اختر 5 أو 10 عمليات جديدة.', proposal, budget:{granted:budget.granted, used:budget.used, remaining:0}}, 403);
    }
    const timestamp = Date.now();
    await env.DB.prepare('UPDATE tool_budgets SET granted=?, used=0, updated_at=? WHERE chat_id=?').bind(renewal, timestamp, b.chatId).run();
    budget = {...budget, granted:renewal, used:0, updated_at:timestamp};
  }
  
  const remaining = Number(budget.granted) - Number(budget.used);
  const approval = approvalRecord({proposalId:proposal.id, approved:true, scope:`budget_${budget.granted}`});
  const experiment = {
    ...experimentRecord({chatId:b.chatId, proposal, approval}),
    taskId: b.taskId || null,
    stepId: b.stepId || null
  };
  
  await env.DB.prepare('UPDATE tool_budgets SET used=used+1, updated_at=? WHERE chat_id=?').bind(Date.now(), b.chatId).run();
  await env.DB.prepare('INSERT INTO experiments (id, chat_id, command, status, output, exit_code, created_at, updated_at, task_id, step_id, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(experiment.id, experiment.chatId, experiment.command, experiment.status, '', null, experiment.createdAt, experiment.updatedAt, experiment.taskId, experiment.stepId, null).run();
  
  const dispatched = await dispatchExperiment(env, experiment);
  await env.DB.prepare('UPDATE experiments SET status=?, run_id=?, updated_at=? WHERE id=?')
    .bind(dispatched.status, dispatched.runId || null, dispatched.updatedAt, dispatched.id).run();
  
  return json({experiment:dispatched, budget:{granted:budget.granted, used:Number(budget.used)+1, remaining:remaining-1}});
}

// ============ Tool Budget ============
async function toolBudget(env, b) {
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  const r = await env.DB.prepare('SELECT chat_id, granted, used, updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  return json({budget: r ? {granted:r.granted, used:r.used, remaining:Math.max(0, Number(r.granted)-Number(r.used)), updatedAt:r.updated_at} : {granted:0, used:0, remaining:0}});
}

// ============ Workspace Status ============
async function workspaceStatus(env, b) {
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  
  const files = await env.DB.prepare('SELECT id, name, mime, size, storage, asset_id, asset_url, created_at FROM conversation_files WHERE chat_id=? ORDER BY created_at DESC LIMIT 100').bind(b.chatId).all();
  const experiments = await env.DB.prepare('SELECT id, command, status, exit_code, created_at, updated_at FROM experiments WHERE chat_id=? ORDER BY created_at DESC LIMIT 30').bind(b.chatId).all();
  const budget = await env.DB.prepare('SELECT granted, used, updated_at FROM tool_budgets WHERE chat_id=?').bind(b.chatId).first();
  
  return json({
    workspace: {
      type: 'fox-session',
      persistentFiles: true,
      terminal: 'github-actions',
      storage: env.GITHUB_ASSET_REPO ? 'github-release+d1' : 'd1-only',
      files: files.results || [],
      experiments: experiments.results || [],
      budget: budget ? {granted:budget.granted, used:budget.used, remaining:Math.max(0, Number(budget.granted)-Number(budget.used))} : {granted:0, used:0, remaining:0}
    }
  });
}

// ============ Receive Tool Result ============
async function receiveToolResult(env, request) {
  const raw = await request.text();
  const sig = request.headers.get('X-FOX-Signature') || '';
  
  if (!await verifyWebhook(raw, sig, env.HMAC_SECRET)) {
    return json({error:'توقيع النتيجة غير صالح'}, 403);
  }
  
  const b = JSON.parse(raw);
  const row = await env.DB.prepare('SELECT id, chat_id, command, status, output, exit_code, created_at, updated_at, task_id, step_id, run_id FROM experiments WHERE id=?').bind(b.experimentId).first();
  
  if (!row) return json({error:'التجربة غير موجودة'}, 404);
  
  const result = verifyResult({...row, id:row.id}, {output:b.output || '', exitCode:b.exit_code ?? 1});
  await env.DB.prepare('UPDATE experiments SET status=?, output=?, exit_code=?, updated_at=? WHERE id=?')
    .bind(result.status, result.output, result.exitCode, result.updatedAt, result.id).run();
  
  if (row.task_id && row.step_id) {
    const tr = await env.DB.prepare('SELECT task_json, plan_json FROM tasks WHERE id=?').bind(row.task_id).first();
    if (tr && tr.plan_json) {
      const task = JSON.parse(tr.task_json);
      const plan = JSON.parse(tr.plan_json);
      const rest = plan.steps.filter(x => x.id !== row.step_id && x.status === 'pending');
      const next = rest[0];
      const nextSteps = plan.steps.map(x => 
        x.id === row.step_id ? {...x, status: result.status === 'completed' ? 'completed' : 'failed', output: result.output, exitCode: result.exitCode, completedAt: Date.now()} :
        next && x.id === next.id ? {...x, status:'running', startedAt: Date.now()} : x
      );
      const nextTask = {
        ...task,
        status: result.status === 'completed' ? (next ? 'running' : 'completed') : 'failed',
        currentStepId: next?.id || null,
        updatedAt: Date.now()
      };
      
      await env.DB.prepare('UPDATE tasks SET task_json=?, plan_json=?, updated_at=? WHERE id=?')
        .bind(JSON.stringify(nextTask), JSON.stringify({...plan, steps:nextSteps}), Date.now(), row.task_id).run();
      
      if (result.status === 'completed' && next) {
        const t = await advanceTask(env, row.task_id, {maxSteps:3});
        return json({success:true, experiment:result, run:t});
      }
      return json({success:true, experiment:result, run:{task:nextTask, plan:{...plan, steps:nextSteps}, status:nextTask.status}});
    }
  }
  
  return json({success:true, experiment:result});
}

// ============ Session ============
async function session(env, token) {
  if (!env.ACCESS_PASSWORD) return true;
  if (!token) return false;
  const r = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(token).first();
  return !!r && Number(r.expires_at) > Date.now();
}

// ============ Login ============
async function login(env, body) {
  if (env.ACCESS_PASSWORD && body.accessPassword !== env.ACCESS_PASSWORD) {
    return json({error:'كلمة المرور غير صحيحة', authRequired:true}, 401);
  }
  const token = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?,?,?)').bind(token, now, now + 86400000).run();
  return json({success:true, token, expiresAt: now + 86400000});
}

// ============ System Prompt ============
function system() {
  return 'أنت FOX AI، وكيل شخصي دقيق. مالكك ومطورك هو عبدالرحيم. إذا سُئلت: من صاحبك أو من طورك أو من أنشأك، فأجب بوضوح: أنا FOX AI، طوّرني ويمتلكني عبدالرحيم. لا تدّع تنفيذ شيء لم تنفذه. استخدم العربية عند مخاطبتك بالعربية. افصل الحقائق عن الاقتراحات.';
}

// ============ Persist Message ============
async function persistMessage(env, chatId, role, content, modelId = null) {
  const t = Date.now();
  await env.DB.prepare('INSERT INTO messages (id, chat_id, role, content, model_id, created_at) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), chatId, role, String(content || ''), modelId, t).run();
  await env.DB.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=?')
    .bind(chatId, String(content || '').slice(0, 80) || 'محادثة جديدة', t, t, t).run();
}

// ============ Persist Files ============
async function persistFiles(env, chatId, files = []) {
  for (const f of Array.isArray(files) ? files : []) {
    const id = crypto.randomUUID();
    const name = text(f.name).slice(0, 180) || 'file';
    const mime = text(f.mime || f.type).slice(0, 120) || 'application/octet-stream';
    const size = Math.max(0, Number(f.size) || 0);
    const content = f.text != null ? String(f.text).slice(0, 120000) : null;
    let data = null, storage = null, assetId = null, assetUrl = null;
    
    if (f.data) {
      const raw = String(f.data);
      const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
      if (match) {
        const encoded = match[2];
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        if (bytes.byteLength > MAX_DIRECT_UPLOAD) {
          throw new Error(`الملف يتجاوز حد الرفع المباشر: ${name}`);
        }
        if (bytes.byteLength > 700000) {
          const asset = await uploadReleaseAsset(env, {name, mime, bytes});
          storage = asset.storage;
          assetId = String(asset.assetId);
          assetUrl = asset.url;
        } else {
          data = raw;
        }
      }
    }
    
    await env.DB.prepare('INSERT INTO conversation_files (id, chat_id, name, mime, size, content_text, data_url, storage, asset_id, asset_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, chatId, name, mime, size, content, data, storage, assetId, assetUrl, Date.now(), Date.now()).run();
  }
}

// ============ Load Messages ============
async function loadMessages(env, chatId) {
  const r = await env.DB.prepare('SELECT role, content, model_id, created_at FROM messages WHERE chat_id=? ORDER BY created_at ASC LIMIT 100').bind(chatId).all();
  return (r.results || []).map(x => ({role:x.role, content:x.content, model:x.model_id || null, createdAt:x.created_at}));
}

// ============ Chat ============
async function chat(env, b) {
  if (!b.chatId || !Array.isArray(b.messages) || !b.messages.length) {
    return json({error:'chatId والرسائل مطلوبان'}, 400);
  }
  
  const store = d1ContextStore(env.DB);
  const state = await store.get(b.chatId);
  const recent = b.messages.slice(-14);
  const requested = getModel(b.model || chooseModel(recent.at(-1)?.content).id);
  const hasImage = (b.attachments || []).some(x => String(x.mime || x.type || '').startsWith('image/'));
  const model = hasImage && requested.kind !== 'vision' ? getModel('cf-llama-vision') : requested;
  const packet = contextPacket(state, recent);
  const media = multimodalMessages([{role:'user', content:recent.at(-1)?.content || ''}], b.attachments || [], model.id);
  
  const result = await routeCompletion(env, model.id, [
    {role:'system', content: system() + '\n\n' + renderHandoff(state, recent)},
    ...packet.recent.slice(0, -1),
    ...media.messages
  ], {maxTokens: 4096});
  
  const answer = result.text;
  const last = text(recent.at(-1)?.content);
  
  await persistFiles(env, b.chatId, b.attachments || []);
  await persistMessage(env, b.chatId, 'user', last, null);
  await persistMessage(env, b.chatId, 'assistant', answer, result.actual.id);
  
  const patch = {
    summary: last.slice(0, 500),
    facts: state.facts,
    decisions: state.decisions,
    next: 'متابعة طلب المستخدم',
    constraints: state.constraints
  };
  const next = mergeContext(state, patch);
  await store.put(b.chatId, next);
  await store.appendEvent(createContextEvent(b.chatId, 'model_called', {requested:model.id, actual:result.actual.id, fallback:result.fallback, media:!!b.attachments?.length}));
  await store.appendEvent(createContextEvent(b.chatId, 'context_updated', {revision:next.revision}));
  
  return json({
    response: answer,
    model: result.actual,
    requestedModel: requested,
    pendingExecution: detectToolProposal(answer),
    unsupportedAttachments: media.unsupported,
    memory: renderHandoff(next, []),
    trace: {
      provider: result.actual.provider,
      model: result.actual.model,
      fallback: result.fallback,
      contextMessages: packet.recent.length,
      media: !!b.attachments?.length,
      memoryUpdated: true
    }
  });
}

// ============ Plan ============
async function plan(env, b) {
  if (!b.chatId || !text(b.task)) {
    return json({error:'chatId و task مطلوبان'}, 400);
  }
  
  const state = await d1ContextStore(env.DB).get(b.chatId);
  const model = getModel(b.model || chooseModel(b.task).id);
  const prompt = `أنشئ خطة JSON فقط بالشكل {"goal":"...","steps":[{"title":"...","description":"...","verification":"...","tool":"none"}]}. المهمة: ${b.task}\nالسياق: ${renderHandoff(state, [])}`;
  
  const r = await routeCompletion(env, model.id, [
    {role:'system', content: system() + ' لا تنفذ شيئًا. أعد JSON صحيحًا فقط.'},
    {role:'user', content: prompt}
  ], {maxTokens: 1800, temperature: .1});
  
  let raw = r.text.match(/\{[\s\S]*\}/)?.[0] || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {goal:b.task, steps:[{title:'تحليل المتطلبات', description:b.task, verification:'وجود خطة', tool:'none'}]};
  }
  
  const task = startPlanning(createTask({conversationId: b.chatId, goal: parsed.goal || b.task}));
  const planObj = createPlan(task, {
    goal: parsed.goal || b.task,
    steps: Array.isArray(parsed.steps) && parsed.steps.length ? parsed.steps : [{title:'تحليل المتطلبات', description:b.task, verification:'وجود خطة', tool:'none'}]
  });
  
  await env.DB.prepare('INSERT INTO tasks (id, chat_id, task_json, plan_json, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(task.id, b.chatId, JSON.stringify(task), JSON.stringify(planObj), Date.now(), Date.now()).run();
  
  return json({task, plan: planObj, model: r.actual});
}

// ============ Get Run ============
async function getRun(env, b) {
  const r = await env.DB.prepare('SELECT task_json, plan_json FROM tasks WHERE id=?').bind(b.runId).first();
  if (!r) return json({error:'المهمة غير موجودة'}, 404);
  return json({task: JSON.parse(r.task_json), plan: JSON.parse(r.plan_json)});
}

// ============ Get Task Control ============
async function getTaskControl(env, b) {
  if (!b.taskId) return json({error:'taskId مطلوب'}, 400);
  const task = await env.DB.prepare('SELECT id, task_json, plan_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!task) return json({error:'المهمة غير موجودة'}, 404);
  const control = await env.DB.prepare('SELECT task_id, status, updated_at FROM task_control WHERE task_id=?').bind(b.taskId).first();
  return json({
    task: JSON.parse(task.task_json),
    plan: task.plan_json ? JSON.parse(task.plan_json) : null,
    control: control || {task_id: b.taskId, status: JSON.parse(task.task_json).status, updated_at: null}
  });
}

// ============ Step Control ============
async function stepControl(env, b) {
  if (!b.taskId || !b.stepId || !['start_step', 'complete_step', 'fail_step', 'retry_step'].includes(b.action)) {
    return json({error:'taskId و stepId وإجراء الخطوة مطلوبون'}, 400);
  }
  
  const row = await env.DB.prepare('SELECT task_json, plan_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!row) return json({error:'المهمة غير موجودة'}, 404);
  
  let task = JSON.parse(row.task_json);
  let plan = JSON.parse(row.plan_json || 'null');
  if (!plan) return json({error:'الخطة غير موجودة'}, 404);
  
  const control = await env.DB.prepare('SELECT status FROM task_control WHERE task_id=?').bind(b.taskId).first();
  if (['paused', 'cancelled'].includes(control?.status)) {
    return json({error:`المهمة ${control.status === 'paused' ? 'متوقفة مؤقتًا' : 'ملغاة'}`}, 409);
  }
  
  let result;
  if (b.action === 'start_step') {
    if (task.status === 'planning' || task.status === 'awaiting_approval') {
      result = approvePlan(task, plan);
    } else {
      result = startStep(task, plan, b.stepId);
    }
  } else if (b.action === 'complete_step') {
    result = completeStep(task, plan, b.stepId, text(b.output) || 'تمت الخطوة يدويًا', Array.isArray(b.evidence) ? b.evidence : []);
  } else if (b.action === 'fail_step') {
    result = failStep(task, plan, b.stepId, text(b.error) || 'فشلت الخطوة');
  } else {
    result = retryStep(task, plan, b.stepId);
  }
  
  task = result.task;
  plan = result.plan;
  
  await env.DB.prepare('UPDATE tasks SET task_json=?, plan_json=?, updated_at=? WHERE id=?')
    .bind(JSON.stringify(task), JSON.stringify(plan), Date.now(), b.taskId).run();
  
  return json({success:true, task, plan, retry: result.retry ?? false});
}

// ============ Get Experiment ============
async function getExperiment(env, b) {
  if (!b.experimentId) return json({error:'experimentId مطلوب'}, 400);
  const r = await env.DB.prepare('SELECT id, chat_id, command, status, output, exit_code, created_at, updated_at FROM experiments WHERE id=?').bind(b.experimentId).first();
  if (!r) return json({error:'التجربة غير موجودة'}, 404);
  return json({experiment: {...r, exitCode: r.exit_code, createdAt: r.created_at, updatedAt: r.updated_at}});
}

// ============ Memory ============
async function memory(env, b) {
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  const store = d1ContextStore(env.DB);
  
  if (b.action === 'memory_update') {
    const state = mergeContext(await store.get(b.chatId), {summary: text(b.content).slice(0, 2000)});
    await store.put(b.chatId, state);
    return json({success:true, content: renderHandoff(state, [])});
  }
  
  const state = await store.get(b.chatId);
  return json({content: renderHandoff(state, []), state});
}

// ============ Messages (Get) ============
async function messages(env, b) {
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  
  const files = await env.DB.prepare('SELECT id, name, mime, size, data_url, storage, asset_id, asset_url, content_text, created_at FROM conversation_files WHERE chat_id=? ORDER BY created_at DESC').bind(b.chatId).all();
  
  return json({
    messages: await loadMessages(env, b.chatId),
    files: files.results || []
  });
}

// ============ Search All ============
async function searchAll(env, b) {
  const q = text(b.query).slice(0, 120);
  if (!q) return json({conversations:[], messages:[], files:[]});
  
  const like = `%${q}%`;
  const chatId = b.chatId || null;
  
  const conversations = chatId 
    ? {results: []}
    : await env.DB.prepare('SELECT id, title, updated_at FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 30').bind(like).all();
  
  const messagesR = chatId
    ? await env.DB.prepare('SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 50').bind(chatId, like).all()
    : await env.DB.prepare('SELECT id, chat_id, role, content, created_at FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 50').bind(like).all();
  
  const files = chatId
    ? await env.DB.prepare('SELECT id, chat_id, name, mime, size, content_text, created_at FROM conversation_files WHERE chat_id=? AND (name LIKE ? OR content_text LIKE ?) ORDER BY created_at DESC LIMIT 50').bind(chatId, like, like).all()
    : await env.DB.prepare('SELECT id, chat_id, name, mime, size, content_text, created_at FROM conversation_files WHERE name LIKE ? OR content_text LIKE ? ORDER BY created_at DESC LIMIT 50').bind(like, like).all();
  
  return json({
    query: q,
    conversations: conversations.results || [],
    messages: messagesR.results || [],
    files: files.results || []
  });
}

// ============ Settings ============
async function settings(env, b) {
  if (b.action === 'settings_get') {
    const r = await env.DB.prepare('SELECT key, value_json FROM settings ORDER BY key').all();
    return json({settings: (r.results || []).map(x => ({key: x.key, value: JSON.parse(x.value_json)}))});
  }
  
  if (!b.key) return json({error:'key مطلوب'}, 400);
  if (b.key.includes('API_KEY') || b.key.includes('TOKEN') || b.key.includes('PASSWORD')) {
    return json({error:'المفاتيح السرية تُدار من Cloudflare Secrets ولا تُحفظ في D1'}, 400);
  }
  
  await env.DB.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=?, updated_at=?')
    .bind(b.key, JSON.stringify(b.value ?? null), Date.now(), JSON.stringify(b.value ?? null), Date.now()).run();
  
  return json({success:true});
}

// ============ Conversation Control ============
async function conversationControl(env, b) {
  if (!b.chatId) return json({error:'chatId مطلوب'}, 400);
  
  if (b.action === 'rename_conversation') {
    const title = text(b.title).slice(0, 120);
    if (!title) return json({error:'العنوان مطلوب'}, 400);
    await env.DB.prepare('UPDATE conversations SET title=?, updated_at=? WHERE id=?').bind(title, Date.now(), b.chatId).run();
    return json({success:true, title});
  }
  
  if (b.action === 'delete_conversation') {
    await env.DB.prepare('DELETE FROM conversation_files WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM messages WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM context_state WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM context_events WHERE chat_id=?').bind(b.chatId).run();
    await env.DB.prepare('DELETE FROM conversations WHERE id=?').bind(b.chatId).run();
    return json({success:true});
  }
  
  return json({error:'إجراء محادثة غير معروف'}, 400);
}

// ============ Cancel Experiment ============
async function cancelExperimentRun(env, b) {
  if (!b.experimentId) return json({error:'experimentId مطلوب'}, 400);
  
  const row = await env.DB.prepare('SELECT id, chat_id, run_id, status FROM experiments WHERE id=?').bind(b.experimentId).first();
  if (!row) return json({error:'التجربة غير موجودة'}, 404);
  if (['completed', 'failed', 'cancelled'].includes(row.status)) {
    return json({success:true, status:row.status, alreadyFinished:true});
  }
  
  const result = await cancelExperiment(env, {runId: row.run_id});
  await env.DB.prepare('UPDATE experiments SET status=?, updated_at=? WHERE id=?')
    .bind(result.status === 'already_finished' ? 'completed' : 'cancellation_requested', Date.now(), b.experimentId).run();
  
  return json({success:true, experimentId: b.experimentId, ...result});
}

// ============ Download File ============
async function downloadFile(env, b) {
  if (!b.assetId) return json({error:'assetId مطلوب'}, 400);
  const r = await downloadReleaseAsset(env, b.assetId);
  return new Response(r.body, {
    status: 200,
    headers: {
      'content-type': r.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
      ...CORS
    }
  });
}

// ============ Task Control ============
async function taskControl(env, b) {
  if (!b.taskId) return json({error:'taskId مطلوب'}, 400);
  
  const row = await env.DB.prepare('SELECT task_json FROM tasks WHERE id=?').bind(b.taskId).first();
  if (!row) return json({error:'المهمة غير موجودة'}, 404);
  
  const status = b.action === 'cancel_task' ? 'cancelled' : b.action === 'pause_task' ? 'paused' : b.action === 'resume_task' ? 'running' : null;
  if (!status) return json({error:'إجراء تحكم غير معروف'}, 400);
  
  const timestamp = Date.now();
  await env.DB.prepare('INSERT INTO task_control (task_id, status, updated_at) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=?, updated_at=?')
    .bind(b.taskId, status, timestamp, status, timestamp).run();
  
  return json({success:true, taskId: b.taskId, status, updatedAt: timestamp});
}

// ============ Advance Task ============
async function advance(env, b) {
  if (!b.taskId) return json({error:'taskId مطلوب'}, 400);
  const result = await advanceTask(env, b.taskId, {modelId: b.model, maxSteps: b.maxSteps || 3});
  return json(result);
}

// ============ Intervene ============
async function intervene(env, b) {
  if (!b.taskId || !text(b.content)) return json({error:'taskId و content مطلوبان'}, 400);
  const result = await addIntervention(env, b.taskId, b.content);
  const run = b.advance !== false ? await advanceTask(env, b.taskId, {modelId: b.model, maxSteps: 1}) : null;
  return json({success:true, ...result, run});
}

// ============ Events ============
async function events(env, b) {
  if (!b.taskId) return json({error:'taskId مطلوب'}, 400);
  return json({events: await taskEvents(env, b.taskId)});
}

// ============ Export persistFiles ============
export { persistFiles };

// ============ Main Fetch Handler ============
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {headers: CORS});
    }
    
    const pathname = new URL(request.url).pathname;
    
    // Handle tool-result webhook (from GitHub Actions)
    if (pathname === '/tool-result') {
      return receiveToolResult(env, request);
    }
    
    // API only - no static file serving
    if (request.method === 'GET') {
      return json({name:'FOX AI', status:'ready', version:'3.0.0'});
    }
    
    if (request.method !== 'POST') {
      return json({error:'Method not allowed'}, 405);
    }
    
    try {
      await schema(env);
      const b = await request.json();
      
      if (b.action === 'models') return json({models: publicCatalog()});
      if (b.action === 'login') return login(env, b);
      
      if (!await session(env, b.sessionToken)) {
        return json({error:'الجلسة غير صالحة', authRequired:true}, 401);
      }
      
      if (b.action === 'chat') return chat(env, b);
      if (b.action === 'get_messages') return messages(env, b);
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
      if (b.action === 'cancel_experiment') return cancelExperimentRun(env, b);
      if (b.action === 'download_file') return downloadFile(env, b);
      if (b.action === 'tool_proposal') return toolProposal(env, b);
      if (b.action === 'tool_budget') return toolBudget(env, b);
      if (b.action === 'workspace_status') return workspaceStatus(env, b);
      if (b.action === 'run_tool') return runTool(env, b);
      if (['settings_get', 'settings_set'].includes(b.action)) return settings(env, b);
      if (['rename_conversation', 'delete_conversation'].includes(b.action)) return conversationControl(env, b);
      if (['cancel_task', 'pause_task', 'resume_task'].includes(b.action)) return taskControl(env, b);
      
      return json({error:'إجراء غير معروف'}, 400);
    } catch (e) {
      console.error(e);
      const status = e instanceof ProviderError ? e.status : 500;
      return json({error: e.message || 'خطأ داخلي', provider: e.provider || null, retryable: !!e.retryable}, status);
    }
  }
};