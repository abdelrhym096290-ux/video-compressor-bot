// ============================================================
// src/providers.js — v8
// دعم streaming + تطبيع موحّد للرسائل + ترجمة الصور حسب المزوّد
// ============================================================
import { getModel } from './catalog.js';

export class ProviderError extends Error {
  constructor(provider, message, status = 502, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

// ============================================================
// ⭐ getProviderKind — يُعيد نوع المزوّد للتحويل الصحيح
// ============================================================
export function getProviderKind(modelId) {
  const m = getModel(modelId);
  if (!m) return 'openai';
  if (m.provider === 'gemini') return 'gemini';
  if (m.provider === 'workers-ai') return 'workers-ai';
  return 'openai'; // cerebras, openai-compatible, إلخ
}

// ============================================================
// ⭐ coerceToString — يضمن أن الناتج string
// ============================================================
function coerceToString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(p => p?.text || (typeof p === 'string' ? p : '')).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return coerceToString(value.content);
    if (value.response != null) return coerceToString(value.response);
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value);
}

// ============================================================
// ⭐ translateImagePart — تحويل صورة حسب المزوّد
// ============================================================
function translateImagePart(part, providerKind) {
  if (part.type !== 'image') return part;

  if (providerKind === 'gemini') {
    // Gemini: inline_data { mime_type, data (base64 بدون prefix) }
    const dataClean = String(part.data || '').replace(/^data:[^,]+,/, '');
    return {
      inline_data: {
        mime_type: part.mime || 'image/png',
        data: dataClean,
      },
    };
  }

  // OpenAI-compatible (Cerebras, OpenAI, وغيرها): image_url
  return {
    type: 'image_url',
    image_url: { url: part.data },
  };
}

// ============================================================
// ⭐ normalizeMessages — النقطة الوحيدة للتطبيع
// ⭐ يقبل providerKind لتطبيق التحويلات الصحيحة
// ============================================================
export function normalizeMessages(messages = [], providerKind = 'openai') {
  // هل توجد أي رسالة بـ content: array في المصفوفة؟
  const hasArrayContent = messages.some(m => m && Array.isArray(m.content));

  return messages
    .filter(Boolean)
    .map(m => {
      const role = m.role === 'model' ? 'assistant' : m.role;
      let content = m.content;

      if (hasArrayContent) {
        // ⭐ توحيد: كل الرسائل تصبح array
        if (typeof content === 'string') {
          content = [{ type: 'text', text: content }];
        } else if (!Array.isArray(content)) {
          content = [{ type: 'text', text: String(content || '') }];
        }

        // ترجمة كل part حسب المزوّد
        content = content.map(part => {
          if (part.type === 'image') return translateImagePart(part, providerKind);
          if (part.type === 'image_url') return part; // بالفعل محوّل
          if (part.type === 'text' || part.text) return { type: 'text', text: part.text || '' };
          return part;
        });
      } else {
        // ⭐ لا صور في المصفوفة → كلها string (الحالة الشائعة)
        if (typeof content !== 'string') {
          if (Array.isArray(content)) {
            content = content.map(p => p?.text || '').join('\n');
          } else {
            content = String(content || '');
          }
        }
      }

      return { role, content };
    })
    .filter(m => ['system', 'user', 'assistant', 'tool'].includes(m.role));
}

// ============================================================
// ⭐ toGeminiContents — تحويل خاص لـ Gemini
// ============================================================
function toGeminiContents(normalizedMessages) {
  const system = normalizedMessages.find(x => x.role === 'system')?.content;
  const contents = normalizedMessages
    .filter(x => x.role !== 'system')
    .map(x => {
      const role = x.role === 'assistant' ? 'model' : 'user';
      let parts;

      if (Array.isArray(x.content)) {
        parts = x.content.map(p => {
          if (p.type === 'image_url') {
            // نُعيد تحويلها إلى inline_data (قد تكون وصلت هكذا من normalize)
            const url = p.image_url?.url || '';
            const mimeMatch = url.match(/^data:([^;]+)/);
            const dataClean = url.split(',')[1] || url;
            return {
              inline_data: {
                mime_type: mimeMatch?.[1] || 'image/png',
                data: dataClean,
              },
            };
          }
          if (p.inline_data) return p;
          return { text: p.text || '' };
        });
      } else {
        parts = [{ text: String(x.content || '') }];
      }

      return { role, parts };
    });

  return { system, contents };
}

// ============================================================
// async readResponse
// ============================================================
async function readResponse(r, provider) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(
      provider,
      String(d?.error?.message || d?.error || d?.message || `${provider} HTTP ${r.status}`),
      r.status,
      r.status === 408 || r.status === 429 || r.status >= 500
    );
  }
  return d;
}

// ============================================================
// ============ Non-streaming ================================
// ============================================================

