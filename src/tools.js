// ============================================================
// src/tools.js
// أدوات الطرفية: اقتراح، تحقق، موافقة، تنفيذ عبر GitHub Actions
// ============================================================
import { id, now, eventRecord } from './contracts.js';

const SAFE_LANGUAGES = new Set(['bash','sh','shell','terminal','command','python']);

const BLOCKED_COMMANDS = [
  /(^|[;&|\n])\s*rm\s+-rf\b/i,
  /(^|[;&|\n])\s*(shutdown|reboot|mkfs|dd)\b/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|nvme|vda)/i,
  /curl\s+[^\n|]*\|\s*(bash|sh)/i,
  /wget\s+[^\n|]*\|\s*(bash|sh)/i,
];

// ============================================================
// detectToolProposal — يقبل 3 صيغ:
//   1) ```json {"tool":"terminal","language":"bash","command":"..."} ```
//   2) JSON مباشر بدون fence
//   3) ```terminal\nls -la\n``` (الصيغة القديمة)
// ============================================================
export function detectToolProposal(text = '') {
  const source = String(text);
  if (!source) return null;

  const build = (language, command, explanation = '') => {
    const lang = String(language || 'bash').toLowerCase();
    return {
      id: id('proposal'),
      kind: 'terminal',
      language: lang,
      command: String(command || '').trim(),
      explanation: String(explanation || '').slice(0, 500),
      requiresApproval: true,
      safeLanguage: SAFE_LANGUAGES.has(lang),
      createdAt: now(),
    };
  };

  // ============ الصيغة 1: JSON داخل ```json ``` ============
  const jsonFence = source.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (jsonFence) {
    try {
      const p = JSON.parse(jsonFence[1]);
      if (p && p.tool === 'terminal' && p.command) {
        return build(p.language, p.command, p.explanation);
      }
    } catch { /* نتجاهل ونكمل */ }
  }

  // ============ الصيغة 2: JSON مباشر (بدون fence) ============
  const jsonInlineMatches = source.match(/\{[^{}]*"tool"\s*:\s*"terminal"[^{}]*\}/g);
  if (jsonInlineMatches) {
    for (const candidate of jsonInlineMatches) {
      try {
        const p = JSON.parse(candidate);
        if (p && p.tool === 'terminal' && p.command) {
          return build(p.language, p.command, p.explanation);
        }
      } catch { /* نتجاهل ونكمل */ }
    }
  }

  // ============ الصيغة 3 (القديمة): ```terminal\n...\n``` ============
  const langFence = source.match(/```(terminal|bash|sh|shell|command|python)\s*\n([\s\S]*?)```/i);
  if (langFence) {
    const language = langFence[1].toLowerCase();
    const command = langFence[2].trim();
    if (command) return build(language, command, '');
  }

  return null;
}

// ============================================================
// validateCommand — فحص الأمر قبل التنفيذ
// ============================================================
export function validateCommand(command, { maxLength = 12000 } = {}) {
  const value = String(command || '').trim();
  if (!value || value.length > maxLength) throw new Error('الأمر فارغ أو يتجاوز الحد المسموح');
  if (/[\u0000]/.test(value)) throw new Error('الأمر يحتوي محارف غير صالحة');
  if (BLOCKED_COMMANDS.some(pattern => pattern.test(value))) {
    throw new Error('الأمر مرفوض لأنه قد يسبب حذفًا أو تغييرًا خطيرًا');
  }
  return value;
}

// ============================================================
// approvalRecord
// ============================================================
export function approvalRecord({ proposalId, approved, scope = 'single_run' }) {
  return { id: id('approval'), proposalId, approved: Boolean(approved), scope, createdAt: now() };
}

// ============================================================
// experimentRecord
// ============================================================
export function experimentRecord({ chatId, proposal, approval }) {
  if (!approval?.approved) throw new Error('لا يمكن إنشاء تجربة دون موافقة صريحة');
  if (approval.proposalId !== proposal.id) throw new Error('الموافقة لا تطابق الاقتراح');
  return {
    id: id('exp'),
    chatId,
    proposalId: proposal.id,
    command: validateCommand(proposal.command),
    language: proposal.language || 'bash',
    status: 'pending',
    output: '',
    exitCode: null,
    attempt: 1,
    createdAt: now(),
    updatedAt: now(),
  };
}

// ============================================================
// verifyResult
// ============================================================
export function verifyResult(experiment, { output = '', exitCode = 1 } = {}) {
  const code = Number(exitCode);
  const ok = code === 0;
  return {
    ...experiment,
    status: ok ? 'completed' : 'failed',
    output: String(output).slice(0, 50000),
    exitCode: code,
    updatedAt: now(),
    verified: ok,
  };
}

