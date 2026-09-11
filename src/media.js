// ============================================================
// src/media.js — v3
// فصل المرفقات: نص → string، صور → array فقط عند الدعم
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
    formats: m.kind === 'vision' ? ['png', 'jpg', 'jpeg', 'webp'] : [],
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

/**
 * يفصل المرفقات إلى:
 *  - textBlock: نص يُدمج مباشرة في رسالة المستخدم (يعمل مع كل المزوّدين)
 *  - images: صور تحتاج معالجة خاصة (فقط إن كان النموذج يدعم vision)
 *  - unsupported: أسماء الملفات المرفوضة
 */
export function splitAttachments(files, modelId) {
  const caps = modelCapabilities(modelId);
  const valid = validateAttachments(files);

  let textBlock = '';
  const images = [];
  const unsupported = [];

  for (const f of valid) {
    if (f.mime.startsWith('image/')) {
      if (caps.vision && f.data) {
        images.push({ name: f.name, mime: f.mime, data: f.data });
      } else {
        unsupported.push(f.name);
      }
    } else if (f.text != null) {
      // ملف نصي → دمج مباشر
      textBlock += `\n\n[محتوى الملف المرفق: ${f.name}]\n${String(f.text).slice(0, MEDIA_LIMITS.maxTextChars)}\n[نهاية الملف: ${f.name}]`;
    } else if (f.data) {
      // ملف ثنائي (PDF, DOCX, ZIP...) — إشارة فقط
      const sizeKB = Math.round((f.size || 0) / 1024);
      textBlock += `\n\n[مرفق ثنائي: ${f.name} — ${f.mime} — ${sizeKB}KB — لا يمكن قراءته مباشرة كـ نص]`;
    } else {
      textBlock += `\n\n[مرفق: ${f.name} — ${f.mime}]`;
    }
  }
  return { textBlock, images, unsupported };
}

/**
 * يبني رسالة المستخدم الأخيرة.
 *  - لا صور → content: string (الحالة الشائعة، متوافقة مع كل المزوّدين)
 *  - مع صور → content: array (يُترجم لاحقاً حسب المزوّد)
 */
export function buildUserMessage(baseText, files, modelId) {
  if (!files?.length) {
    return { role: 'user', content: baseText || '', unsupported: [] };
  }

  const { textBlock, images, unsupported } = splitAttachments(files, modelId);

  // نص نهائي: إما النص الأصلي + المرفقات، أو رسالة افتراضية
  const finalText = (baseText && baseText.trim()) || (files.length ? 'انظر المرفقات.' : '');
  const fullText = finalText + textBlock;

  // لا صور → string (الحالة الشائعة)
  if (!images.length) {
    return { role: 'user', content: fullText, unsupported };
  }

  // صور موجودة → array بصيغة عامة موحّدة
  return {
    role: 'user',
    content: [
      { type: 'text', text: fullText },
      ...images.map(img => ({
        type: 'image',
        mime: img.mime,
        data: img.data,
        name: img.name,
      })),
    ],
    unsupported,
  };
}