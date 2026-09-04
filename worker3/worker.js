export default {
  async fetch(request, env) {
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'GET') {
      return new Response('FOX AI Worker is running', {
        headers: { 'Content-Type': 'text/plain', ...CORS },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    // ============ مسار استقبال نتائج GitHub ============
    if (request.url.includes('/result')) {
      try {
        const rawBody = await request.text();
        const header = request.headers.get('X-Hub-Signature-256') || '';
        const expectedSig = header.replace('sha256=', '');

        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(env.HMAC_SECRET),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
        const computedSig = Array.from(new Uint8Array(sigBuffer))
          .map(b => b.toString(16).padStart(2, '0')).join('');

        if (!constantTimeEqual(computedSig, expectedSig)) {
          return new Response(JSON.stringify({ error: 'توقيع غير صالح' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }

        const webhookBody = JSON.parse(rawBody);
        const output = webhookBody.output || 'لا توجد نتائج';
        const experimentId = webhookBody.experimentId || 'unknown';
        const exitCode = webhookBody.exit_code ?? 0;

        const id = env.EXPERIMENT_STATE.idFromName(experimentId);
        const experimentObj = env.EXPERIMENT_STATE.get(id);

        const result = await experimentObj.fetch('https://internal/result', {
          method: 'POST',
          body: JSON.stringify({ output, exitCode }),
        });

        const resultData = await result.json();
        const actualCommand = resultData.experiment?.command || 'from-github';

        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO experiments (chat_id, command, status, output, exit_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(experimentId, actualCommand, resultData.status, output, exitCode, now, now)
        .run();

        return new Response(JSON.stringify(resultData), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      } catch (webhookError) {
        console.error('Webhook error:', webhookError.message);
        return new Response(JSON.stringify({ error: webhookError.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
    }

    try {
      const body = await request.json();
      const { action, messages, provider, model, chatId, content, accessPassword, sessionToken, command } = body;
      console.log('FOX AI request:', action, 'messages:', messages?.length, 'model:', model || provider, 'chatId:', chatId);

      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

      if (action === 'login') {
        try {
          const lockCheck = await env.DB.prepare(
            'SELECT attempts, locked_until FROM login_attempts WHERE ip = ?'
          ).bind(clientIP).first();

          const now = Date.now();

          if (lockCheck?.locked_until && lockCheck.locked_until > now) {
            const remainingMs = lockCheck.locked_until - now;
            const remainingMin = Math.ceil(remainingMs / 60000);
            return new Response(JSON.stringify({
              error: `تم حظرك مؤقتاً بسبب محاولات خاطئة متكررة. حاول بعد ${remainingMin} دقيقة.`,
              locked: true,
            }), { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (accessPassword !== env.ACCESS_PASSWORD) {
            const currentAttempts = (lockCheck?.attempts || 0) + 1;
            const shouldLock = currentAttempts >= 5;
            const lockedUntil = shouldLock ? now + 10 * 60 * 1000 : null;

            await env.DB.prepare(
              `INSERT INTO login_attempts (ip, attempts, locked_until, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(ip) DO UPDATE SET attempts = ?, locked_until = ?, updated_at = ?`
            )
            .bind(clientIP, currentAttempts, lockedUntil, now, currentAttempts, lockedUntil, now)
            .run();

            return new Response(JSON.stringify({
              error: shouldLock ? 'كلمة مرور خاطئة. تم حظرك 10 دقائق.' : `كلمة مرور خاطئة. المحاولات المتبقية: ${5 - currentAttempts}`,
              authRequired: true,
            }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          await env.DB.prepare(
            `INSERT INTO login_attempts (ip, attempts, locked_until, updated_at)
             VALUES (?, 0, NULL, ?)
             ON CONFLICT(ip) DO UPDATE SET attempts = 0, locked_until = NULL, updated_at = ?`
          ).bind(clientIP, now, now).run();

          const token = crypto.randomUUID();
          const expiresAt = now + 24 * 60 * 60 * 1000;

          await env.DB.prepare(`INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)`)
            .bind(token, now, expiresAt).run();

          return new Response(JSON.stringify({ success: true, token, expiresAt }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (loginError) {
          return new Response(JSON.stringify({ error: 'خطأ في تسجيل الدخول: ' + loginError.message }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (action === 'check_session') {
        const valid = await isSessionValid(env, sessionToken);
        return new Response(JSON.stringify({ valid }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (action === 'logout') {
        if (sessionToken) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(sessionToken).run().catch(() => {});
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      const sessionValid = await isSessionValid(env, sessionToken);
      if (!sessionValid) {
        return new Response(JSON.stringify({ error: 'الجلسة غير صالحة', authRequired: true }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (action === 'get_memory') {
        if (!chatId) return new Response(JSON.stringify({ error: 'chatId مطلوب' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        const result = await env.DB.prepare('SELECT content FROM project_memory WHERE chat_id = ?').bind(chatId).first();
        return new Response(JSON.stringify({ content: result?.content || '' }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (action === 'memory_update') {
        if (!chatId) return new Response(JSON.stringify({ error: 'chatId مطلوب' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        await env.DB.prepare(`INSERT INTO project_memory (chat_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET content = ?, updated_at = ?`)
          .bind(chatId, content || '', Date.now(), content || '', Date.now()).run();
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (action === 'get_experiments') {
        const results = await env.DB.prepare('SELECT id, command, status, output, exit_code, created_at FROM experiments ORDER BY created_at DESC LIMIT 10').all();
        return new Response(JSON.stringify({ experiments: results.results || [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      // ============ تنفيذ أمر — فقط بعد موافقة صريحة من المستخدم في الواجهة ============
      // هذا المسار هو نقطة التنفيذ الوحيدة في كل الـ Worker. لا مكان آخر يدفع
      // (dispatch) لجيت‌هَب تلقائيًا بمجرد ورود كتلة كود في رد النموذج —
      // ذاك هو الخطر الذي أزلناه. الواجهة تستدعي هذا الـ action فقط بعد
      // ضغط المستخدم زر "نفّذ" على اقتراح محدد، مرة لكل موافقة.
      if (action === 'run_command') {
        if (!command) return new Response(JSON.stringify({ error: 'command مطلوب' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        const experimentId = chatId || 'default-' + Date.now();
        const id = env.EXPERIMENT_STATE.idFromName(experimentId);
        const experimentObj = env.EXPERIMENT_STATE.get(id);
        const result = await experimentObj.fetch('https://internal/start', {
          method: 'POST',
          body: JSON.stringify({ command, chatId, githubToken: env.GITHUB_TOKEN, hmacSecret: env.HMAC_SECRET }),
        });
        const resultData = await result.json();
        return new Response(JSON.stringify(resultData), { status: result.status, headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (action === 'usage') {
        const usageData = await getUsageFromGateway(env);
        return new Response(JSON.stringify(usageData), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (action !== 'chat') return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
      if (!Array.isArray(messages) || messages.length === 0) return new Response(JSON.stringify({ error: 'لا توجد رسائل' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
      const userText = lastUserMessage?.content || '';
      if (!userText) return new Response(JSON.stringify({ error: 'لا توجد رسالة مستخدم' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });

      // يقبل الصيغتين: model="gemini:gemini-3.5-flash" / "cf:@cf/..." (الواجهة الحالية)
      // أو provider="cf-coder" (المفاتيح القديمة المسطّحة، لا تزال مدعومة).
      const resolved = resolveModel(model || provider);

      let currentMemory = '';
      try {
        const memResult = await env.DB.prepare('SELECT content FROM project_memory WHERE chat_id = ?').bind(chatId).first();
        currentMemory = memResult?.content || '';
      } catch (e) { console.error('memory read:', e.message); }

      // هوية الوكيل: FOX AI — وكيل مهام تنفيذي (نمط Manus)، لا مساعد محادثة
      // (نمط Claude). الفرق العملي: لا يكتفي بشرح كيف يُحل الأمر، بل يقترح
      // الخطوة القابلة للتنفيذ مباشرة كأمر، ويتابع نتيجتها، ويخطط الخطوة
      // التالية بناءً عليها — دون إسهاب أو حشو محادثي غير ضروري.
      const SYSTEM_CAPABILITIES = `\n\n## هويتك ودورك\nأنت FOX AI — وكيل تنفيذ مهام (task-executing agent) يعمل داخل بيئة Ubuntu 24.04 حقيقية (عبر GitHub Actions runner)، وليس مجرد مساعد محادثة. أسلوبك: تحليل الهدف → اقتراح الخطوة التنفيذية القادمة كأمر حقيقي → قراءة نتيجتها عند وصولها → تحديد الخطوة التالية بناءً على النتيجة الفعلية، لا على افتراض. تتكلم بإيجاز عملي مباشر، لا شرح نظري إلا إذا طُلب صراحة.\n\n## قدرات التنفيذ\nضع أي أمر تقترح تنفيذه بين ثلاث علامات backtick مع نوع اللغة (\`\`\`bash أو \`\`\`python أو \`\`\`sh). هذا اقتراح فقط لخطوة تنفيذية — لن يُنفَّذ تلقائيًا؛ المستخدم يوافق عليه يدويًا من الواجهة قبل أي تنفيذ فعلي (طبقة أمان مقصودة، وليست تقليلاً من كونك وكيلاً تنفيذياً). بعد وصول نتيجة التنفيذ، اقرأها فعلياً واستخدمها في تحديد الخطوة التالية بدل تكرار الاقتراح نفسه.`;
      const systemContent = `${SYSTEM_CAPABILITIES}\n\n## وثيقة المشروع (ذاكرة طويلة المدى — ملخّص، وليست بديلاً عن سياق المحادثة الحالي)\n${currentMemory || '(فارغة)'}`;

      // نرسل آخر عدة رسائل خامًا (لا آخر رسالة فقط) — وثيقة الذاكرة تُحدَّث
      // بعد كل رد، أي أنها عند توليد الرد الحالي لا تعكس بعد آخر تبادل
      // (وهو الأكثر أهمية للتماسك الفوري). هذا يجمع الاثنين: الذاكرة للسياق
      // طويل المدى + آخر رسائل خامًا للتماسك القريب.
      const HISTORY_LIMIT = 12;
      const recentMessages = messages.slice(-HISTORY_LIMIT).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));

      let rawResponse = '';
      if (resolved.kind === 'gemini') {
        if (!env.GEMINI_API_KEY) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY غير معرّف' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        rawResponse = await callGemini(env.GEMINI_API_KEY, systemContent, recentMessages, resolved.modelId);
      } else if (resolved.kind === 'workers-ai') {
        rawResponse = await callWorkersAI(env, resolved.modelId, systemContent, recentMessages);
      } else if (resolved.kind === 'cerebras') {
        if (!env.CEREBRAS_API_KEY) return new Response(JSON.stringify({ error: 'CEREBRAS_API_KEY غير معرّف' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        rawResponse = await callCerebras(env.CEREBRAS_API_KEY, resolved.modelId, systemContent, recentMessages);
      } else {
        return new Response(JSON.stringify({ error: 'مزود/نموذج غير مدعوم' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      // ============ استخراج أمر مُقترَح فقط — بلا أي تنفيذ تلقائي ============
      const extracted = extractCommandFromResponse(rawResponse);
      const pendingExecution = extracted
        ? { requiresApproval: true, command: extracted.command, language: extracted.language }
        : null;

      let updatedMemory = '';
      try { updatedMemory = await updateMemory(env, chatId, userText, rawResponse); } catch (e) {}

      return new Response(JSON.stringify({
        response: rawResponse,
        memory: updatedMemory,
        pendingExecution,
      }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    } catch (error) {
      console.error('FOX AI worker error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
  },
};

function extractCommandFromResponse(response) {
  if (!response) return null;
  const bashMatch = response.match(/```bash\n([\s\S]*?)```/);
  if (bashMatch) return { command: bashMatch[1].trim(), language: 'bash' };
  const pythonMatch = response.match(/```python\n([\s\S]*?)```/);
  if (pythonMatch) return { command: pythonMatch[1].trim(), language: 'python' };
  const shellMatch = response.match(/```sh\n([\s\S]*?)```/);
  if (shellMatch) return { command: shellMatch[1].trim(), language: 'sh' };
  return null;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isSessionValid(env, token) {
  if (!token) return false;
  try {
    const now = Date.now();
    const session = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token = ?').bind(token).first();
    if (!session) return false;
    if (session.expires_at <= now) { env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run().catch(() => {}); return false; }
    return true;
  } catch (e) { return false; }
}

export class ExperimentState {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/start') return await this.startExperiment(request);
    if (path === '/result') return await this.handleResult(request);
    if (path === '/check') return await this.checkStatus();
    if (path === '/retry') return await this.retryExperiment();
    if (path === '/alarm') return await this.handleAlarm();
    return new Response(JSON.stringify({ error: 'Invalid DO path' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  async startExperiment(request) {
    const data = await request.json();
    const now = Date.now();

    // منع بدء تجربة جديدة فوق تجربة نشطة بالفعل لنفس المحادثة
    const existing = await this.state.storage.get('experiment');
    if (existing && (existing.status === 'pending' || existing.status === 'retrying')) {
      return new Response(JSON.stringify({
        error: 'توجد تجربة نشطة بالفعل لهذه المحادثة — انتظر انتهاءها أولاً',
        activeExperiment: existing,
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }

    const experimentData = {
      command: data.command, chatId: data.chatId || 'unknown', status: 'pending',
      attempts: 0, startedAt: now, dispatchedAt: now, lastUpdate: now, githubToken: data.githubToken,
    };
    await this.state.storage.put('experiment', experimentData);
    await this.state.storage.setAlarm(now + 60000);
    return await this.dispatchToGitHub(data.command, data.githubToken, experimentData.chatId);
  }

  async handleResult(request) {
    const data = await request.json();
    const output = data.output || '';
    const exitCode = data.exitCode ?? 0;
    const experiment = await this.state.storage.get('experiment');
    if (!experiment) return new Response(JSON.stringify({ error: 'لا توجد تجربة نشطة' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    // حارس ثبات: لو التجربة أُنهيت بالفعل (عبر alarm سبق ووصل قبل هذا الـ webhook)، لا نعالجها مرة أخرى
    if (experiment.status === 'completed' || experiment.status === 'failed') {
      return new Response(JSON.stringify({ status: experiment.status, experiment, note: 'نتيجة متكررة تم تجاهلها (مُنهاة مسبقًا)' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // نُلغي المؤقت فورًا قبل أي معالجة أخرى — يمنع تسابقه مع هذا الطلب
    await this.state.storage.deleteAlarm();

    const now = Date.now();
    experiment.output = output; experiment.exitCode = exitCode; experiment.lastUpdate = now;

    if (exitCode === 0) {
      experiment.status = 'completed';
      await this.state.storage.put('experiment', experiment);
      return new Response(JSON.stringify({ status: 'completed', experiment }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (experiment.attempts >= 5 || (now - experiment.startedAt) >= 20 * 60 * 1000) {
      experiment.status = 'failed';
      await this.state.storage.put('experiment', experiment);
      return new Response(JSON.stringify({ status: 'failed', experiment }), { headers: { 'Content-Type': 'application/json' } });
    }

    experiment.attempts += 1;
    experiment.status = 'retrying';
    experiment.dispatchedAt = now;
    await this.state.storage.put('experiment', experiment);
    await this.state.storage.setAlarm(now + 60000); // شبكة أمان لهذه المحاولة الجديدة أيضًا
    await this.dispatchToGitHub(experiment.command, experiment.githubToken, experiment.chatId);
    return new Response(JSON.stringify({ status: 'retrying', attempt: experiment.attempts, experiment }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ملاحظة إصلاح: كان يُرسل { command } فقط بدون chat_id — يعني نتيجة كل
  // تشغيل ترجع بدون أي إشارة لأي محادثة تخصّها، فيسقط الـ webhook دائمًا
  // على experimentId='unknown' في worker fetch handler. الآن يُرسل chat_id
  // ليعود بالضبط في payload الـ /result من Terminal.yml (انظر التعديل هناك).
  async dispatchToGitHub(command, githubToken, chatId) {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + githubToken, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', inputs: { command, chat_id: chatId || 'unknown' } }),
    });
    if (response.status === 204) return new Response(JSON.stringify({ success: true, message: 'تم إرسال الأمر للتنفيذ', experimentId: this.state.id.toString() }), { headers: { 'Content-Type': 'application/json' } });
    const errorData = await response.json().catch(() => ({}));
    return new Response(JSON.stringify({ error: errorData.message || 'GitHub API error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  async handleAlarm() {
    const experiment = await this.state.storage.get('experiment');
    if (!experiment) return new Response('No experiment');

    // حارس ثبات مطابق لـ handleResult — يمنع إعادة معالجة تجربة مُنهاة بالفعل
    if (experiment.status === 'completed' || experiment.status === 'failed') {
      return new Response('Already finalized');
    }

    const elapsed = Date.now() - experiment.startedAt;
    const MAX_TIME = 20 * 60 * 1000, MAX_ATTEMPTS = 5;

    try {
      const status = await this.checkGitHubRuns(experiment.githubToken, experiment.dispatchedAt || experiment.startedAt);
      if (status.status === 'completed') {
        experiment.status = 'completed'; experiment.lastUpdate = Date.now();
        await this.state.storage.put('experiment', experiment);
        await this.state.storage.deleteAlarm();
        return new Response('Experiment completed');
      }
    } catch (e) {}

    if (elapsed >= MAX_TIME || experiment.attempts >= MAX_ATTEMPTS) {
      experiment.status = 'failed'; experiment.lastUpdate = Date.now();
      await this.state.storage.put('experiment', experiment);
      await this.state.storage.deleteAlarm();
      return new Response('Experiment failed');
    }

    experiment.attempts += 1; experiment.status = 'retrying'; experiment.lastUpdate = Date.now();
    await this.state.storage.put('experiment', experiment);
    await this.state.storage.setAlarm(Date.now() + 60000);
    return new Response('Retrying - attempt ' + experiment.attempts);
  }

  // sinceTs: لا نأخذ "آخر تشغيل في المستودع" مطلقًا، بل أول تشغيل بدأ بعد
  // وقت الإرسال الفعلي لهذه التجربة (بهامش 5 ثوانٍ) — يقلل خطر التقاط
  // تشغيل يخص تجربة أخرى، رغم أن GitHub API لا يُرجع run_id مباشرة عند
  // workflow_dispatch فيبقى هذا تقريبًا لا ضمانًا مطلقًا.
  async checkGitHubRuns(githubToken, sinceTs) {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=5`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + githubToken, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const data = await response.json();
    const runs = data.workflow_runs || [];
    const match = runs.find(r => new Date(r.created_at).getTime() >= (sinceTs - 5000));
    if (!match) return { status: 'no_matching_run' };
    return { id: match.id, status: match.status, conclusion: match.conclusion };
  }

  async checkStatus() {
    const experiment = await this.state.storage.get('experiment');
    if (!experiment) return new Response(JSON.stringify({ error: 'لا توجد تجربة نشطة' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(experiment), { headers: { 'Content-Type': 'application/json' } });
  }

  async retryExperiment() {
    const experiment = await this.state.storage.get('experiment');
    if (!experiment || experiment.attempts >= 5) return new Response(JSON.stringify({ error: 'الحد الأقصى' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    experiment.attempts += 1; experiment.status = 'retrying'; experiment.lastUpdate = Date.now();
    await this.state.storage.put('experiment', experiment);
    return new Response(JSON.stringify({ retry: experiment.attempts }), { headers: { 'Content-Type': 'application/json' } });
  }
}

// ============ النماذج ============
// Gemini: نموذج واحد فقط مؤكد فعليًا (gemini-3.5-flash) — أُزيلت الإصدارات
// الأخرى (3.6/3.7/3.8) لأنها لم تُؤكَّد كموجودة فعليًا. المفاتيح المسطّحة
// القديمة تبقى مدعومة لتوافق أي واجهة قديمة، لكنها كلها تُرجع نفس النموذج.
const CONFIRMED_GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_MODEL_MAP = {
  'gemini': CONFIRMED_GEMINI_MODEL,
  'gemini-3.5-flash': CONFIRMED_GEMINI_MODEL,
};

// Workers AI: هذه القائمة أكدت أنها تعمل فعليًا — لم تُمس.
const WORKERS_AI_MODELS = {
  'cf-glm-flash': '@cf/zai-org/glm-4.7-flash',
  'cf-qwen3-coder': '@cf/qwen/qwen3.8-27b',
  'cf-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'cf-qwen3': '@cf/qwen/qwen3-30b-a3b-fp8',
  'cf-gpt-oss-20b': '@cf/openai/gpt-oss-20b',
  'cf-gemma-4': '@cf/google/gemma-4-26b-a4b-it',
  'cf-nemotron': '@cf/nvidia/nemotron-3-120b-a12b',
  'cf-gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'cf-deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'cf-qwq': '@cf/qwen/qwq-32b',
  'cf-llama-4': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'cf-mistral': '@cf/mistralai/mistral-small-3.1-24b-instruct',
  'cf-llama-70b': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'cf-llama-vision': '@cf/meta/llama-3.2-11b-vision-instruct',
  'cf-granite': '@cf/ibm-granite/granite-4.0-h-micro',
};

// Cerebras: مضافة حديثًا عبر CEREBRAS_API_KEY. واجهتها متوافقة مع OpenAI
// Chat Completions (https://api.cerebras.ai/v1/chat/completions)، فلا
// تحتاج دالة استدعاء منفصلة معقّدة — راجع callCerebras بالأسفل.
// المفاتيح اليمنى هنا هي بالضبط أسماء النماذج كما أرجعها GET /v1/models
// من Cerebras وقت الإضافة — إن غيّرت Cerebras الأسماء لاحقًا يجب تحديثها هنا.
const CEREBRAS_MODELS = {
  'cerebras-gemma-4-31b': 'gemma-4-31b',
  'cerebras-qwen-3.8-27b': 'qwen-3.8-27b',
  'cerebras-gpt-oss-120b': 'gpt-oss-120b',
};

const GITHUB_REPO = 'abdelrhym096290-ux/video-compressor-bot';
const GITHUB_WORKFLOW = 'terminal.yml';

// يقبل صيغتين: "gemini:gemini-3.5-flash" / "cf:@cf/qwen/..." (الواجهة
// الحالية) أو مفتاحًا مسطحًا قديمًا مثل "cf-coder" أو "gemini" — يحل
// تعارض العقد بين الواجهة والـ Worker بدل تركه يفشل بصمت.
function resolveModel(raw) {
  const fallback = { kind: 'gemini', modelId: CONFIRMED_GEMINI_MODEL };
  if (!raw) return fallback;

  if (raw.includes(':')) {
    const idx = raw.indexOf(':');
    const prefix = raw.slice(0, idx);
    const rest = raw.slice(idx + 1);
    if (prefix === 'gemini') return { kind: 'gemini', modelId: GEMINI_MODEL_MAP[rest] || fallback.modelId };
    if (prefix === 'cf') return { kind: 'workers-ai', modelId: rest };
    if (prefix === 'cerebras') return { kind: 'cerebras', modelId: CEREBRAS_MODELS[rest] || rest };
  }

  if (GEMINI_MODEL_MAP[raw]) return { kind: 'gemini', modelId: GEMINI_MODEL_MAP[raw] };
  if (WORKERS_AI_MODELS[raw]) return { kind: 'workers-ai', modelId: WORKERS_AI_MODELS[raw] };
  if (CEREBRAS_MODELS[raw]) return { kind: 'cerebras', modelId: CEREBRAS_MODELS[raw] };
  return fallback;
}

async function callGemini(apiKey, systemText, historyMessages, modelId) {
  const contents = historyMessages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelId + ':generateContent';
  const requestBody = { contents };
  if (systemText) requestBody.systemInstruction = { parts: [{ text: systemText }] };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(requestBody),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 429) throw new Error('تم تجاوز الحد المجاني. حاول لاحقاً.');
    throw new Error(data.error?.message || 'Gemini API error');
  }
  const candidate = data.candidates?.[0];
  if (!candidate) return 'لا يوجد رد';
  return candidate.content?.parts?.[0]?.text || 'لا يوجد رد';
}

async function callWorkersAI(env, modelId, systemText, historyMessages) {
  const messages = [{ role: 'system', content: systemText }, ...historyMessages];
  try {
    const response = await env.AI.run(modelId, { messages, max_tokens: 4096 }, { gateway: { id: 'fox-gateway' } });
    const contentOut = response.response || response.choices?.[0]?.message?.content || (typeof response === 'string' ? response : '');
    if (!contentOut) throw new Error('استجابة فارغة');
    return contentOut;
  } catch (error) {
    if (error.message?.includes('quota') || error.message?.includes('429')) throw new Error('تم استنفاد حصة Workers AI اليومية.');
    throw new Error(`خطأ من Workers AI (${modelId}): ${error.message || 'غير معروف'}`);
  }
}

// Cerebras Cloud — واجهة متوافقة مع OpenAI (نفس شكل رسائل callWorkersAI
// بالضبط). لا يوجد gateway/binding خاص هنا كما في AI.run — استدعاء HTTP
// عادي بمفتاح CEREBRAS_API_KEY من الأسرار.
async function callCerebras(apiKey, modelId, systemText, historyMessages) {
  const messages = [{ role: 'system', content: systemText }, ...historyMessages];
  const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 4096 }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 429) throw new Error('تم تجاوز الحد المجاني لـ Cerebras. حاول لاحقاً.');
    throw new Error(data.error?.message || `Cerebras API error (${modelId})`);
  }
  const contentOut = data.choices?.[0]?.message?.content;
  if (!contentOut) throw new Error('استجابة فارغة من Cerebras');
  return contentOut;
}

async function updateMemory(env, chatId, userMessage, aiResponse) {
  if (!chatId || !userMessage || !aiResponse) return '';
  try {
    const existing = await env.DB.prepare('SELECT content FROM project_memory WHERE chat_id = ?').bind(chatId).first();
    const currentMemory = existing?.content || '';
    const memoryPrompt = `أنت مسؤول صيانة وثيقة توثيق حية. حدّث الوثيقة بدمج المعلومات الجديدة.\n\nالوثيقة الحالية:\n${currentMemory || '(فارغة)'}\n\nآخر رسالة:\n${userMessage}\n\nرد المساعد:\n${aiResponse}\n\nأعد كتابة الوثيقة المحدثة.`;
    const response = await env.AI.run('@cf/qwen/qwen2.5-coder-32b-instruct', { messages: [{ role: 'user', content: memoryPrompt }], max_tokens: 2000 }, { gateway: { id: 'fox-gateway' } });
    const updatedContent = response.response || '';
    if (!updatedContent) return currentMemory;
    await env.DB.prepare(`INSERT INTO project_memory (chat_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET content = ?, updated_at = ?`)
      .bind(chatId, updatedContent, Date.now(), updatedContent, Date.now()).run();
    return updatedContent;
  } catch (error) { return ''; }
}

async function getUsageFromGateway(env) {
  const ACCOUNT_ID = '83880c2ae9ec32b24fc954ea8dd57d6d';
  const now = new Date();
  const startISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const endISO = now.toISOString();
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
  groups.forEach(function(g) {
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
  return { period: { from: startISO, to: endISO }, totals: { requests: totalRequests, tokensIn: totalTokensIn, tokensOut: totalTokensOut, totalTokens, cost: totalCost }, byModel: modelStats, note: 'بيانات الاستهلاك من AI Gateway' };
}