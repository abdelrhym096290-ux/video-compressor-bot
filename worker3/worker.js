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
      const { action, messages, provider, chatId } = body;
      console.log('FOX AI request:', action, 'messages:', messages?.length, 'provider:', provider);

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

      let responseText;

      if (selectedProvider === 'gemini') {
        if (!env.GEMINI_API_KEY) {
          console.error('GEMINI_API_KEY is not set on this worker');
          return new Response(JSON.stringify({ error: 'GEMINI_API_KEY غير معرّف في إعدادات الـ Worker. شغّل: wrangler secret put GEMINI_API_KEY' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        responseText = await callGemini(env.GEMINI_API_KEY, messages);
      } else if (WORKERS_AI_MODELS[selectedProvider]) {
        responseText = await callWorkersAI(env, selectedProvider, messages);
      } else {
        return new Response(JSON.stringify({ error: `مزود غير مدعوم: ${selectedProvider}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      return new Response(JSON.stringify({ response: responseText }), {
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

// خريطة مزودي Workers AI
const WORKERS_AI_MODELS = {
  'cf-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'cf-qwen3': '@cf/qwen/qwen3-30b-a3b-fp8',
  'cf-deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'cf-qwq': '@cf/qwen/qwq-32b',
  'cf-gpt-oss': '@cf/openai/gpt-oss-20b',
};

async function callGemini(apiKey, messages) {
  const contents = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

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
          role: m.role,
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