// ============================================================
// src/tools.js — v3.0
// أدوات الطرفية + قائمة الأوامر الخطرة + تصنيف المخاطر
// ============================================================
import { id, now, eventRecord } from './contracts.js';

const SAFE_LANGUAGES = new Set(['bash','sh','shell','terminal','command','python']);

const KNOWN_COMMANDS = new Set([
  'ls','pwd','cd','echo','cat','grep','find','which','type','file','stat',
  'git','npm','yarn','pnpm','node','deno','bun',
  'python','python3','pip','pip3','uv','poetry',
  'curl','wget','mkdir','rmdir','cp','mv','touch','chmod','chown','ln','link',
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

// ⭐ الأوامر المحظورة نهائياً (لن تُنفَّذ حتى بموافقة)
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

// ⭐ الأوامر "الخطرة" — تحتاج موافقة حتى في الوضع التلقائي
const DESTRUCTIVE_PATTERNS = [
  // حذف شامل
  { pattern: /\brm\s+-rf\b/i, label: 'حذف شامل (rm -rf)' },
  { pattern: /\brm\s+-fr\b/i, label: 'حذف شامل (rm -fr)' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x?/i, label: 'git clean -fdx' },
  { pattern: /\bgit\s+clean\s+-[a-z]*x[a-z]*d[a-z]*f?/i, label: 'git clean -xdf' },
  // إعادة تعيين قسري
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard' },
  { pattern: /\bgit\s+push\b[^\n]*--force\b/i, label: 'git push --force' },
  { pattern: /\bgit\s+push\b[^\n]*--force-with-lease\b/i, label: 'git push --force-with-lease' },
  { pattern: /\bgit\s+branch\s+-D\b/i, label: 'git branch -D' },
  { pattern: /\bgit\s+tag\s+-d\b/i, label: 'git tag -d' },
  // صلاحيات
  { pattern: /\bchmod\s+-R\s+777\b/i, label: 'chmod -R 777' },
  { pattern: /\bchmod\s+777\b/i, label: 'chmod 777' },
  { pattern: /\bchown\s+-R\b/i, label: 'chown -R' },
  // رفع صلاحيات
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\bsu\s+-/i, label: 'su -' },
  // نشر
  { pattern: /\bnpm\s+publish\b/i, label: 'npm publish' },
  { pattern: /\byarn\s+publish\b/i, label: 'yarn publish' },
  { pattern: /\bdocker\s+push\b/i, label: 'docker push' },
  // تدمير نظام
  { pattern: /\bdd\s+if=/i, label: 'dd if=' },
  { pattern: /\bkill\s+-9\s+-1\b/i, label: 'kill -9 -1' },
  { pattern: /\bkillall\b/i, label: 'killall' },
  { pattern: /\bpkill\s+-9\b/i, label: 'pkill -9' },
  // تثبيت مع كسر النظام
  { pattern: /\bpip\s+install\s+--break-system-packages\b/i, label: 'pip install --break-system-packages' },
  // استبدال ملفات النظام
  { pattern: />\s*\/etc\//i, label: 'كتابة في /etc/' },
  { pattern: />\s*\/usr\//i, label: 'كتابة في /usr/' },
  { pattern: />\s*\/bin\//i, label: 'كتابة في /bin/' },
  { pattern: />\s*\/boot\//i, label: 'كتابة في /boot/' },
];

// ============================================================
// commandRiskLevel
// ============================================================
export function commandRiskLevel(command = '') {
  const value = String(command || '').trim();
  if (!value) return { level: 'empty', label: 'أمر فارغ' };

  // 1) محظور نهائياً
  if (BLOCKED_COMMANDS.some(p => p.test(value))) {
    return { level: 'blocked', label: 'أمر محظور نهائياً' };
  }

  // 2) خطر — يحتاج موافقة حتى في Auto-pilot
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(value)) {
      return { level: 'destructive', label };
    }
  }

  // 3) آمن
  return { level: 'safe', label: '' };
}

// ============================================================
// detectToolProposal
// ============================================================
export function detectToolProposal(text = '') {
  const source = String(text);
  if (!source) return null;

  const build = (language, command, explanation = '') => {
    const lang = String(language || 'bash').toLowerCase();
    const cmd = String(command || '').trim();
    const risk = commandRiskLevel(cmd);
    return {
      id: id('proposal'),
      kind: 'terminal',
      language: lang,
      command: cmd,
      explanation: String(explanation || '').slice(0, 500),
      requiresApproval: true,
      safeLanguage: SAFE_LANGUAGES.has(lang),
      risk,  // ⭐ جديد
      createdAt: now(),
    };
  };

  const fenceMatch = source.match(/```(terminal|bash|sh|shell|command|python)\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const language = fenceMatch[1].toLowerCase();
    const rawCommand = fenceMatch[2].replace(/^\s+|\s+$/g, '');
    if (rawCommand && rawCommand.length < 5000) {
      const cleaned = rawCommand.split('\n')
        .filter(line => !/^\s*#/.test(line) && !/^\s*\/\//.test(line))
        .join('\n')
        .trim();
      if (cleaned) return build(language, cleaned, '');
    }
  }

  const jsonFence = source.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (jsonFence) {
    try {
      const p = JSON.parse(jsonFence[1]);
      if (p && p.tool === 'terminal' && p.command) {
        return build(p.language, p.command, p.explanation);
      }
    } catch {}
  }

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

  const inlineMatches = source.match(/`([^`\n]{1,300})`/g);
  if (inlineMatches) {
    for (const m of inlineMatches) {
      const cmd = m.slice(1, -1).trim();
      if (!cmd) continue;
      if (/[\u0600-\u06FF]/.test(cmd)) continue;
      if (cmd.length > 300) continue;
      if (!/^[a-zA-Z0-9_\-\.\/\s=:"'$&;|<>()\[\]{}*?~!@#%^+,]+$/.test(cmd)) continue;
      const firstWord = cmd.split(/\s+/)[0].toLowerCase();
      if (KNOWN_COMMANDS.has(firstWord)) {
        return build('bash', cmd, '');
      }
    }
  }

  return null;
}

// ============================================================
// validateCommand — يُعيد كائناً الآن
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
export function experimentRecord({ chatId, proposal, approval, attachmentIds = [] }) {
  if (!approval?.approved) throw new Error('لا يمكن إنشاء تجربة دون موافقة صريحة');
  if (approval.proposalId !== proposal.id) throw new Error('الموافقة لا تطابق الاقتراح');
  const cmd = validateCommand(proposal.command);
  return {
    id: id('exp'),
    chatId,
    proposalId: proposal.id,
    command: cmd,
    language: proposal.language || 'bash',
    status: 'pending',
    output: '',
    exitCode: null,
    attempt: 1,
    // ⭐ stage 6 — مرفقات يجب استرجاعها في بيئة التشغيل قبل التنفيذ (لتعديل ملف موجود)
    attachmentIds: Array.isArray(attachmentIds) ? attachmentIds.filter(Boolean).slice(0, 5) : [],
    createdAt: now(),
    updatedAt: now(),
  };
}

// ============================================================
// findReferencedAttachments — stage 6
// يكتشف إن كان نص الأمر يذكر اسم ملف مطابق لمرفق موجود في نفس المحادثة،
// ليُعاد استرجاعه إلى بيئة التشغيل قبل التنفيذ (تعديل ملف مرفوع سابقاً).
// ============================================================
export function findReferencedAttachments(command, chatAttachments = []) {
  const cmd = String(command || '');
  if (!cmd || !Array.isArray(chatAttachments) || !chatAttachments.length) return [];
  const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [];
  for (const a of chatAttachments) {
    if (!a || !a.name) continue;
    const re = new RegExp(`(^|[\\s"'/=])${escapeRe(a.name)}($|[\\s"'])`);
    if (re.test(cmd)) matches.push(a.id);
    if (matches.length >= 5) break;
  }
  return matches;
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
// memoryToolStore
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
        // ⭐ stage 6 — مرفقات تُسترجَع في بيئة التشغيل قبل تنفيذ الأمر (مفصولة بفواصل)
        attachmentIds: Array.isArray(experiment.attachmentIds) ? experiment.attachmentIds.join(',') : '',
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