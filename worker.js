export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const BOT_TOKEN = env.BOT_TOKEN;
    const GITHUB_TOKEN = env.GITHUB_TOKEN;
    const BOT_PASSWORD = env.BOT_PASSWORD;
    const GITHUB_REPO = "abdelrhym096290-ux/video-compressor-bot";
    const GITHUB_WORKFLOW = "compress.yml";
    const RESOLUTIONS = ["240", "360", "480", "720", "1080"];

    try {
      const update = await request.json();

      // ===== استقبال فيديو أو ملف فيديو مباشرة =====
      if (update.message && (update.message.video || (update.message.document && (update.message.document.mime_type || "").startsWith("video/")))) {
        const chatId = update.message.chat.id;

        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);
        if (!isAuthorized) {
          await sendMessage(BOT_TOKEN, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
          return ok();
        }

        const defaultName = extractDefaultName(update.message);
        const preset = await getPreset(env, chatId);

        if (preset && preset.active) {
          // ===== وضع الإعداد المسبق: رفع فوري بلا أسئلة =====
          // استخدام اسم الحلقة التلقائي إن وُجد
          let filename = defaultName || undefined;
          if (preset.next_episode !== undefined && preset.next_episode !== null) {
            const prefix = preset.episode_prefix || "";
            filename = `${prefix}${preset.next_episode}`;
            // زيادة العداد وتحديث الإعداد
            preset.next_episode++;
            await setPreset(env, chatId, preset);
          }
          const autoSession = {
            message_id: update.message.message_id,
            resolution: preset.resolution,
            content_type: preset.content_type,
            isPrivate: preset.isPrivate,
            password: preset.password,
            filename: filename,
          };
          await sendMessage(BOT_TOKEN, chatId, `📤 جاري الإرسال تلقائيًا${filename ? `: ${filename}` : ""}...`);
          await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, autoSession);
          return ok();
        }

        const newSession = { message_id: update.message.message_id };
        if (defaultName) newSession.filename = defaultName;

        await setSession(env, chatId, newSession);
        await sendQualityKeyboard(BOT_TOKEN, chatId, RESOLUTIONS);
        return ok();
      }

      // ===== الرسائل النصية =====
      if (update.message && update.message.text !== undefined) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();

        // ===== فحص التصريح بالدخول (كلمة السر) =====
        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);
        if (!isAuthorized) {
          if (text === BOT_PASSWORD) {
            await env.SESSIONS.put(`authorized:${chatId}`, "true");
            await sendMessage(BOT_TOKEN, chatId, "✅ تم التحقق بنجاح! أرسل /start للبدء.");
          } else {
            await sendMessage(BOT_TOKEN, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
          }
          return ok();
        }

        const session = (await getSession(env, chatId)) || {};

        if (text === "/start") {
          const preset = await getPreset(env, chatId);
          await sendMessage(BOT_TOKEN, chatId, startMessage(preset));
          return ok();
        }

        if (text === "/setup" || text === "/settings") {
          await setSession(env, chatId, { configuring_preset: true });
          await sendQualityKeyboard(BOT_TOKEN, chatId, RESOLUTIONS);
          return ok();
        }

        if (text === "/preset") {
          const preset = await getPreset(env, chatId);
          await sendMessage(BOT_TOKEN, chatId, presetStatusText(preset));
          return ok();
        }

        if (text === "/auto_off") {
          const preset = await getPreset(env, chatId);
          if (preset) {
            preset.active = false;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, "⏸️ تم إيقاف الوضع التلقائي. أرسل فيديو/رابط وستُسأل عن الإعدادات كالمعتاد.");
          } else {
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ أصلاً.");
          }
          return ok();
        }

        if (text === "/auto_on") {
          const preset = await getPreset(env, chatId);
          if (preset) {
            preset.active = true;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, `▶️ تم تفعيل الوضع التلقائي.\n${presetStatusText(preset)}`);
          } else {
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ بعد. استخدم /setup لإنشاء واحد.");
          }
          return ok();
        }

        // ===== أمر تعيين رقم الحلقة التالي =====
        if (text.startsWith("/setepisode")) {
          const parts = text.split(" ");
          if (parts.length === 2 && /^\d+$/.test(parts[1])) {
            const num = parseInt(parts[1], 10);
            const preset = (await getPreset(env, chatId)) || {};
            preset.next_episode = num;
            if (!preset.resolution) {
              await sendMessage(BOT_TOKEN, chatId, "⚠️ لا يوجد إعداد مسبق محفوظ. سيتم حفظ رقم الحلقة لكنك تحتاج لعمل /setup أولاً لبقية الإعدادات.");
            }
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, `✅ تم تعيين رقم الحلقة التالية إلى: ${num}`);
          } else {
            await sendMessage(BOT_TOKEN, chatId, "❌ استخدم الصيغة: /setepisode <رقم>\nمثال: /setepisode 1");
          }
          return ok();
        }

        // ===== أمر تعيين بادئة الحلقة =====
        if (text.startsWith("/setprefix")) {
          const prefix = text.substring("/setprefix".length).trimStart();
          if (!prefix) {
            await sendMessage(BOT_TOKEN, chatId, "❌ أرسل نص البادئة بعد الأمر.\nمثال: /setprefix حلقة ");
            return ok();
          }
          const preset = (await getPreset(env, chatId)) || {};
          preset.episode_prefix = prefix;
          if (!preset.resolution) {
            await sendMessage(BOT_TOKEN, chatId, "⚠️ لا يوجد إعداد مسبق محفوظ. سيتم حفظ البادئة لكنك تحتاج لعمل /setup أولاً.");
          }
          await setPreset(env, chatId, preset);
          await sendMessage(BOT_TOKEN, chatId, `✅ تم تعيين بادئة الحلقة: "${prefix}"`);
          return ok();
        }

        // ===== أمر إيقاف التسمية التلقائية =====
        if (text === "/stopepisode") {
          const preset = await getPreset(env, chatId);
          if (preset) {
            delete preset.next_episode;
            delete preset.episode_prefix;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, "🛑 تم إلغاء التسمية التلقائية للحلقات.");
          } else {
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ.");
          }
          return ok();
        }

        if (session.awaiting_res) {
          if (/^\d+$/.test(text)) {
            session.resolution = text;
            session.awaiting_res = false;
            await setSession(env, chatId, session);
            await sendMessage(BOT_TOKEN, chatId, `🎯 ${text}p`);
            await sendContentTypeKeyboard(BOT_TOKEN, chatId);
          } else {
            await sendMessage(BOT_TOKEN, chatId, "❌ أرسل رقماً صحيحاً (مثلاً 550):");
          }
          return ok();
        }

        if (session.awaiting_password) {
          if (text.length < 4) {
            await sendMessage(BOT_TOKEN, chatId, "❌ كلمة المرور قصيرة جداً. أرسل كلمة مرور من 4 أحرف على الأقل:");
          } else {
            session.password = text;
            session.awaiting_password = false;
            if (session.configuring_preset) {
              await savePresetAndConfirm(env, BOT_TOKEN, chatId, session);
            } else {
              session.awaiting_filename = true;
              await setSession(env, chatId, session);
              await sendMessage(BOT_TOKEN, chatId, "🔑 تم حفظ كلمة المرور.");
              await promptFilename(BOT_TOKEN, chatId, null, session.filename, false);
            }
          }
          return ok();
        }

        if (session.awaiting_filename) {
          session.filename = text;
          session.awaiting_filename = false;
          await setSession(env, chatId, session);
          await sendMessage(BOT_TOKEN, chatId, `✅ تم تعيين اسم الملف: ${text}`);
          await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, session);
          return ok();
        }

        if (/^https?:\/\//.test(text)) {
          const preset = await getPreset(env, chatId);
          if (preset && preset.active) {
            let filename = undefined;
            if (preset.next_episode !== undefined && preset.next_episode !== null) {
              const prefix = preset.episode_prefix || "";
              filename = `${prefix}${preset.next_episode}`;
              preset.next_episode++;
              await setPreset(env, chatId, preset);
            }
            const autoSession = {
              url: text,
              resolution: preset.resolution,
              content_type: preset.content_type,
              isPrivate: preset.isPrivate,
              password: preset.password,
              filename: filename,
            };
            await sendMessage(BOT_TOKEN, chatId, "📤 جاري الإرسال تلقائيًا...");
            await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, autoSession);
            return ok();
          }
          const newSession = { url: text };
          await setSession(env, chatId, newSession);
          await sendQualityKeyboard(BOT_TOKEN, chatId, RESOLUTIONS);
          return ok();
        }

        await sendMessage(BOT_TOKEN, chatId, "❌ أرسل فيديو مباشرة، أو رابط فيديو صحيح.");
        return ok();
      }

      // ===== ضغطات الأزرار =====
      if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data;
        await answerCallback(BOT_TOKEN, query.id);

        // ===== فحص التصريح بالدخول أيضاً على الأزرار =====
        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);
        if (!isAuthorized) {
          await sendMessage(BOT_TOKEN, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
          return ok();
        }

        const session = (await getSession(env, chatId)) || {};

        if (data === "cancel") {
          await deleteSession(env, chatId);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🚫 تم الإلغاء.");
          return ok();
        }

        if (data === "custom_res") {
          session.awaiting_res = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "✏️ أرسل الجودة (رقم فقط، مثلاً 550):");
          return ok();
        }

        if (data.startsWith("res_")) {
          const res = data.split("_")[1];
          session.resolution = res;
          await setSession(env, chatId, session);
          await editContentTypeKeyboard(BOT_TOKEN, chatId, query.message.message_id, res);
          return ok();
        }

        if (data.startsWith("content_")) {
          const contentType = data.substring("content_".length);
          session.content_type = contentType;
          await setSession(env, chatId, session);
          await editPrivacyKeyboard(BOT_TOKEN, chatId, query.message.message_id);
          return ok();
        }

        if (data === "priv_yes") {
          session.isPrivate = true;
          session.awaiting_password = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id,
            "🔒 أرسل كلمة المرور التي تريدها (4 أحرف على الأقل):");
          return ok();
        }

        if (data === "priv_no") {
          session.isPrivate = false;
          if (session.configuring_preset) {
            await savePresetAndConfirm(env, BOT_TOKEN, chatId, session, query.message.message_id);
          } else {
            session.awaiting_filename = true;
            await setSession(env, chatId, session);
            await promptFilename(BOT_TOKEN, chatId, query.message.message_id, session.filename, true);
          }
          return ok();
        }

        if (data === "name_skip") {
          session.awaiting_filename = false;
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "📤 جاري الإرسال إلى المصنع السحابي...");
          await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, session);
          return ok();
        }
      }
    } catch (err) {
      console.error("Handler error:", err.message, err.stack);
    }

    return ok();
  },
};