async function openAI({ key, endpoint, model, messages, provider, options = {} }) {
  if (!key) throw new ProviderError(provider, `${provider} API key غير موجود`, 401);
  const normalized = normalizeMessages(messages, 'openai');
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: normalized,
      temperature: options.temperature ?? .2,
      max_tokens: options.maxTokens ?? 4096,
    }),
  });
  const d = await readResponse(r, provider);
  const raw = d?.choices?.[0]?.message?.content ?? d?.choices?.[0]?.text ?? '';
  const text = coerceToString(raw);
  if (!text) throw new ProviderError(provider, 'استجابة المزود فارغة', 502, true);
  return { text, usage: d.usage || null, raw: d };
}

async function gemini({ key, model, messages, options = {} }) {
  if (!key) throw new ProviderError('gemini', 'GEMINI_API_KEY غير موجود', 401);
  const normalized = normalizeMessages(messages, 'gemini');
  const { system, contents } = toGeminiContents(normalized);

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: typeof system === 'string' ? system : coerceToString(system) }] } } : {}),
      generationConfig: {
        temperature: options.temperature ?? .2,
        maxOutputTokens: options.maxTokens ?? 4096,
      },
    }),
  });
  const d = await readResponse(r, 'gemini');
  const text = coerceToString((d?.candidates?.[0]?.content?.parts || []).map(x => x?.text || '').join(''));
  if (!text) throw new ProviderError('gemini', 'استجابة Gemini فارغة', 502, true);
  return { text, usage: d.usageMetadata || null, raw: d };
}

async function workers(env, model, messages, options = {}) {
  if (!env?.AI?.run) throw new ProviderError('workers-ai', 'ربط Workers AI غير موجود', 503);
  try {
    // ⭐ Workers AI النصي لا يدعم array — نحوّله دائماً لـ string
    const normalized = normalizeMessages(messages, 'workers-ai');
    const safeMessages = normalized.map(m => {
      if (Array.isArray(m.content)) {
        // ادمج كل النص، تجاهل الصور (Workers AI النصي لا يدعمها)
        const textOnly = m.content
          .map(p => p.text || (p.type === 'image' ? '[صورة — غير مدعومة من هذا النموذج]' : ''))
          .filter(Boolean)
          .join('\n');
        return { ...m, content: textOnly };
      }
      return m;
    });

    const d = await env.AI.run(model, {
      messages: safeMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? .2,
    });
    const raw = d?.response ?? d?.choices?.[0]?.message?.content ?? '';
    const text = coerceToString(raw);
    if (!text) throw new ProviderError('workers-ai', 'استجابة Workers AI فارغة', 502, true);
    return { text, usage: d.usage || null, raw: d };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('workers-ai', e.message || 'فشل Workers AI', 502, true);
  }
}

export async function callProvider(env, modelId, messages, options = {}) {
  const s = getModel(modelId);
  if (!s) throw new ProviderError('catalog', `نموذج غير معروف: ${modelId}`, 400);
  if (s.provider === 'cerebras') return openAI({ key: env.CEREBRAS_API_KEY, endpoint: 'https://api.cerebras.ai/v1/chat/completions', model: s.model, messages, provider: 'cerebras', options });
  if (s.provider === 'gemini') return gemini({ key: env.GEMINI_API_KEY, model: s.model, messages, options });
  if (s.provider === 'workers-ai') return workers(env, s.model, messages, options);
  throw new ProviderError(s.provider, 'مزود غير مدعوم', 400);
}

export async function routeCompletion(env, requestedModelId, messages, { fallbackModelId = 'cf-gpt-oss-20b', ...options } = {}) {
  const requested = getModel(requestedModelId);
  const start = Date.now();
  try {
    const r = await callProvider(env, requested.id, messages, options);
    return { ...r, requested, actual: requested, fallback: false, latencyMs: Date.now() - start };
  } catch (primary) {
    if (!fallbackModelId || fallbackModelId === requested.id || !primary.retryable) throw primary;
    const fallback = getModel(fallbackModelId);
    const r = await callProvider(env, fallback.id, messages, options);
    return { ...r, requested, actual: fallback, fallback: true, fallbackReason: primary.message, latencyMs: Date.now() - start };
  }
}

// ============================================================
// ============ Streaming Providers ==========================
// ============================================================

async function openAIStream({ key, endpoint, model, messages, provider, options = {} }) {
  if (!key) throw new ProviderError(provider, `${provider} API key غير موجود`, 401);
  const normalized = normalizeMessages(messages, 'openai');
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: normalized,
      temperature: options.temperature ?? .2,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new ProviderError(provider, d?.error?.message || `${provider} HTTP ${r.status}`, r.status, r.status >= 500);
  }
  if (!r.body) throw new ProviderError(provider, 'البث غير مدعوم', 502);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = r.body.getReader();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const obj = JSON.parse(payload);
                const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? '';
                if (delta) controller.enqueue(encoder.encode(delta));
              } catch {}
            }
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}

