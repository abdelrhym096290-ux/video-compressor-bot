export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const BOT_TOKEN = env.BOT_TOKEN;
    const GITHUB_TOKEN = env.GH_TOKEN;
    const BOT_PASSWORD = env.BOT_PASSWORD;
    const GITHUB_REPO = "abdelrhym118-cloud/Abd00118";
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

        // ===== وضع الإعداد التلقائي =====
        if (preset && preset.active) {
          let finalName = defaultName || "video";
          if (preset.next_episode !== undefined && preset.next_episode !== null) {
            const prefix = preset.episode_prefix ? preset.episode_prefix + " " : "";
            finalName = `${finalName} - ${prefix}${preset.next_episode}`.trim();
            preset.next_episode++;
            await setPreset(env, chatId, preset);
          }
          const autoSession = {
            message_id: update.message.message_id,
            encode_mode: preset.encode_mode,
            av1_preset: preset.av1_preset,
            encode_method: preset.encode_method,
            target_value: preset.target_value,
            resolution: preset.resolution,
            isPrivate: preset.isPrivate,
            password: preset.password,
            filename: finalName,
          };
          await sendMessage(BOT_TOKEN, chatId, `📤 جاري الإرسال تلقائيًا: ${finalName}`);
          await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, autoSession);
          return ok();
        }

        // ===== جلسة يدوية جديدة =====
        const newSession = { message_id: update.message.message_id, default_name: defaultName };
        await setSession(env, chatId, newSession);
        await sendEncodeModeKeyboard(BOT_TOKEN, chatId);
        return ok();
      }

      // ===== الرسائل النصية =====
      if (update.message && update.message.text !== undefined) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();

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
          await sendEncodeModeKeyboard(BOT_TOKEN, chatId);
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
            await sendMessage(BOT_TOKEN, chatId, "⏸️ تم إيقاف الوضع التلقائي. أرسل فيديو وستُسأل عن الإعدادات.");
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
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ بعد. استخدم /setup.");
          }
          return ok();
        }

        // ===== أوامر العداد التلقائي =====
        if (text.startsWith("/setepisode")) {
          const parts = text.split(" ");
          if (parts.length === 2 && /^\d+$/.test(parts[1])) {
            const num = parseInt(parts[1], 10);
            const preset = (await getPreset(env, chatId)) || {};
            preset.next_episode = num;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, `✅ تم تفعيل العداد، الحلقة القادمة ستكون رقم: ${num}`);
          } else {
            await sendMessage(BOT_TOKEN, chatId, "❌ الصيغة: /setepisode <رقم>\nمثال: /setepisode 1");
          }
          return ok();
        }

        if (text.startsWith("/setprefix")) {
          const prefix = text.substring("/setprefix".length).trimStart();
          if (!prefix) {
            await sendMessage(BOT_TOKEN, chatId, "❌ أرسل نص البادئة بعد الأمر.\nمثال: /setprefix حلقة");
            return ok();
          }
          const preset = (await getPreset(env, chatId)) || {};
          preset.episode_prefix = prefix;
          await setPreset(env, chatId, preset);
          await sendMessage(BOT_TOKEN, chatId, `✅ تم تعيين بادئة العداد: "${prefix}"`);
          return ok();
        }

        if (text === "/stopepisode") {
          const preset = await getPreset(env, chatId);
          if (preset) {
            delete preset.next_episode;
            delete preset.episode_prefix;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, "🛑 تم إلغاء التسمية بالعداد التلقائي.");
          }
          return ok();
        }

        // ===== استقبال القيمة (CRF أو Bitrate) =====
        if (session.awaiting_target_value) {
          session.target_value = text;
          session.awaiting_target_value = false;
          await setSession(env, chatId, session);

          if (session.encode_mode === "audio") {
            await sendMessage(BOT_TOKEN, chatId, `✅ القيمة المسجلة: ${text}`);
            await sendPrivacyKeyboard(BOT_TOKEN, chatId);
          } else {
            await sendMessage(BOT_TOKEN, chatId, `✅ القيمة المسجلة: ${text}`);
            await sendQualityKeyboard(BOT_TOKEN, chatId, RESOLUTIONS);
          }
          return ok();
        }

        // ===== استقبال الجودة (لو مخصصة) =====
        if (session.awaiting_res) {
          if (/^\d+$/.test(text)) {
            session.resolution = text;
            session.awaiting_res = false;
            await setSession(env, chatId, session);
            await sendPrivacyKeyboard(BOT_TOKEN, chatId);
          } else {
            await sendMessage(BOT_TOKEN, chatId, "❌ أرسل رقماً فقط (مثال: 550):");
          }
          return ok();
        }

        // ===== استقبال كلمة المرور =====
        if (session.awaiting_password) {
          if (text.length < 4) {
            await sendMessage(BOT_TOKEN, chatId, "❌ أرسل كلمة مرور من 4 أحرف على الأقل:");
          } else {
            session.password = text;
            session.awaiting_password = false;
            if (session.configuring_preset) {
              await savePresetAndConfirm(env, BOT_TOKEN, chatId, session);
            } else {
              session.awaiting_filename = true;
              await setSession(env, chatId, session);
              await promptFilename(BOT_TOKEN, chatId, null, session.default_name, false);
            }
          }
          return ok();
        }

        // ===== استقبال اسم الملف (ومزجه مع العداد) =====
        if (session.awaiting_filename) {
          session.filename = text;
          session.awaiting_filename = false;

          const finalName = await applyCounterToName(env, chatId, session.filename);
          session.filename = finalName;

          await setSession(env, chatId, session);
          await sendMessage(BOT_TOKEN, chatId, `✅ تم اعتماد الاسم النهائي: ${finalName}`);
          await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, session);
          return ok();
        }

        await sendMessage(BOT_TOKEN, chatId, "❌ أرسل فيديو مباشرة للبدء.");
        return ok();
      }

      // ===== ضغطات الأزرار (Callback Queries) =====
      if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data;
        await answerCallback(BOT_TOKEN, query.id);

        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);
        if (!isAuthorized) return ok();

        const session = (await getSession(env, chatId)) || {};

        if (data === "cancel") {
          await deleteSession(env, chatId);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🚫 تم الإلغاء.");
          return ok();
        }

        // 1. اختيار نوع المعالجة الثلاثي
        if (data.startsWith("mode_")) {
          const mode = data.split("_")[1];
          session.encode_mode = mode; // filters, nofilters, audio
          await setSession(env, chatId, session);

          if (mode === "audio") {
            session.av1_preset = "none";
            session.encode_method = "audio";
            session.awaiting_target_value = true;
            await setSession(env, chatId, session);
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, "✏️ أرسل معدل بت الصوت (مثال: 32k أو 48k):");
          } else {
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, "⚙️ ممتاز! اختر الـ Preset (سرعة/قوة الضغط):", presetKeyboardMarkup());
          }
          return ok();
        }

        // 2. اختيار الـ Preset
        if (data.startsWith("preset_")) {
          const preset_val = data.split("_")[1];
          session.av1_preset = preset_val;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, `✅ Preset: ${preset_val}\n⚙️ الآن اختر طريقة الضغط:`, encodeMethodKeyboardMarkup());
          return ok();
        }

        // 3. اختيار طريقة الضغط (CRF أو Two-Pass)
        if (data.startsWith("encmethod_")) {
          const method = data.split("_")[1];
          session.encode_method = method; // crf أو twopass
          session.awaiting_target_value = true;
          await setSession(env, chatId, session);

          if (method === "crf") {
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, `✅ الطريقة: ضغط ذكي (CRF)\n✏️ أرسل قيمة الجودة (مثال: 28 للحجم الصغير):`);
          } else {
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, `✅ الطريقة: حجم ثابت (Two-Pass)\n✏️ أرسل معدل البت المستهدف (مثال: 250k):`);
          }
          return ok();
        }

        // 4. اختيار الجودة
        if (data === "custom_res") {
          session.awaiting_res = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "✏️ أرسل الجودة (رقم فقط):");
          return ok();
        }

        if (data.startsWith("res_")) {
          session.resolution = data.split("_")[1];
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, `🎯 الجودة: ${session.resolution}p`, null);
          await sendPrivacyKeyboard(BOT_TOKEN, chatId);
          return ok();
        }

        // 5. الخصوصية
        if (data === "priv_yes") {
          session.isPrivate = true;
          session.awaiting_password = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🔒 أرسل كلمة المرور (4 أحرف على الأقل):");
          return ok();
        }

        if (data === "priv_no") {
          session.isPrivate = false;
          if (session.configuring_preset) {
            await savePresetAndConfirm(env, BOT_TOKEN, chatId, session, query.message.message_id);
          } else {
            session.awaiting_filename = true;
            await setSession(env, chatId, session);
            await promptFilename(BOT_TOKEN, chatId, query.message.message_id, session.default_name, true);
          }
          return ok();
        }

        // 6. استخدام الاسم المرفق
        if (data === "name_skip") {
          session.awaiting_filename = false;
          const finalName = await applyCounterToName(env, chatId, session.default_name || "video");
          session.filename = finalName;

          await editMessage(BOT_TOKEN, chatId, query.message.message_id, `📤 جاري الإرسال: ${finalName}`);
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

function ok() { return new Response("OK", { status: 200 }); }

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
async function getPreset(env, chatId) {
  const raw = await env.SESSIONS.get(`preset:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function setPreset(env, chatId, preset) {
  await env.SESSIONS.put(`preset:${chatId}`, JSON.stringify(preset));
}

async function applyCounterToName(env, chatId, baseName) {
  let finalName = baseName;
  const preset = await getPreset(env, chatId);
  if (preset && preset.next_episode !== undefined && preset.next_episode !== null) {
    const prefix = preset.episode_prefix ? preset.episode_prefix + " " : "";
    finalName = `${baseName} - ${prefix}${preset.next_episode}`.trim();
    preset.next_episode++;
    await setPreset(env, chatId, preset);
  }
  return finalName;
}

async function savePresetAndConfirm(env, BOT_TOKEN, chatId, session, editMessageId = null) {
  const preset = {
    encode_mode: session.encode_mode,
    av1_preset: session.av1_preset || "none",
    encode_method: session.encode_method,
    target_value: session.target_value,
    resolution: session.resolution || "none",
    isPrivate: !!session.isPrivate,
    password: session.password || "",
    active: true,
  };
  const oldPreset = await getPreset(env, chatId);
  if (oldPreset) {
    if (oldPreset.next_episode !== undefined) preset.next_episode = oldPreset.next_episode;
    if (oldPreset.episode_prefix) preset.episode_prefix = oldPreset.episode_prefix;
  }
  await setPreset(env, chatId, preset);
  await deleteSession(env, chatId);
  const text = `✅ تم حفظ الإعداد وتفعيله.\n${presetStatusText(preset)}\nاستخدم /auto_off للإيقاف.`;
  if (editMessageId) await editMessage(BOT_TOKEN, chatId, editMessageId, text);
  else await sendMessage(BOT_TOKEN, chatId, text);
}

function presetStatusText(preset) {
  if (!preset) return "لا يوجد إعداد محفوظ.";
  let modeLabel = preset.encode_mode === "filters" ? "مسلسلات (مع فلاتر)" : preset.encode_mode === "nofilters" ? "أنمي (بدون فلاتر)" : "صوت فقط";
  let methodLabel = preset.encode_method === "crf" ? "CRF" : preset.encode_method === "twopass" ? "Two-Pass" : "استخراج";

  let lines = [
    `الوضع: ${modeLabel}`,
    `الـ Preset: ${preset.av1_preset}`,
    `الطريقة: ${methodLabel}`,
    `القيمة: ${preset.target_value}`,
  ];
  if (preset.encode_mode !== "audio") lines.push(`الجودة: ${preset.resolution}p`);
  if (preset.next_episode !== undefined) {
    lines.push(`🎬 العداد التلقائي نشط للحلقة القادمة: ${preset.next_episode}`);
  }
  return lines.join("\n");
}

function startMessage(preset) {
  return `🚀 أرسل فيديو للبدء.\n\n📌 أوامر العداد التلقائي:\n  /setepisode 1 ➜ بدء العداد\n  /setprefix حلقة ➜ إضافة بادئة (اختياري)\n  /stopepisode ➜ إلغاء العداد\n\n${preset && preset.active ? '⚙️ الوضع التلقائي مفعّل.' : ''}`;
}

async function triggerGitHub(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, session, chatId) {
  const body = {
    ref: "main",
    inputs: {
      message_id: session.message_id ? String(session.message_id) : "",
      resolution: session.resolution || "audio",
      chat_id: String(chatId),
      private: session.isPrivate ? "true" : "false",
      password: session.password || "",
      filename: session.filename || "",
      encode_mode: session.encode_mode,
      av1_preset: session.av1_preset,
      encode_method: session.encode_method,
      target_value: String(session.target_value),
    },
  };

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "Cloudflare-Worker" },
    body: JSON.stringify(body),
  });
  return response.status === 204;
}

async function finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, session) {
  const success = await triggerGitHub(GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, session, chatId);
  if (success) await sendMessage(BOT_TOKEN, chatId, `✅ تم إرسال المهمة لمصنع الضغط السحابي!`);
  else await sendMessage(BOT_TOKEN, chatId, "❌ فشل الإرسال إلى GitHub.");
  await deleteSession(env, chatId);
}

function extractDefaultName(message) {
  let name = null;
  if (message.caption) name = message.caption;
  else if (message.document) name = message.document.file_name;
  else if (message.video) name = message.video.file_name;
  if (!name) return null;
  return name.replace(/\.[^/.]+$/, "").replace(/[\/\\:*?"<>|]/g, " ").trim();
}

async function promptFilename(BOT_TOKEN, chatId, editMessageId, defaultName, isEdit) {
  const text = defaultName 
    ? `الاسم المرفق: ${defaultName}\n\n✏️ أرسل اسماً جديداً الآن، أو اضغط استخدام المرفق.\n*(ملاحظة: العداد التلقائي سيُضاف للاسم إن كان مفعلاً)*`
    : `✏️ أرسل اسم الملف الجديد الآن:`;
  const keyboard = defaultName ? { inline_keyboard: [[{ text: "✅ استخدام الاسم المرفق", callback_data: "name_skip" }]] } : null;

  if (isEdit && editMessageId) await editMessage(BOT_TOKEN, chatId, editMessageId, text, keyboard);
  else await sendMessage(BOT_TOKEN, chatId, text, keyboard);
}

// ===== لوحات المفاتيح =====
async function sendEncodeModeKeyboard(BOT_TOKEN, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🎬 إدخال مع فلاتر (للمسلسلات)", callback_data: "mode_filters" }],
      [{ text: "🌸 إدخال بدون فلاتر (للأنمي)", callback_data: "mode_nofilters" }],
      [{ text: "🎵 صوت فقط (استخراج الصوت)", callback_data: "mode_audio" }],
      [{ text: "إلغاء", callback_data: "cancel" }]
    ]
  };
  await sendMessage(BOT_TOKEN, chatId, "⚙️ اختر نوع المعالجة:", keyboard);
}

function presetKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "8 (سريع)", callback_data: "preset_8" }, { text: "7 (متوسط)", callback_data: "preset_7" }],
      [{ text: "6 (بطيء)", callback_data: "preset_6" }, { text: "4 (أقصى ضغط)", callback_data: "preset_4" }],
      [{ text: "إلغاء", callback_data: "cancel" }]
    ]
  };
}

function encodeMethodKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🎛️ ضغط ذكي (CRF)", callback_data: "encmethod_crf" }],
      [{ text: "⚖️ حجم ثابت (Two-Pass)", callback_data: "encmethod_twopass" }],
      [{ text: "إلغاء", callback_data: "cancel" }]
    ]
  };
}

async function sendQualityKeyboard(BOT_TOKEN, chatId, resolutions) {
  const rows = [];
  for (let i = 0; i < resolutions.length; i += 2) {
    rows.push(resolutions.slice(i, i + 2).map((r) => ({ text: `${r}p`, callback_data: `res_${r}` })));
  }
  rows.push([{ text: "✏️ جودة مخصصة", callback_data: "custom_res" }]);
  await sendMessage(BOT_TOKEN, chatId, "🎯 اختر الجودة النهائية:", { inline_keyboard: rows });
}

async function sendPrivacyKeyboard(BOT_TOKEN, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔒 خاص", callback_data: "priv_yes" }, { text: "🔓 عام", callback_data: "priv_no" }]
    ]
  };
  await sendMessage(BOT_TOKEN, chatId, "🔐 هل تريد الملف خاصاً؟", keyboard);
}

// ===== API =====
async function sendTelegram(BOT_TOKEN, method, body) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}
async function sendMessage(BOT_TOKEN, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  await sendTelegram(BOT_TOKEN, "sendMessage", body);
}
async function editMessage(BOT_TOKEN, chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (keyboard) body.reply_markup = keyboard;
  await sendTelegram(BOT_TOKEN, "editMessageText", body);
}
async function answerCallback(BOT_TOKEN, callbackQueryId) {
  await sendTelegram(BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}