// ============================================================
// retryExperiment
// ============================================================
export function retryExperiment(experiment) {
  if (experiment.status !== 'failed') throw new Error('التجربة ليست فاشلة');
  if (Number(experiment.attempt || 1) >= 3) throw new Error('تم بلوغ الحد الأقصى لإعادة المحاولة');
  return {
    ...experiment,
    status: 'pending',
    attempt: Number(experiment.attempt || 1) + 1,
    output: '',
    exitCode: null,
    updatedAt: now(),
  };
}

// ============================================================
// experimentEvent
// ============================================================
export function experimentEvent(experiment, type, payload = {}) {
  return eventRecord({
    taskId: experiment.chatId,
    type,
    payload: { experimentId: experiment.id, ...payload },
  });
}

// ============================================================
// memoryToolStore — للاختبار المحلي
// ============================================================
export function memoryToolStore() {
  const items = new Map(), events = [];
  return {
    async save(x) { items.set(x.id, structuredClone(x)); return x; },
    async get(key) { return structuredClone(items.get(key) || null); },
    async event(e) { events.push(structuredClone(e)); return e; },
    async eventsFor(chatId) { return events.filter(x => x.taskId === chatId); },
  };
}

// ============================================================
// github — طلب موحّد إلى GitHub API
// ⭐ ملاحظة: User-Agent إلزامي وإلا GitHub يعيد 403
// ============================================================
async function github(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN غير مهيأ');
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'FOX-AI-Worker/6.0',   // ⭐ إلزامي لـ GitHub API
      ...(init.headers || {}),
    },
  });
}

// ============================================================
// dispatchExperiment — إرسال الأمر إلى GitHub Actions
// ============================================================
export async function dispatchExperiment(env, experiment) {
  const repo = env.GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW || 'terminal.yml';
  const ref = env.GITHUB_REF || 'main';
  if (!repo) throw new Error('GITHUB_REPO غير مهيأ');

  const started = now();

  const response = await github(env, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      ref,
      inputs: {
        command: experiment.command,
        language: experiment.language,
        experimentId: experiment.id,
      },
    }),
  });

  if (!response.ok) {
    // ⭐ نقرأ رسالة GitHub الكاملة لتشخيص السبب (403, 404, ... إلخ)
    const errorBody = await response.text().catch(() => '');
    let detail = errorBody || '(بدون تفاصيل)';
    try {
      const parsed = JSON.parse(errorBody);
      detail = parsed.message || parsed.documentation_url || detail;
    } catch { /* نُبقي النص الأصلي */ }

    const hints = {
      401: 'التوكن غير صالح أو منتهي',
      403: 'صلاحيات ناقصة — تأكد من scope "workflow" في التوكن، و"Read and write permissions" في Settings → Actions → General',
      404: 'اسم المستودع أو ملف الـ workflow أو الـ ref خطأ',
      422: 'مدخلات workflow غير صحيحة — تأكد من تعريف workflow_dispatch inputs',
    };
    const hint = hints[response.status] ? ` | تلميح: ${hints[response.status]}` : '';

    throw new Error(`فشل إرسال التجربة إلى GitHub: HTTP ${response.status} — ${detail}${hint}`);
  }

  // البحث عن runId لمدة 5 ثوان
  let runId = null;
  for (let i = 0; i < 5 && !runId; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const runs = await github(env, `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`);
    if (!runs.ok) continue;
    const data = await runs.json();
    const hit = (data.workflow_runs || []).find(x =>
      String(x.display_title || '').includes(experiment.id) &&
      new Date(x.created_at).getTime() >= started - 5000
    );
    if (hit) runId = hit.id;
  }

  return { ...experiment, runId, status: 'dispatched', repo, workflow, ref, updatedAt: now() };
}

// ============================================================
// cancelExperiment
// ============================================================
export async function cancelExperiment(env, { repo, runId }) {
  if (!runId) throw new Error('رقم تشغيل GitHub غير متاح');
  const target = repo || env.GITHUB_REPO;
  const r = await github(env, `/repos/${target}/actions/runs/${runId}/cancel`, { method: 'POST' });
  if (!r.ok && r.status !== 409) throw new Error(`فشل إيقاف تشغيل GitHub: HTTP ${r.status}`);
  return { runId, status: r.status === 409 ? 'already_finished' : 'cancellation_requested' };
}

// ============================================================
// verifyWebhook — التحقق من توقيع HMAC للنتائج القادمة
// ============================================================
export async function verifyWebhook(raw, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = Array.from(new Uint8Array(sig)).map(x => x.toString(16).padStart(2, '0')).join('');
  const given = String(signature).replace(/^sha256=/, '').toLowerCase();
  return expected.length === given.length && expected.split('').every((x, i) => x === given[i]);
}