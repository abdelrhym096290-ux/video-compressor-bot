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

    try {
      const body = await request.json();
      const { action, messages, provider, chatId, content } = body;
      console.log('FOX AI request:', action, 'messages:', messages?.length, 'provider:', provider, 'chatId:', chatId);

      // ============ GET MEMORY ============
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

      // ============ MEMORY UPDATE (يدوي) ============
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

      // ============ CHAT ============
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

      // 1) قراءة الذاكرة الحالية
      let currentMemory = '';
      try {
        const memResult = await env.DB.prepare(
          'SELECT content FROM project_memory WHERE chat_id = ?'
        ).bind(chatId).first();
        currentMemory = memResult?.content || '';
      } catch (dbError) {
        console.error('D1 read memory error (non-fatal):', dbError.message);
      }

      // 2) بناء السياق المختصر
      const contextMessages = [];
      if (currentMemory) {
        contextMessages.push({
          role: 'system',
          content: `أنت مساعد ذكي. هذه وثيقة مشروعك الحية (ذاكرتك الدائمة للمحادثة). استخدمها كسياق لفهم ما سبق.\n\n${currentMemory}`
        });
      }
      contextMessages.push({ role: 'user', content: userText });

      // 3) استدعاء النموذج
      let rawResponse = '';

      if (selectedProvider === 'gemini') {
        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: 'GEMINI_API_KEY غير معرّف في إعدادات الـ Worker.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        rawResponse = await callGemini(env.GEMINI_API_KEY, contextMessages);
      } else if (WORKERS_AI_MODELS[selectedProvider]) {
        rawResponse = await callWorkersAI(env, selectedProvider, contextMessages);
      } else {
        return new Response(JSON.stringify({ error: `مزود غير مدعوم: ${selectedProvider}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      // 4) تحديث الذاكرة
      let updatedMemory = '';
      try {
        updatedMemory = await updateMemory(env, chatId, userText, rawResponse);
        if (!updatedMemory) updatedMemory = currentMemory;
      } catch (memoryError) {
        console.error('Memory update failed (non-fatal):', memoryError.message);
        updatedMemory = currentMemory;
      }

      // 5) إرجاع الرد + الذاكرة
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

// ============ 15 نموذجاً محدثاً (سبتمبر 2026) ============
const WORKERS_AI_MODELS = {
  // --- الأفضل للبرمجة ---
  'cf-glm-flash': '@cf/zai-org/glm-4.7-flash',
  'cf-qwen3-coder': '@cf/qwen/qwen3.8-27b',
  'cf-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'cf-qwen3': '@cf/qwen/qwen3-30b-a3b-fp8',
  'cf-gpt-oss-20b': '@cf/openai/gpt-oss-20b',

  // --- الأقوى للتفكير والمنطق ---
  'cf-gemma-4': '@cf/google/gemma-4-26b-a4b-it',
  'cf-nemotron': '@cf/nvidia/nemotron-3-120b-a12b',
  'cf-gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'cf-deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'cf-qwq': '@cf/qwen/qwq-32b',

  // --- نماذج عامة ورؤية ---
  'cf-llama-4': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'cf-mistral': '@cf/mistralai/mistral-small-3.1-24b-instruct',
  'cf-llama-70b': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'cf-llama-vision': '@cf/meta/llama-3.2-11b-vision-instruct',
  'cf-granite': '@cf/ibm-granite/granite-4.0-h-micro',
};

async function callGemini(apiKey, messages) {
  const contents = messages.map(m => {
    const role = m.role === 'user' ? 'user' : 'model';
    return {
      role: role,
      parts: [{ text: m.content }],
    };
  });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
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
      }
    );

    const content =
      response.response ||
      response.choices?.[0]?.message?.content ||
      (typeof response === 'string' ? response : '');

    if (!content) {
      throw new Error('استجابة فارغة من النموذج');
    }

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

    const memoryPrompt = `أنت مدير وثيقة مشروع حية. دمج المعلومات الجديدة في الوثيقة الحالية.

الوثيقة الحالية:
${currentMemory || '(فارغة - هذه أول رسالة)'}

آخر رسالة من المستخدم:
${userMessage}

رد المساعد:
${aiResponse}

أعد كتابة الوثيقة الكاملة كنص Markdown محدث. أضف المعلومات الجديدة، حدّث القديم، واحذف ما لم يعد مهماً. أعد الوثيقة فقط بدون أي مقدمات.`;

    const response = await env.AI.run(
      '@cf/qwen/qwen2.5-coder-32b-instruct',
      {
        messages: [{ role: 'user', content: memoryPrompt }],
        max_tokens: 2000,
      }
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