// ============================================================
// src/media.js
// إدارة الوسائط + توحيد تنسيق الرسائل
// ============================================================
import { getModel } from './catalog.js';

export const MEDIA_LIMITS = Object.freeze({
  maxFiles: 12,
  maxBytesPerFile: 60 * 1024 * 1024,
  maxTextChars: 200000,
  maxImageBytes: 12 * 1024 * 1024,
});

export function modelCapabilities(modelId) {
  const m = getModel(modelId);
  return {
    vision: m.kind === 'vision',
    text: true,
    files: true,
    images: m.kind === 'vision',
    formats: m.kind === 'vision'
      ? ['png', 'jpg', 'jpeg', 'webp']
      : ['txt', 'md', 'json', 'csv', 'js', 'py', 'html', 'css'],
  };
}

export function validateAttachments(files = []) {
  if (!Array.isArray(files) || files.length > MEDIA_LIMITS.maxFiles) {
    throw new Error(`الحد الأقصى ${MEDIA_LIMITS.maxFiles} ملفات`);
  }
  return files.map(f => {
    const name = String(f.name || 'file').slice(0, 180);
    const mime = String(f.mime || f.type || 'application/octet-stream');
    const size = Number(f.size || 0);
    if (size > MEDIA_LIMITS.maxBytesPerFile) {
      throw new Error(`الملف كبير جدًا: ${name}`);
    }
    return { name, mime, size, data: f.data || null, text: f.text || null };
  });
}

export function attachmentParts(files = [], modelId) {
  const caps = modelCapabilities(modelId);
  const valid = validateAttachments(files);
  const parts = [], unsupported = [];

  for (const f of valid) {
    if (f.mime.startsWith('image/')) {
      if (!caps.images || !f.data) unsupported.push(f.name);
      else parts.push({ type: 'image_url', image_url: { url: f.data } });
    } else if (f.text != null) {
      parts.push({
        type: 'text',
        text: `\n[محتوى الملف: ${f.name}]\n${String(f.text).slice(0, MEDIA_LIMITS.maxTextChars)}`,
      });
    } else {
      parts.push({
        type: 'text',
        text: `[ملف مرفق غير قابل للقراءة المباشرة: ${f.name}]`,
      });
    }
  }
  return { parts, unsupported };
}

// ⭐ نسخة موحّدة: كل الرسائل content: array عند وجود مرفقات
export function multimodalMessages(messages, files, modelId) {
  // إن لم يكن هناك مرفقات → اترك الرسائل كما هي (string)
  if (!files?.length) return { messages, unsupported: [] };

  const { parts, unsupported } = attachmentParts(files, modelId);

  // حوّل كل رسالة إلى content: array[text]
  const copy = messages.map(x => {
    if (typeof x.content === 'string') {
      return { ...x, content: [{ type: 'text', text: x.content || '' }] };
    }
    if (Array.isArray(x.content)) {
      return { ...x, content: x.content };
    }
    return { ...x, content: [{ type: 'text', text: String(x.content || '') }] };
  });

  const last = copy.length - 1;
  if (last < 0) return { messages: copy, unsupported };

  // الرسالة الأخيرة: نصها الأصلي + المرفقات
  const baseText = copy[last].content.find(p => p.type === 'text')?.text || '';
  const otherParts = copy[last].content.filter(p => p.type !== 'text');

  copy[last] = {
    ...copy[last],
    content: [{ type: 'text', text: baseText }, ...otherParts, ...parts],
  };

  return { messages: copy, unsupported };
}