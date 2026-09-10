// ============================================================
// src/catalog.js
// كتالوج النماذج + دوال الاختيار والتوجيه التلقائي
// ============================================================

export const MODEL_CATALOG = Object.freeze([
  // ============ Cerebras (غير مفعل - Payment required) ============
  ['cerebras-gemma-4-31b','gemma-4-31b','Gemma 4 31B','Cerebras','cerebras','استدلال سريع','chat'],
  ['cerebras-qwen-3.8-27b','qwen-3.8-27b','Qwen 3.8 27B','Cerebras','cerebras','برمجة وتحليل سريع','chat'],
  ['cerebras-gpt-oss-120b','gpt-oss-120b','GPT-OSS 120B','Cerebras','cerebras','مهام معقدة','chat'],

  // ============ Google Gemini (الأسماء الصحيحة المتاحة) ============
  ['gemini-5-flash-lite','gemini-3.5-flash','Flash 3.5','Google','gemini','محادثة عامة','chat'],
  ['gemini-5-flash','gemini-3.6-flash','Flash 3.6','Google','gemini','الافتراضي','chat'],
  ['gemini-6-flash','gemini-3.7-flash','Flash 3.7','Google','gemini','تحليل متقدم','chat'],
  ['gemini-7-flash','gemini-3.8-flash','Flash 3.8','Google','gemini','الأحدث','chat'],

  // ============ Cloudflare Workers AI (تعمل) ============
  ['cf-glm-flash','@cf/zai-org/glm-4.7-flash','GLM 4.7 Flash','Cloudflare','workers-ai','ردود سريعة','chat'],
  ['cf-qwen3-coder','@cf/qwen/qwen2.5-coder-32b-instruct','Qwen Coder','Cloudflare','workers-ai','برمجة','chat'],
  ['cf-coder','@cf/qwen/qwen2.5-coder-32b-instruct','Qwen Coder','Cloudflare','workers-ai','كود وتصحيح','chat'],
  ['cf-qwen3','@cf/qwen/qwen3-30b-a3b-fp8','Qwen 3','Cloudflare','workers-ai','محادثة وتحليل','chat'],
  ['cf-gpt-oss-20b','@cf/openai/gpt-oss-20b','GPT-OSS 20B','Cloudflare','workers-ai','اقتصادي','chat'],
  ['cf-gemma-4','@cf/google/gemma-4-26b-a4b-it','Gemma 4','Cloudflare','workers-ai','عام','chat'],
  ['cf-nemotron','@cf/nvidia/nemotron-3-120b-a12b','Nemotron','Cloudflare','workers-ai','تحليل','chat'],
  ['cf-gpt-oss-120b','@cf/openai/gpt-oss-120b','GPT-OSS 120B','Cloudflare','workers-ai','مهام كبيرة','chat'],
  ['cf-deepseek-r1','@cf/deepseek-ai/deepseek-r1-distill-qwen-32b','DeepSeek R1','Cloudflare','workers-ai','استدلال','chat'],
  ['cf-qwq','@cf/qwen/qwq-32b','QwQ','Cloudflare','workers-ai','تفكير','chat'],
  ['cf-llama-4','@cf/meta/llama-4-scout-17b-16e-instruct','Llama 4','Cloudflare','workers-ai','عام','chat'],
  ['cf-mistral','@cf/mistralai/mistral-small-3.1-24b-instruct','Mistral','Cloudflare','workers-ai','كتابة','chat'],
  ['cf-llama-70b','@cf/meta/llama-3.3-70b-instruct-fp8-fast','Llama 70B','Cloudflare','workers-ai','قوي','chat'],
  ['cf-llama-vision','@cf/meta/llama-3.2-11b-vision-instruct','Llama Vision','Cloudflare','workers-ai','تحليل الصور','vision'],
  ['cf-granite','@cf/ibm-granite/granite-4.0-h-micro','Granite','Cloudflare','workers-ai','استخراج وتحليل','chat']
].map(([id,model,name,company,provider,description,kind]) => Object.freeze({id,model,name,company,provider,description,kind})));

// ============================================================
// getModel: جلب نموذج بواسطة المعرّف (أو الأول افتراضياً)
// ============================================================
export function getModel(id) {
  return MODEL_CATALOG.find(x => x.id === id) || MODEL_CATALOG[0];
}

// ============================================================
// publicCatalog: نسخة آمنة للنشر (بدون تفاصيل داخلية)
// ============================================================
export function publicCatalog() {
  return MODEL_CATALOG.map(({id,name,company,provider,description,kind}) => ({
    id, name, company, provider, description, kind,
    supportsImages: kind === 'vision',
    supportsFiles: true
  }));
}

// ============================================================
// chooseModel: اختيار سريع (منطق ثابت قديم)
// ============================================================
export function chooseModel(text = '') {
  const t = String(text).toLowerCase();
  if (/code|كود|برمج|terminal|طرفية|debug|تصحيح/.test(t)) return getModel('cf-qwen3-coder');
  if (/image|صورة|vision|صوّر/.test(t)) return getModel('cf-llama-vision');
  if (/plan|خطة|بحث|research|تحليل/.test(t)) return getModel('cf-gpt-oss-120b');
  return getModel('cf-gpt-oss-20b');
}

// ============================================================
// scoreDifficulty: تقدير صعوبة السؤال (0 = سهل، 1 = صعب)
// ============================================================
export function scoreDifficulty(text = '') {
  const raw = String(text);
  const t = raw.toLowerCase().trim();

  // أسئلة قصيرة جداً = سهلة
  if (t.length < 15) return 0.1;

  let score = 0;

  // الطول: كل 1000 حرف يضيف صعوبة (بحد أقصى 0.3)
  score += Math.min(t.length / 1000, 0.3);

  // كلمات تدل على التعقيد
  if (/code|كود|برمج|debug|تصحيح|خوارزم|algorithm/.test(t)) score += 0.25;
  if (/math|رياض|معادلة|equation|احسب|calculate|integral|تفاضل/.test(t)) score += 0.25;
  if (/explain|اشرح|لماذا|why|حلل|analyze|قارن|compare/.test(t)) score += 0.15;
  if (/plan|خطة|استراتيج|strategy|تصميم|design/.test(t)) score += 0.15;
  if (/reason|استدلال|منطق|logic|استنتج|infer/.test(t)) score += 0.2;

  // أسئلة متعددة الخطوات
  const questionMarks = (t.match(/[?؟]/g) || []).length;
  if (questionMarks > 2) score += 0.1;

  // وجود قوائم أو خطوات
  if (/\n\d+[\.\)]|-\s|\*\s/.test(raw)) score += 0.05;

  return Math.min(score, 1);
}

// ============================================================
// routeAuto: اختيار النموذج تلقائياً حسب نوع السؤال وصعوبته
// ============================================================
export function routeAuto(text = '') {
  const t = String(text).toLowerCase();

  // 1) أولوية للمهام المتخصصة (كود / صور)
  if (/code|كود|برمج|debug|تصحيح|terminal|طرفية/.test(t)) {
    return getModel('cf-qwen3-coder');
  }
  if (/image|صورة|vision|صوّر|رسم/.test(t)) {
    return getModel('cf-llama-vision');
  }

  // 2) حسب درجة الصعوبة
  const d = scoreDifficulty(text);

  if (d < 0.3) {
    // سهل → نموذج اقتصادي وسريع
    return getModel('cf-gpt-oss-20b');
  }
  if (d < 0.65) {
    // متوسط → نموذج متوازن
    return getModel('cf-qwen3');
  }
  // صعب → نموذج قوي
  return getModel('cf-gpt-oss-120b');
}