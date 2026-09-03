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
        const webhookBody = await request.json();
        const signature = request.headers.get('X-Hub-Signature-256') || '';
        
        // تحقق HMAC
        const expectedSig = 'sha256=' + await hmacSign(webhookBody, env.HMAC_SECRET);
        if (signature !== expectedSig) {
          return new Response(JSON.stringify({ error: 'توقيع غير صالح' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }

        const output = webhookBody.output || 'لا توجد نتائج';
        const experimentId = webhookBody.experimentId || 'unknown';
        const exitCode = webhookBody.exit_code || 0;

        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO experiments (chat_id, command, status, output, exit_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(experimentId, 'from-github', 'completed', output, exitCode, now, now)
        .run();

        return new Response(JSON.stringify({ success: true }), {
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
      const { action, messages, provider, chatId, content, accessPassword, command } = body;
      console.log('FOX AI request:', action, 'messages:', messages?.length, 'provider:', provider, 'chatId:', chatId);

      if (accessPassword !== env.ACCESS_PASSWORD) {
        return new Response(JSON.stringify({ error: 'كلمة المرور غير صحيحة', authRequired: true }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (action === 'get_memory') {
        if (!chatId) {
          return new Response(JSON.stringify({ error: 'chatId مطلوب' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }

        try {
          const result = await env.DB.prepare(
            'SELECT content FROM project_memory WHERE chat_id = ?'
          ).bind(chatId).first();

          return new Response(JSON.stringify({
            content: result?.content || ''
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (dbError) {
          console.error('D1 get_memory error:', dbError.message);
          return new Response(JSON.stringify({ error: 'خطأ في قراءة الذاكرة: ' + dbError.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (action === 'memory_update') {
        if (!chatId) {
          return new Response(JSON.stringify({ error: 'chatId مطلوب' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }

        try {
          await env.DB.prepare(
            `INSERT INTO project_memory (chat_id, content, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE
             SET content = ?, updated_at = ?`
          )
          .bind(chatId, content || '', Date.now(), content || '', Date.now())
          .run();

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (dbError) {
          console.error('D1 memory_update error:', dbError.message);
          return new Response(JSON.stringify({ error: 'خطأ في حفظ الذاكرة: ' + dbError.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      // ============ RUN COMMAND ============
      if (action === 'run_command') {
        if (!command) {
          return new Response(JSON.stringify({ error: 'command مطلوب' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }

        try {
          const experimentId = chatId || 'default-' + Date.now();
          const id = env.EXPERIMENT_STATE.idFromName(experimentId);
          const experimentObj = env.EXPERIMENT_STATE.get(id);
          
          const result = await experimentObj.fetch('https://internal/start', {
            method: 'POST',
            body: JSON.stringify({
              command: command,
              chatId: chatId,
              githubToken: env.GITHUB_TOKEN,
              hmacSecret: env.HMAC_SECRET,
              db: true
            })
          });

          const resultData = await result.json();
          return new Response(JSON.stringify(resultData), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (cmdError) {
          console.error('run_command error:', cmdError.message);
          return new Response(JSON.stringify({ error: 'خطأ في تشغيل الأمر: ' + cmdError.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (action === 'usage') {
        try {
          const usageData = await getUsageFromGateway(env);
          return new Response(JSON.stringify(usageData), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (usageError) {
          console.error('Usage error:', usageError.message);
          return new Response(JSON.stringify({ error: 'خطأ في جلب الاستهلاك: ' + usageError.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (action !== 'chat') {
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: 'لا توجد رسائل لإرسالها' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const selectedProvider = provider || 'gemini';
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
      const userText = lastUserMessage?.content || '';

      if (!userText) {
        return new Response(JSON.stringify({ error: 'لا توجد رسالة مستخدم' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      let currentMemory = '';
      try {
        const memResult = await env.DB.prepare(
          'SELECT content FROM project_memory WHERE chat_id = ?'
        ).bind(chatId).first();
        currentMemory = memResult?.content || '';
      } catch (dbError) {
        console.error('D1 read memory error (non-fatal):', dbError.message);
      }

      const SYSTEM_CAPABILITIES = `\n\n---\n## قدرات النظام المتاحة\n\nيمكنك تنفيذ أوامر Linux حقيقية في بيئة Ubuntu 24.04 معزولة عبر GitHub Actions. عند الحاجة لتنفيذ كود أو أمر، اطلب من المستخدم السماح بذلك أو استخدم الأمر مباشرة.\n\nمثال: إذا طلب منك المستخدم تشغيل كود Python، يمكنك اقتراح: "هل تريدني أن أنفذ هذا الكود في بيئة معزولة؟"\n`;

      const contextMessages = [];
      const systemContent = `أنت مساعد ذكي. هذه وثيقة مشروعك الحية (ذاكرتك الدائمة للمحادثة). استخدمها كسياق لفهم ما سبق.\n\n${currentMemory || '(لا توجد ذاكرة بعد)'}${SYSTEM_CAPABILITIES}`;
      
      contextMessages.push({ role: 'system', content: systemContent });
      contextMessages.push({ role: 'user', content: userText });

      let rawResponse = '';

      if (GEMINI_MODEL_MAP[selectedProvider]) {
        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: 'GEMINI_API_KEY غير معرّف في إعدادات الـ Worker.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        rawResponse = await callGemini(env.GEMINI_API_KEY, contextMessages, selectedProvider);
      } else if (WORKERS_AI_MODELS[selectedProvider]) {
        rawResponse = await callWorkersAI(env, selectedProvider, contextMessages);
      } else {
        return new Response(JSON.stringify({ error: `مزود غير مدعوم: ${selectedProvider}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      let updatedMemory = '';
      try {
        updatedMemory = await updateMemory(env, chatId, userText, rawResponse);
        if (!updatedMemory) updatedMemory = currentMemory;
      } catch (memoryError) {
        console.error('Memory update failed (non-fatal):', memoryError.message);
        updatedMemory = currentMemory;
      }

      return new Response(JSON.stringify({
        response: rawResponse,
        memory: updatedMemory
      }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    } catch (error) {
      console.error('FOX AI worker error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },
};

// ============ Durable Object ============
export class ExperimentState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/start') {
      return await this.startExperiment(request);
    } else if (path === '/check') {
      return await this.checkStatus();
    } else if (path === '/retry') {
      return await this.retryExperiment();
    }

    return new Response(JSON.stringify({ error: 'Invalid DO path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async startExperiment(request) {
    const data = await request.json();
    const command = data.command;
    const chatId = data.chatId || 'unknown';
    const githubToken = data.githubToken;
    const hmacSecret = data.hmacSecret;

    const now = Date.now();
    const experimentData = {
      command: command,
      chatId: chatId,
      status: 'pending',
      attempts: 0,
      startedAt: now,
      lastUpdate: now,
    };

    await this.state.storage.put('experiment', experimentData);

    return await this.dispatchToGitHub(command, githubToken, hmacSecret);
  }

  async dispatchToGitHub(command, githubToken, hmacSecret) {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + githubToken,
          'Accept': 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { command: command },
        }),
      }
    );

    if (response.status === 204) {
      return new Response(JSON.stringify({
        success: true,
        message: 'تم إرسال الأمر للتنفيذ في GitHub Actions',
        experimentId: this.state.id.toString(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const errorData = await response.json().catch(() => ({}));
    return new Response(JSON.stringify({
      error: errorData.message || 'GitHub API error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async checkStatus() {
    const experiment = await this.state.storage.get('experiment');
    if (!experiment) {
      return new Response(JSON.stringify({ error: 'لا توجد تجربة نشطة' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(experiment), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async retryExperiment() {
    const experiment = await this.state.storage.get('experiment');
    if (!experiment || experiment.attempts >= 5) {
      return new Response(JSON.stringify({ error: 'تم الوصول للحد الأقصى من المحاولات' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    experiment.attempts += 1;
    experiment.status = 'retrying';
    experiment.lastUpdate = Date.now();
    await this.state.storage.put('experiment', experiment);

    return new Response(JSON.stringify({ retry: experiment.attempts }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============ HMAC ============
async function hmacSign(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(JSON.stringify(data, Object.keys(data).sort()))
  );
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============ نماذج Gemini ============
const GEMINI_MODEL_MAP = {
  'gemini': 'gemini-3.6-flash',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.7-flash': 'gemini-3.7-flash',
  'gemini-3.6-flash': 'gemini-3.6-flash',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest': 'gemini-flash-lite-latest',
};

// ============ نماذج Workers AI ============
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

// ============ إعدادات GitHub ============
const GITHUB_REPO = 'abdelrhym096290-ux/video-compressor-bot';
const GITHUB_WORKFLOW = 'terminal.yml';

async function callGemini(apiKey, messages, provider) {
  const modelName = GEMINI_MODEL_MAP[provider] || 'gemini-3.6-flash';

  const contents = messages.map(m => {
    const role = m.role === 'user' ? 'user' : 'model';
    return { role: role, parts: [{ text: m.content }] };
  });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Gemini API error:', JSON.stringify(data));
    if (response.status === 429) {
      const retryDetail = data.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
      const retrySeconds = retryDetail?.retryDelay ? parseInt(retryDetail.retryDelay) : null;
      throw new Error(
        'تم تجاوز الحد المجاني المسموح به من Google للنموذج حاليًا. ' +
        (retrySeconds ? ('حاول مرة أخرى خلال ' + retrySeconds + ' ثانية.') : 'حاول مرة أخرى بعد قليل، أو فعّل الفوترة في مشروع Google Cloud لرفع الحد المسموح.')
      );
    }
    throw new Error(data.error?.message || ('Gemini API error (status ' + response.status + ')'));
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    console.error('Gemini returned no candidates:', JSON.stringify(data));
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) throw new Error('تم حظر الرد بواسطة فلاتر السلامة: ' + blockReason);
    return 'لا يوجد رد';
  }

  return candidate.content?.parts?.[0]?.text || 'لا يوجد رد';
}

async function callWorkersAI(env, provider, messages) {
  const model = WORKERS_AI_MODELS[provider];

  try {
    const response = await env.AI.run(
      model,
      {
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'system' : m.role,
          content: m.content,
        })),
        max_tokens: 4096,
      },
      { gateway: { id: 'fox-gateway' } }
    );

    const content =
      response.response ||
      response.choices?.[0]?.message?.content ||
      (typeof response === 'string' ? response : '');

    if (!content) throw new Error('استجابة فارغة من النموذج');

    return content;
  } catch (error) {
    console.error(`Workers AI error (${provider}):`, error);

    if (error.message?.includes('quota') || error.message?.includes('429')) {
      throw new Error('تم استنفاد حصة Workers AI اليومية. يمكنك التبديل إلى Gemini أو المحاولة غداً.');
    }

    throw new Error(`خطأ من Workers AI (${provider}): ${error.message || 'خطأ غير معروف'}`);
  }
}

async function updateMemory(env, chatId, userMessage, aiResponse) {
  if (!chatId || !userMessage || !aiResponse) return '';

  try {
    const existing = await env.DB.prepare(
      'SELECT content FROM project_memory WHERE chat_id = ?'
    ).bind(chatId).first();

    const currentMemory = existing?.content || '';

    const memoryPrompt = `أنت مدير وثيقة مشروع حية. دمج المعلومات الجديدة في الوثيقة الحالية.\n\nالوثيقة الحالية:\n${currentMemory || '(فارغة - هذه أول رسالة)'}\n\nآخر رسالة من المستخدم:\n${userMessage}\n\nرد المساعد:\n${aiResponse}\n\nأعد كتابة الوثيقة الكاملة كنص Markdown محدث. أعد الوثيقة فقط بدون أي مقدمات.`;

    const response = await env.AI.run(
      '@cf/qwen/qwen2.5-coder-32b-instruct',
      { messages: [{ role: 'user', content: memoryPrompt }], max_tokens: 2000 },
      { gateway: { id: 'fox-gateway' } }
    );

    const updatedContent = response.response || '';
    if (!updatedContent) return currentMemory;

    await env.DB.prepare(
      `INSERT INTO project_memory (chat_id, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE
       SET content = ?, updated_at = ?`
    )
    .bind(chatId, updatedContent, Date.now(), updatedContent, Date.now())
    .run();

    return updatedContent;
  } catch (error) {
    console.error('updateMemory error:', error.message);
    return '';
  }
}

async function getUsageFromGateway(env) {
  const ACCOUNT_ID = '83880c2ae9ec32b24fc954ea8dd57d6d';

  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startISO = startOfDay.toISOString();
  const endISO = now.toISOString();

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
          aiGatewayRequestsAdaptiveGroups(
            filter: {
              datetimeHour_geq: "${startISO}"
              datetimeHour_leq: "${endISO}"
            }
            limit: 1000
          ) {
            count
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.CF_API_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(data.errors[0]?.message || 'GraphQL error');
  }

  const groups = data.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups || [];

  let totalRequests = 0;

  groups.forEach(function(g) {
    totalRequests += g.count || 0;
  });

  return {
    period: { from: startISO, to: endISO },
    totals: { requests: totalRequests },
    note: 'عدد الطلبات المسجلة عبر AI Gateway اليوم'
  };
}