async function geminiStream({ key, model, messages, options = {} }) {
  if (!key) throw new ProviderError('gemini', 'GEMINI_API_KEY غير موجود', 401);
  const normalized = normalizeMessages(messages, 'gemini');
  const { system, contents } = toGeminiContents(normalized);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: typeof system === 'string' ? system : coerceToString(system) }] } } : {}),
      generationConfig: {
        temperature: options.temperature ?? .2,
        maxOutputTokens: options.maxTokens ?? 4096,
      },
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new ProviderError('gemini', d?.error?.message || `gemini HTTP ${r.status}`, r.status, r.status >= 500);
  }
  if (!r.body) throw new ProviderError('gemini', 'البث غير مدعوم', 502);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = r.body.getReader();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || !line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            try {
              const obj = JSON.parse(payload);
              const parts = obj?.candidates?.[0]?.content?.parts || [];
              const delta = parts.map(x => x?.text || '').join('');
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {}
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}

async function workersStream(env, model, messages, options = {}) {
  if (!env?.AI?.run) throw new ProviderError('workers-ai', 'ربط Workers AI غير موجود', 503);
  try {
    // ⭐ Workers AI النصي: تحويل array → string
    const normalized = normalizeMessages(messages, 'workers-ai');
    const safeMessages = normalized.map(m => {
      if (Array.isArray(m.content)) {
        const textOnly = m.content
          .map(p => p.text || (p.type === 'image' ? '[صورة — غير مدعومة من هذا النموذج]' : ''))
          .filter(Boolean)
          .join('\n');
        return { ...m, content: textOnly };
      }
      return m;
    });

    const aiStream = await env.AI.run(model, {
      messages: safeMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? .2,
      stream: true,
    });
    if (!aiStream) throw new ProviderError('workers-ai', 'البث غير مدعوم', 502);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = aiStream.getReader ? aiStream.getReader() : aiStream.body?.getReader();

    if (!reader) {
      const text = coerceToString(aiStream);
      return new ReadableStream({
        start(controller) {
          if (text) controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    }

    return new ReadableStream({
      async start(controller) {
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line || !line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const obj = JSON.parse(payload);
                const delta = obj?.response ?? obj?.choices?.[0]?.delta?.content ?? '';
                if (delta) controller.enqueue(encoder.encode(delta));
              } catch {}
            }
          }
        } catch (e) {
          controller.error(e);
          return;
        }
        controller.close();
      },
    });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('workers-ai', e.message || 'فشل البث', 502, true);
  }
}

export async function streamCompletion(env, requestedModelId, messages, { fallbackModelId = 'cf-gpt-oss-20b', ...options } = {}) {
  const requested = getModel(requestedModelId);
  let actual = requested;
  let fallback = false;
  let fallbackReason = null;
  let stream;

  try {
    if (requested.provider === 'cerebras') {
      stream = await openAIStream({
        key: env.CEREBRAS_API_KEY,
        endpoint: 'https://api.cerebras.ai/v1/chat/completions',
        model: requested.model,
        messages, provider: 'cerebras', options,
      });
    } else if (requested.provider === 'gemini') {
      stream = await geminiStream({
        key: env.GEMINI_API_KEY,
        model: requested.model,
        messages, options,
      });
    } else if (requested.provider === 'workers-ai') {
      stream = await workersStream(env, requested.model, messages, options);
    } else {
      throw new ProviderError(requested.provider, 'مزود غير مدعوم', 400);
    }
  } catch (primary) {
    if (!fallbackModelId || fallbackModelId === requested.id || !primary.retryable) {
      const r = await routeCompletion(env, requested.id, messages, options);
      stream = textToStream(r.text);
      return { stream, requested, actual: r.actual, fallback: r.fallback, fallbackReason: r.fallbackReason, latencyMs: 0 };
    }
    actual = getModel(fallbackModelId);
    fallback = true;
    fallbackReason = primary.message;
    try {
      if (actual.provider === 'workers-ai') {
        stream = await workersStream(env, actual.model, messages, options);
      } else if (actual.provider === 'cerebras') {
        stream = await openAIStream({
          key: env.CEREBRAS_API_KEY,
          endpoint: 'https://api.cerebras.ai/v1/chat/completions',
          model: actual.model,
          messages, provider: 'cerebras', options,
        });
      } else if (actual.provider === 'gemini') {
        stream = await geminiStream({
          key: env.GEMINI_API_KEY,
          model: actual.model,
          messages, options,
        });
      } else {
        throw new Error('fallback provider غير مدعوم');
      }
    } catch (fb) {
      const r = await routeCompletion(env, actual.id, messages, options);
      stream = textToStream(r.text);
      return { stream, requested, actual: r.actual, fallback: true, fallbackReason: fallbackReason + ' | ' + fb.message, latencyMs: 0 };
    }
  }

  return { stream, requested, actual, fallback, fallbackReason, latencyMs: 0 };
}

function textToStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const words = String(text || '').split(/(\s+)/);
      let i = 0;
      const pushNext = () => {
        if (i >= words.length) { controller.close(); return; }
        const chunk = words[i++];
        if (chunk) controller.enqueue(encoder.encode(chunk));
        setTimeout(pushNext, 20);
      };
      pushNext();
    },
  });
}