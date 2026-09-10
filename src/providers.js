// ============================================================
// src/providers.js — v7.1
// دعم streaming حقيقي + fallback آمن
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

export function normalizeMessages(messages = []) {
  return messages.filter(Boolean).map(m => ({
    role: m.role === 'model' ? 'assistant' : m.role,
    content: typeof m.content === 'string' || Array.isArray(m.content) ? m.content : JSON.stringify(m.content),
  })).filter(m => ['system','user','assistant','tool'].includes(m.role));
}

// ⭐ ضمان أن الناتج string دائماً (يحل r.text.match is not a function)
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
// ============ Non-streaming (fallback) =====================
// ============================================================

async function openAI({ key, endpoint, model, messages, provider, options = {} }) {
  if (!key) throw new ProviderError(provider, `${provider} API key غير موجود في أسرار العامل`, 401);
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: normalizeMessages(messages),
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
  const n = normalizeMessages(messages);
  const system = n.find(x => x.role === 'system')?.content;
  const contents = n.filter(x => x.role !== 'system').map(x => ({
    role: x.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(x.content)
      ? x.content.map(p => p.type === 'image_url'
          ? { inline_data: { mime_type: p.image_url.url.match(/^data:([^;]+)/)?.[1] || 'image/png', data: p.image_url.url.split(',')[1] || '' } }
          : { text: p.text || '' })
      : [{ text: x.content }],
  }));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature: options.temperature ?? .2, maxOutputTokens: options.maxTokens ?? 4096 },
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
    const d = await env.AI.run(model, {
      messages: normalizeMessages(messages),
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

/**
 * بث OpenAI-compatible (Cerebras)
 * يُعيد ReadableStream chunks من النص فقط
 */
async function openAIStream({ key, endpoint, model, messages, provider, options = {} }) {
  if (!key) throw new ProviderError(provider, `${provider} API key غير موجود`, 401);
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: normalizeMessages(messages),
      temperature: options.temperature ?? .2,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new ProviderError(provider, d?.error?.message || `${provider} HTTP ${r.status}`, r.status, r.status >= 500);
  }
  if (!r.body) throw new ProviderError(provider, 'البث غير مدعوم من هذا المزود', 502);

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
              } catch { /* تجاهل */ }
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

/**
 * بث Gemini
 */
async function geminiStream({ key, model, messages, options = {} }) {
  if (!key) throw new ProviderError('gemini', 'GEMINI_API_KEY غير موجود', 401);
  const n = normalizeMessages(messages);
  const system = n.find(x => x.role === 'system')?.content;
  const contents = n.filter(x => x.role !== 'system').map(x => ({
    role: x.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(x.content)
      ? x.content.map(p => p.type === 'image_url'
          ? { inline_data: { mime_type: p.image_url.url.match(/^data:([^;]+)/)?.[1] || 'image/png', data: p.image_url.url.split(',')[1] || '' } }
          : { text: p.text || '' })
      : [{ text: x.content }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature: options.temperature ?? .2, maxOutputTokens: options.maxTokens ?? 4096 },
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
            } catch { /* تجاهل */ }
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

/**
 * بث Workers AI
 */
async function workersStream(env, model, messages, options = {}) {
  if (!env?.AI?.run) throw new ProviderError('workers-ai', 'ربط Workers AI غير موجود', 503);
  try {
    const aiStream = await env.AI.run(model, {
      messages: normalizeMessages(messages),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? .2,
      stream: true,
    });
    if (!aiStream) throw new ProviderError('workers-ai', 'البث غير مدعوم', 502);

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = aiStream.getReader ? aiStream.getReader() : aiStream.body?.getReader();

    if (!reader) {
      // بعض النماذج تُعيد stream بشكل مختلف
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
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            // SSE-style data:
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
              } catch { /* تجاهل */ }
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

/**
 * ⭐ الدالة الرئيسية للـ streaming
 * @returns { stream: ReadableStream, actual: Model, fallback: boolean, requested: Model }
 */
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
    // fallback
    if (!fallbackModelId || fallbackModelId === requested.id || !primary.retryable) {
      // لا fallback متاح — نُحوّل إلى non-streaming
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
      // fallback فشل أيضاً — آخر محاولة: non-streaming
      const r = await routeCompletion(env, actual.id, messages, options);
      stream = textToStream(r.text);
      return { stream, requested, actual: r.actual, fallback: true, fallbackReason: fallbackReason + ' | ' + fb.message, latencyMs: 0 };
    }
  }

  return { stream, requested, actual, fallback, fallbackReason, latencyMs: 0 };
}

// يحوّل نصاً كاملاً إلى ReadableStream (يُستخدم في fallback)
function textToStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // نقسّمه لأجزاء صغيرة لتقليد البث
      const words = String(text || '').split(/(\s+)/);
      let i = 0;
      const pushNext = () => {
        if (i >= words.length) { controller.close(); return; }
        const chunk = words[i++];
        if (chunk) controller.enqueue(encoder.encode(chunk));
        // تأخير بسيط
        setTimeout(pushNext, 20);
      };
      pushNext();
    },
  });
}