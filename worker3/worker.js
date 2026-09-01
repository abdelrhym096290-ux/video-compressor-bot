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

        const geminiResult = await callGeminiWithTools(env.GEMINI_API_KEY, allMessages);

        if (geminiResult.toolCall) {
          const command = geminiResult.toolCall.command;
          
          const githubResult = await runGithubWorkflow(env.GITHUB_TOKEN, 'abdelrhym096290-ux/video-compressor-bot', command);
          
          const finalResponse = await callGeminiFinal(env.GEMINI_API_KEY, allMessages, githubResult);
          
          await saveMessage(env.DB, chatId, { role: 'user', content: messages[messages.length - 1].content });
          await saveMessage(env.DB, chatId, { role: 'ai', content: finalResponse });
          
          return new Response(JSON.stringify({ response: finalResponse }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        await saveMessage(env.DB, chatId, { role: 'user', content: messages[messages.length - 1].content });
        await saveMessage(env.DB, chatId, { role: 'ai', content: geminiResult.text });

        return new Response(JSON.stringify({ response: geminiResult.text }), {
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

async function callGeminiWithTools(apiKey, messages) {
  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }],
  }));

  const tools = [{
    functionDeclarations: [{
      name: 'run_command',
      description: 'تشغيل أمر في بيئة طرفية عبر GitHub Actions',
      parameters: {
        type: 'OBJECT',
        properties: {
          command: {
            type: 'STRING',
            description: 'الأمر الذي سيُنفذ في البيئة الطرفية'
          }
        },
        required: ['command']
      }
    }]
  }];

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({ contents, tools }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Gemini API error');
  }

  const parts = data.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part.functionCall) {
      return {
        toolCall: {
          command: part.functionCall.args?.command || ''
        }
      };
    }
  }

  const text = parts.find(p => p.text)?.text || 'لا يوجد رد';
  return { text };
}

async function callGeminiFinal(apiKey, messages, githubResult) {
  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }],
  }));

  contents.push({
    role: 'model',
    parts: [{ text: `نتيجة التنفيذ:\n${githubResult}` }]
  });

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

  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'تم التنفيذ';
}

async function runGithubWorkflow(token, repo, command) {
  const [owner, name] = repo.split('/');
  
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/actions/workflows/compress1.yml/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        command: command
      }
    }),
  });

  if (!response.ok) {
    throw new Error('فشل تشغيل GitHub Actions');
  }

  return 'تم إرسال الأمر إلى GitHub Actions وسيتم التنفيذ.';
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