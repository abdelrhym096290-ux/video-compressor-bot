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
      const { action, messages } = body;
      console.log('FOX AI request:', action, 'messages:', messages?.length);

      if (action !== 'chat') {
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (!env.GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY is not set on this worker');
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY غير معرّف في إعدادات الـ Worker. شغّل: wrangler secret put GEMINI_API_KEY' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: 'لا توجد رسائل لإرسالها' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const geminiText = await callGemini(env.GEMINI_API_KEY, messages);

      return new Response(JSON.stringify({ response: geminiText }), {
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

async function callGemini(apiKey, messages) {
  // Gemini uses roles "user" and "model" (not "assistant"/"ai")
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
    throw new Error(data.error?.message || ('Gemini API error (status ' + response.status + ')'));
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    console.error('Gemini returned no candidates:', JSON.stringify(data));
    // e.g. blocked by safety filters — promptFeedback explains why
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) throw new Error('تم حظر الرد بواسطة فلاتر السلامة: ' + blockReason);
    return 'لا يوجد رد';
  }

  return candidate.content?.parts?.[0]?.text || 'لا يوجد رد';
}
