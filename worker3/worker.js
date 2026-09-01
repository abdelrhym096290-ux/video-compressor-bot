export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return new Response('FOX AI Worker is running', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      const { action, chatId, messages } = body;

      if (action === 'save') {
        await saveMessage(env.DB, chatId, messages[messages.length - 1]);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (action === 'load') {
        const history = await loadChat(env.DB, chatId);
        return new Response(JSON.stringify({ messages: history }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (action === 'chat') {
        const history = await loadChat(env.DB, chatId);
        const allMessages = [...history, ...messages];

        const geminiResponse = await callGemini(env.GEMINI_API_KEY, allMessages);

        await saveMessage(env.DB, chatId, { role: 'user', content: messages[messages.length - 1].content });
        await saveMessage(env.DB, chatId, { role: 'ai', content: geminiResponse });

        return new Response(JSON.stringify({ response: geminiResponse }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      return new Response(JSON.stringify({ error: 'Invalid action' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};

async function callGemini(apiKey, messages) {
  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }],
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
    throw new Error(data.error?.message || 'Gemini API error');
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'لا يوجد رد';
}

async function saveMessage(db, chatId, message) {
  await db.prepare(
    'INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).bind(chatId, message.role, message.content, new Date().toISOString()).run();
}

async function loadChat(db, chatId) {
  const result = await db.prepare(
    'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC'
  ).bind(chatId).all();

  return result.results || [];
}