/**
 * Cloudflare Worker: Telegram Video Compressor Bot
 * Version: 3.0 (Unified AV1/VVC with Filter Support)
 */

const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const GH_TOKEN = 'YOUR_GITHUB_TOKEN';
const GH_REPO = 'username/repo-name'; // e.g., "myuser/vid-compressor"
const TG_CHANNEL_ID = 'YOUR_CHANNEL_ID'; // e.g., "-100123456789"

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'POST') {
    try {
      const update = await request.json();
      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query);
      }
    } catch (e) {
      console.error(e);
    }
  }
  return new Response('OK');
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/start') {
    await sendTelegram(chatId, "🚀 مرحباً بك في بوت الضغط السحابي الموحد!\n\nأرسل رابط الفيديو المباشر (Direct Link) للبدء.");
  } else if (text && text.startsWith('http')) {
    // Step 1: Select Codec
    const keyboard = {
      inline_keyboard: [
        [{ text: "💎 AV1 (أصغر حجم)", callback_data: `c:av1:${text}` }],
        [{ text: "⚡ VVC/H.266 (أحدث تقنية)", callback_data: `c:vvc:${text}` }],
        [{ text: "🎵 صوت فقط (Opus)", callback_data: `c:audio:${text}` }]
      ]
    };
    await sendTelegram(chatId, "1️⃣ اختر المرمّز المطلوب:", keyboard);
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data.split(':');
  const action = data[0];

  if (action === 'c') { // Codec selected
    const codec = data[1];
    const url = data.slice(2).join(':');
    
    let keyboard;
    if (codec === 'av1') {
      keyboard = {
        inline_keyboard: [
          [{ text: "أسرع (10)", callback_data: `p:av1:10:${url}` }, { text: "متوازن (6)", callback_data: `p:av1:6:${url}` }],
          [{ text: "جودة عالية (4)", callback_data: `p:av1:4:${url}` }]
        ]
      };
    } else if (codec === 'vvc') {
      keyboard = {
        inline_keyboard: [
          [{ text: "الأسرع (4)", callback_data: `p:vvc:4:${url}` }, { text: "سريع (3)", callback_data: `p:vvc:3:${url}` }],
          [{ text: "بطيء (2)", callback_data: `p:vvc:2:${url}` }]
        ]
      };
    } else {
      // Audio selection
      return await triggerGitHub(chatId, url, 'audio', '0', 'vbr', '32k', 'nofilters');
    }
    await sendTelegram(chatId, `2️⃣ اختر سرعة الضغط (Preset) لـ ${codec.toUpperCase()}:`, keyboard);

  } else if (action === 'p') { // Preset selected
    const codec = data[1];
    const preset = data[2];
    const url = data.slice(3).join(':');
    
    const keyboard = {
      inline_keyboard: [
        [{ text: "أنمي 🌸 (فلاتر تنعيم)", callback_data: `f:${codec}:${preset}:anime:${url}` }],
        [{ text: "واقعي 🎬 (فلاتر تنظيف)", callback_data: `f:${codec}:${preset}:realistic:${url}` }],
        [{ text: "بدون فلاتر 🚫", callback_data: `f:${codec}:${preset}:none:${url}` }]
      ]
    };
    await sendTelegram(chatId, "3️⃣ اختر نوع المحتوى لتطبيق الفلاتر المناسبة:", keyboard);

  } else if (action === 'f') { // Filter selected -> Now select Resolution
    const codec = data[1];
    const preset = data[2];
    const filter = data[3];
    const url = data.slice(4).join(':');
    
    const keyboard = {
      inline_keyboard: [
        [{ text: "480p", callback_data: `r:${codec}:${preset}:${filter}:480:${url}` }, { text: "720p", callback_data: `r:${codec}:${preset}:${filter}:720:${url}` }],
        [{ text: "1080p", callback_data: `r:${codec}:${preset}:${filter}:1080:${url}` }]
      ]
    };
    await sendTelegram(chatId, "4️⃣ اختر الدقة المطلوبة:", keyboard);

  } else if (action === 'r') { // Resolution selected -> Final step: Quality
    const codec = data[1];
    const preset = data[2];
    const filter = data[3];
    const res = data[4];
    const url = data.slice(5).join(':');

    let prompt = codec === 'av1' ? "أدخل قيمة CRF (مثلاً 35):" : "أدخل قيمة QP (مثلاً 38):";
    // For simplicity in this demo, we'll use a few buttons for quality
    const keyboard = {
      inline_keyboard: [
        [{ text: "جودة ممتازة (28)", callback_data: `g:${codec}:${preset}:${filter}:${res}:28:${url}` }],
        [{ text: "متوازنة (35)", callback_data: `g:${codec}:${preset}:${filter}:${res}:35:${url}` }],
        [{ text: "حجم صغير (42)", callback_data: `g:${codec}:${preset}:${filter}:${res}:42:${url}` }]
      ]
    };
    await sendTelegram(chatId, `5️⃣ ${prompt}`, keyboard);

  } else if (action === 'g') { // Quality selected -> Trigger GitHub
    const codec = data[1];
    const preset = data[2];
    const filter = data[3];
    const res = data[4];
    const val = data[5];
    const url = data.slice(6).join(':');
    
    await triggerGitHub(chatId, url, codec, preset, (codec === 'av1' ? 'crf' : 'qp'), val, res, filter);
  }
}

async function triggerGitHub(chatId, url, codec, preset, method, val, res, filter) {
  await sendTelegram(chatId, "⏳ جاري إرسال المهمة إلى GitHub Actions... ستصلك النتيجة في القناة عند الانتهاء.");
  
  const resGH = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/video_compressor.yml/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Manus-Bot'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        download_url: url,
        codec: codec,
        preset: preset,
        encode_method: method,
        target_value: val,
        resolution: res,
        content_type: filter,
        chat_id: chatId.toString()
      }
    })
  });

  if (resGH.status === 204) {
    await sendTelegram(chatId, "✅ تم بدء المهمة بنجاح! يمكنك متابعة التقدم من مستودع GitHub الخاص بك.");
  } else {
    await sendTelegram(chatId, "❌ فشل إرسال المهمة. تأكد من صحة الـ Token واسم المستودع.");
  }
}

async function sendTelegram(chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text: text };
  if (keyboard) body.reply_markup = keyboard;
  
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
