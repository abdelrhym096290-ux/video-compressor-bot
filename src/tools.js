// ============================================================
// src/tools.js
// أدوات الطرفية: اقتراح، تحقق، موافقة، تنفيذ عبر GitHub Actions
// ============================================================
import { id, now, eventRecord } from './contracts.js';

const SAFE_LANGUAGES = new Set(['bash','sh','shell','terminal','command','python']);

const KNOWN_COMMANDS = new Set([
  'ls','pwd','cd','echo','cat','grep','find','which','type','file','stat',
  'git','npm','yarn','pnpm','node','deno','bun',
  'python','python3','pip','pip3','uv','poetry',
  'curl','wget','mkdir','rmdir','rm','cp','mv','touch','chmod','chown','ln','link',
  'bash','sh','zsh','fish','date','time','uptime','whoami','id','groups','hostname',
  'uname','df','du','ps','top','htop','free','kill','pkill','head','tail','less','more',
  'wc','sort','uniq','awk','sed','tr','cut','paste','xargs','tee','diff','patch',
  'tar','zip','unzip','gzip','gunzip','7z','bzip2',
  'ssh','scp','rsync','ping','traceroute','nslookup','dig','ip','ifconfig','netstat',
  'docker','kubectl','helm','terraform','ansible',
  'jq','yq','openssl','ssh-keygen','base64','md5sum','sha256sum',
  'make','cmake','gcc','g++','clang','rustc','cargo','go','javac','java',
  'ffmpeg','convert','magick','imagemagick',
  'apt','apt-get','yum','dnf','pacman','brew','snap',
  'sqlite3','psql','mysql','redis-cli','mongo',
  'tree','nano','vim','vi','emacs','code',
  'env','export','set','unset','alias','source','exit','eval','exec','test','true','false',
]);

const BLOCKED_COMMANDS = [
  /(^|[;&|\n])\s*rm\s+-rf\s+\/\s*$/i,
  /(^|[;&|\n])\s*rm\s+-rf\s+\/\s+/i,
  /(^|[;&|\n])\s*(shutdown|reboot|halt|poweroff|mkfs|fdisk|dd\s+if=)/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|nvme|vda)/i,
  /curl\s+[^\n|]*\|\s*(bash|sh)/i,
  /wget\s+[^\n|]*\|\s*(bash|sh)/i,
  /rm\s+-rf\s+(~|\$HOME|\/\*)/i,
];

// ============================================================
// detectToolProposal — يقبل 4 صيغ:
//   1) ```terminal\n ... \n``` (مع newline)
//   2) ```terminal ... ``` (بدون newline — سطر واحد)
//   3) JSON fence/mباشر
//   4) inline code مع أمر معروف فقط
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

  // ⭐ الصيغة 1+2: ```lang ... ``` (مع أو بدون newline)
  const fenceMatch = source.match(/```(terminal|bash|sh|shell|command|python)\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const language = fenceMatch[1].toLowerCase();
    // استبعد الكتل الفارغة أو التي تحتوي فقط على مسافات
    const rawCommand = fenceMatch[2].replace(/^\s+|\s+$/g, '');
    if (rawCommand && rawCommand.length < 5000) {
      // أزل أي سطر يبدأ بـ # (تعليقات عربية)
      const cleaned = rawCommand.split('\n')
        .filter(line => !/^\s*#/.test(line) && !/^\s*\/\//.test(line))
        .join('\n')
        .trim();
      if (cleaned) return build(language, cleaned, '');
    }
  }

  // ⭐ الصيغة 3أ: ```json {"tool":"terminal",...} ```
  const jsonFence = source.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (jsonFence) {
    try {
      const p = JSON.parse(jsonFence[1]);
      if (p && p.tool === 'terminal' && p.command) {
        return build(p.language, p.command, p.explanation);
      }
    } catch {}
  }

  // ⭐ الصيغة 3ب: JSON مباشر بدون fence
  const jsonInlineMatches = source.match(/\{[^{}]*"tool"\s*:\s*"terminal"[^{}]*\}/g);
  if (jsonInlineMatches) {
    for (const candidate of jsonInlineMatches) {
      try {
        const p = JSON.parse(candidate);
        if (p && p.tool === 'terminal' && p.command) {
          return build(p.language, p.command, p.explanation);
        }
      } catch {}
    }
  }

  // ⭐ الصيغة 4: inline code مع أمر معروف فقط
  // مثال: `pwd` أو `ls -la` — فقط إن كان الكود كامل = أمر معروف
  const inlineMatches = source.match(/`([^`\n]{1,300})`/g);
  if (inlineMatches) {
    for (const m of inlineMatches) {
      const cmd = m.slice(1, -1).trim();
      if (!cmd) continue;
      // تجاهل ما يحتوي حروف عربية (شرح)
      if (/[\u0600-\u06FF]/.test(cmd)) continue;
      // تجاهل ما هو طويل جداً
      if (cmd.length > 300) continue;
      // تجاهل ما يحتوي رموزاً غريبة
      if (!/^[a-zA-Z0-9_\-\.\/\s=:"'$&;|<>()\[\]{}*?~!@#%^+,]+$/.test(cmd)) continue;
      // خذ أول كلمة
      const firstWord = cmd.split(/\s+/)[0].toLowerCase();
      // إن كانت معروفة → اعتبرها اقتراحاً
      if (KNOWN_COMMANDS.has(firstWord)) {
        return build('bash', cmd, '');
      }
    }
  }

  return null;
}

// ============================================================
// validateCommand
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
    output: String(output).slice(0, 200000),
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
// github
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
      'User-Agent': 'FOX-AI-Worker/7.3',
      ...(init.headers || {}),
    },
  });
}

// ============================================================
// dispatchExperiment
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
    const errorBody = await response.text().catch(() => '');
    let detail = errorBody || '(بدون تفاصيل)';
    try {
      const parsed = JSON.parse(errorBody);
      detail = parsed.message || parsed.documentation_url || detail;
    } catch {}

    const hints = {
      401: 'التوكن غير صالح',
      403: 'صلاحيات ناقصة — تأكد من scope "workflow"',
      404: 'اسم المستودع أو الـ workflow أو الـ ref خطأ',
      422: 'مدخلات workflow غير صحيحة',
    };
    const hint = hints[response.status] ? ` | تلميح: ${hints[response.status]}` : '';

    throw new Error(`فشل إرسال التجربة إلى GitHub: HTTP ${response.status} — ${detail}${hint}`);
  }

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
  if (!r.ok && r.status !== 409) throw new Error(`فشل إيقاف GitHub: HTTP ${r.status}`);
  return { runId, status: r.status === 409 ? 'already_finished' : 'cancellation_requested' };
}

// ============================================================
// verifyWebhook
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