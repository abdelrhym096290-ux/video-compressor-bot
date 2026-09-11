// ============================================================
// src/media.js — v2
// إدارة الوسائط + توحيد التنسيق (قرار ذكي)
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

// ⭐ استخراج نصوص الملفات (للدمج في string)
export function extractTextParts(files = [], modelId) {
  const caps = modelCapabilities(modelId);
  const valid = validateAttachments(files);
  const texts = [], images = [], unsupported = [];

  for (const f of valid) {
    if (f.mime.startsWith('image/')) {
      if (!caps.images || !f.data) unsupported.push(f.name);
      else images.push({ type: 'image_url', image_url: { url: f.data } });
    } else if (f.text != null) {
      texts.push(`\n---\n[📎 محتوى الملف: ${f.name}]\n${String(f.text).slice(0, MEDIA_LIMITS.maxTextChars)}\n---\n`);
    } else {
      texts.push(`\n---\n[📎 ملف مرفق: ${f.name} — ${f.mime} — لا يمكن قراءته مباشرة]\n---\n`);
    }
  }
  return { texts, images, unsupported };
}

// ⭐ النسخة القديمة (تُستخدم في حالات خاصة)
export function attachmentParts(files = [], modelId) {
  const { texts, images, unsupported } = extractTextParts(files, modelId);
  const parts = [];
  for (const t of texts) parts.push({ type: 'text', text: t });
  for (const img of images) parts.push(img);
  return { parts, unsupported };
}

// ============================================================
// ⭐ multimodalMessages — v2
// قرار ذكي:
//   - لا صور → كل الرسائل string (بسيط + متوافق)
//   - توجد صور → كل الرسائل array (يفتح Vision)
// ============================================================
export function multimodalMessages(messages, files, modelId) {
  // 1) لا مرفقات → لا تغيير
  if (!files?.length) return { messages, unsupported: [] };

  const { texts, images, unsupported } = extractTextParts(files, modelId);
  const hasImages = images.length > 0;

  // 2) استخراج النص من المرفقات (يُدمج في الرسالة الأخيرة)
  const attachText = texts.join('\n');
  const lastIdx = messages.length - 1;
  if (lastIdx < 0) return { messages: messages.slice(), unsupported };

  // 3) نسخة معدّلة
  const copy = messages.map(x => ({ ...x }));

  if (!hasImages) {
    // ✅ المسار البسيط: string فقط
    // - الرسائل القديمة: كما هي (string)
    // - الرسالة الأخيرة: نصها + المرفقات
    const lastContent = copy[lastIdx].content;
    const baseText = typeof lastContent === 'string' ? lastContent : String(lastContent || '');
    copy[lastIdx] = {
      ...copy[lastIdx],
      content: baseText + attachText,
    };
    return { messages: copy, unsupported };
  }

  // ✅ المسار المتقدم: array (يحتوي صور)
  // - كل الرسائل → array
  // - الرسالة الأخيرة: نصها + نصوص المرفقات + الصور
  const arrayCopy = copy.map(x => {
    if (typeof x.content === 'string') {
      return { ...x, content: [{ type: 'text', text: x.content || '' }] };
    }
    if (Array.isArray(x.content)) {
      return { ...x, content: x.content.slice() };
    }
    return { ...x, content: [{ type: 'text', text: String(x.content || '') }] };
  });

  const lastMsg = arrayCopy[lastIdx];
  const baseTextParts = lastMsg.content.filter(p => p.type === 'text');
  const otherParts = lastMsg.content.filter(p => p.type !== 'text');

  arrayCopy[lastIdx] = {
    ...lastMsg,
    content: [
      ...baseTextParts,
      ...(attachText ? [{ type: 'text', text: attachText }] : []),
      ...otherParts,
      ...images,
    ],
  };

  return { messages: arrayCopy, unsupported };
}

// ⭐ دالة مساعدة: هل الرسالة الأخيرة تحتوي صور؟
export function hasImages(files = []) {
  return Array.isArray(files) && files.some(f => String(f.mime || f.type || '').startsWith('image/'));
}