function ok() {
  return new Response("OK", { status: 200 });
}

// ========== الجلسات عبر KV ==========
async function getSession(env, chatId) {
  const raw = await env.SESSIONS.get(`session:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setSession(env, chatId, session) {
  await env.SESSIONS.put(`session:${chatId}`, JSON.stringify(session), { expirationTtl: 3600 });
}
async function deleteSession(env, chatId) {
  await env.SESSIONS.delete(`session:${chatId}`);
}

// ========== الإعداد المسبق (Preset) عبر KV — بلا انتهاء صلاحية ==========
async function getPreset(env, chatId) {
  const raw = await env.SESSIONS.get(`preset:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setPreset(env, chatId, preset) {
  await env.SESSIONS.put(`preset:${chatId}`, JSON.stringify(preset));
}

async function savePresetAndConfirm(env, BOT_TOKEN, chatId, session, editMessageId = null) {
  const preset = {
    resolution: session.resolution,
    content_type: session.content_type || "auto",
    isPrivate: !!session.isPrivate,
    password: session.password || "",
    active: true,
  };
  // الاحتفاظ بإعدادات الحلقة إن وجدت في الجلسة أو الإعداد السابق
  const oldPreset = await getPreset(env, chatId);
  if (oldPreset) {
    if (oldPreset.next_episode !== undefined) preset.next_episode = oldPreset.next_episode;
    if (oldPreset.episode_prefix) preset.episode_prefix = oldPreset.episode_prefix;
  }
  // يمكن أيضاً تمريرها من session مباشرة لو أضفناها لاحقاً
  await setPreset(env, chatId, preset);
  await deleteSession(env, chatId);
  const text = `✅ تم حفظ الإعداد وتفعيله.\n${presetStatusText(preset)}\n\nالآن أرسل أي فيديو أو رابط وسيُرفع فورًا بهذا الإعداد. استخدم /auto_off لإيقافه مؤقتًا، أو /setup لتغييره.`;
  if (editMessageId) {
    await editMessage(BOT_TOKEN, chatId, editMessageId, text);
  } else {
    await sendMessage(BOT_TOKEN, chatId, text);
  }
}

function presetStatusText(preset) {
  if (!preset) return "لا يوجد إعداد محفوظ. استخدم /setup لإنشاء واحد.";
  const contentLabels = { real: "فيديو حقيقي", animation: "أنمي/رسوم (متوازن)", animation_ultra: "أنمي/رسوم (أصغر حجم)", auto: "مش متأكد" };
  let lines = [
    `الحالة: ${preset.active ? "🟢 نشط" : "🔴 متوقف"}`,
    `الجودة: ${preset.resolution}p`,
    `النوع: ${contentLabels[preset.content_type] || preset.content_type}`,
    `الخصوصية: ${preset.isPrivate ? "🔒 خاص" : "🔓 عام"}`,
  ];
  if (preset.next_episode !== undefined && preset.next_episode !== null) {
    const prefix = preset.episode_prefix || "";
    lines.push(`🎬 التسمية التلقائية: "${prefix}${preset.next_episode}" (التالي)`);
  }
  return lines.join("\n");
}

function startMessage(preset) {
  const base = "🚀 أرسل الفيديو مباشرة هنا، أو أرسل رابط فيديو.\n⚡ سيتم إرسال المهمة إلى المصنع السحابي (GitHub Actions).";
  const extra = [
    "💡 يمكنك ضبط جودة/نوع/خصوصية ثابتة مرة واحدة عبر /setup.",
    "📌 أوامر التسمية التلقائية:",
    "  /setepisode 1  ➜ تعيين رقم الحلقة التالية",
    "  /setprefix حلقة   ➜ تعيين بادئة (اختياري)",
    "  /stopepisode   ➜ إلغاء التسمية التلقائية",
    "/preset لعرض الإعداد الحالي."
  ];
  if (preset && preset.active) {
    return `${base}\n\n⚙️ الوضع التلقائي مفعّل حاليًا.\n${presetStatusText(preset)}\n\n${extra.join("\n")}`;
  }
  return `${base}\n\n${extra.join("\n")}`;
}

// ========== عدّاد الطابور ==========
async function getQueueAheadCount(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW) {
  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Cloudflare-Worker",
  };
  let total = 0;
  try {
    for (const status of ["queued", "in_progress"]) {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/runs?status=${status}`,
        { headers }
      );
      if (r.ok) {
        const j = await r.json();
        total += j.total_count || 0;
      }
    }
  } catch (e) {
    return null;
  }
  return total;
}

// ========== إطلاق GitHub Actions ==========
async function triggerGitHub(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, session, chatId) {
  const body = {
    ref: "main",
    inputs: {
      message_id: session.message_id ? String(session.message_id) : "",
      url: session.url || "",
      resolution: session.resolution,
      chat_id: String(chatId),
      private: session.isPrivate ? "true" : "false",
      password: session.password || "",
      content_type: session.content_type || "auto",
      filename: session.filename || "",
    },
  };

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Cloudflare-Worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (response.status !== 204) {
    const errText = await response.text();
    console.error("GitHub dispatch failed:", response.status, errText);
  }
  return response.status === 204;
}

async function finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, session) {
  if ((!session.message_id && !session.url) || !session.resolution) {
    await sendMessage(BOT_TOKEN, chatId, "❌ حدث خطأ. أعد إرسال الفيديو أو الرابط.");
    await deleteSession(env, chatId);
    return;
  }
  if (session.isPrivate && !session.password) {
    await sendMessage(BOT_TOKEN, chatId, "❌ حدث خطأ: لم يتم تسجيل كلمة المرور. أعد إرسال الفيديو.");
    await deleteSession(env, chatId);
    return;
  }

  const success = await triggerGitHub(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, session, chatId);
  if (success) {
    const count = await getQueueAheadCount(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW);
    let note = "";
    if (count !== null) {
      note = count <= 1 ? "\n⚡ ستبدأ مهمتك فورًا تقريبًا." : `\n⏳ يوجد حاليًا ${count - 1} مهمة قبل مهمتك في الطابور.`;
    }
    await sendMessage(BOT_TOKEN, chatId, `✅ تم الإرسال! سيصلك رابط التحميل خلال دقائق.${note}`);
  } else {
    await sendMessage(BOT_TOKEN, chatId, "❌ فشل إرسال المهمة. تحقق من التوكن أو حاول لاحقًا.");
  }
  await deleteSession(env, chatId);
}

// ========== استخراج الاسم الافتراضي من الرسالة ==========
function extractDefaultName(message) {
  const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|ts|m4v|flv|wmv)$/i;
  let name = null;
  if (message.caption && message.caption.trim()) {
    name = message.caption.trim();
  } else {
    const fileName = (message.document && message.document.file_name) || (message.video && message.video.file_name);
    if (fileName) name = fileName.replace(VIDEO_EXT, "").trim();
  }
  if (!name) return null;
  name = name.split("\n")[0].trim();
  name = name.replace(/[\/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return name || null;
}

// ========== طلب اسم الملف ==========
async function promptFilename(BOT_TOKEN, chatId, editMessageId, defaultName, isEdit) {
  let text, keyboard;
  if (defaultName) {
    text = `✏️ الاسم المكتشف: ${defaultName}\nأرسل اسمًا جديدًا لتغييره، أو اضغط "استخدام هذا الاسم" للمتابعة.`;
    keyboard = { inline_keyboard: [[{ text: "✅ استخدام هذا الاسم", callback_data: "name_skip" }]] };
  } else {
    text = '✏️ هل تريد تسمية الفيديو؟\n(أرسل اسم الملف الآن أو اضغط "لا، تابع")';
    keyboard = { inline_keyboard: [[{ text: "✅ لا، تابع", callback_data: "name_skip" }]] };
  }
  if (isEdit && editMessageId) {
    await editMessage(BOT_TOKEN, chatId, editMessageId, text, keyboard);
  } else {
    await sendMessage(BOT_TOKEN, chatId, text, keyboard);
  }
}

// ========== لوحات المفاتيح ==========
async function sendQualityKeyboard(BOT_TOKEN, chatId, resolutions) {
  const rows = [];
  for (let i = 0; i < resolutions.length; i += 2) {
    const row = resolutions.slice(i, i + 2).map((r) => ({ text: `${r}p`, callback_data: `res_${r}` }));
    rows.push(row);
  }
  rows.push([{ text: "✏️ جودة مخصصة", callback_data: "custom_res" }]);
  rows.push([{ text: "إلغاء", callback_data: "cancel" }]);
  await sendMessage(BOT_TOKEN, chatId, "🎯 اختر الجودة:", { inline_keyboard: rows });
}

function contentTypeKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🎬 فيديو حقيقي (لايف أكشن)", callback_data: "content_real" }],
      [{ text: "🎨 أنمي/رسوم (متوازن)", callback_data: "content_animation" }],
      [{ text: "🎨 أنمي/رسوم (أصغر حجم ممكن)", callback_data: "content_animation_ultra" }],
      [{ text: "🤔 مش متأكد", callback_data: "content_auto" }],
    ],
  };
}
async function sendContentTypeKeyboard(BOT_TOKEN, chatId) {
  await sendMessage(BOT_TOKEN, chatId, "🖼️ ما نوع محتوى الفيديو؟\n(هذا يساعد في اختيار أفضل إعدادات ضغط)", contentTypeKeyboardMarkup());
}
async function editContentTypeKeyboard(BOT_TOKEN, chatId, messageId, res) {
  await editMessage(BOT_TOKEN, chatId, messageId, `🎯 ${res}p\n🖼️ ما نوع محتوى الفيديو؟`, contentTypeKeyboardMarkup());
}

async function editPrivacyKeyboard(BOT_TOKEN, chatId, messageId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔒 خاص (بكلمة مرور)", callback_data: "priv_yes" },
        { text: "🔓 عام (رابط مباشر)", callback_data: "priv_no" },
      ],
      [{ text: "إلغاء", callback_data: "cancel" }],
    ],
  };
  await editMessage(BOT_TOKEN, chatId, messageId, "🔐 هل تريد الفيديو خاصاً؟", keyboard);
}

// ========== Telegram API ==========
async function sendTelegram(BOT_TOKEN, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error(`Telegram API error (${method}):`, errText);
  }
  return r;
}

async function sendMessage(BOT_TOKEN, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  return sendTelegram(BOT_TOKEN, "sendMessage", body);
}

async function editMessage(BOT_TOKEN, chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (keyboard) body.reply_markup = keyboard;
  return sendTelegram(BOT_TOKEN, "editMessageText", body);
}

async function answerCallback(BOT_TOKEN, callbackQueryId) {
  return sendTelegram(BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  }
