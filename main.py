import os
import asyncio
import threading
import tempfile
from pathlib import Path
from io import BytesIO

from flask import Flask, request
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)
import imageio_ffmpeg

# ---------- الإعدادات ----------
TOKEN = os.environ["TELEGRAM_TOKEN"]

# الكوديكات المتاحة
CODECS = {
    "av1":   {"lib": "libsvtav1",   "name": "AV1"},
    "h265":  {"lib": "libx265",     "name": "H.265"},
    "vp9":   {"lib": "libvpx-vp9",  "name": "VP9"}
}

# الدقات المتاحة
RESOLUTIONS = ["240", "360", "480", "720", "1080"]

# تجهيز FFmpeg
FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
os.environ["PATH"] = str(Path(FFMPEG_PATH).parent) + os.pathsep + os.environ["PATH"]

# ---------- بناء البوت ----------
application = Application.builder().token(TOKEN).build()
flask_app = Flask(__name__)

# تخزين مؤقت لبيانات الجلسة
# { chat_id: {"file_id": ..., "resolution": ..., "codec": ...} }
sessions = {}

# ---------- دوال المعالجة ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "أهلاً! أرسل لي:\n"
        "1) رابط رسالة عامة تحتوي على فيديو (في قناة أو مجموعة عامة)\n"
        "2) أو أعد توجيه الفيديو مباشرة إليّ\n\n"
        "سأضغطه بأحد الكوديكات AV1 / H.265 / VP9 وبالدقة التي تختارها."
    )

async def handle_video_input(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """استقبال فيديو مباشر (إعادة توجيه أو رفع) أو رابط رسالة"""
    msg = update.message
    file_id = None

    # الحالة 1: فيديو مرفوع أو معاد توجيهه
    if msg.video:
        file_id = msg.video.file_id
    # الحالة 2: رابط رسالة عامة (يحوي media)
    elif msg.text and msg.text.startswith("https://t.me/"):
        try:
            # استخراج chat_id و message_id من الرابط
            # أمثلة:
            # https://t.me/c/1234567890/1234 (قناة خاصة قد لا يعمل)
            # https://t.me/username/1234 (عام)
            parts = msg.text.split("/")
            if len(parts) >= 5:
                chat_id = "/".join(parts[-2:-1]) if parts[-3] == "c" else ("@" + parts[-2])
                msg_id = int(parts[-1])
                # جلب الرسالة (يجب أن يكون البوت عضوًا أو الرابط عامًا)
                fetched = await context.bot.forward_message(
                    chat_id=update.effective_chat.id,
                    from_chat_id=chat_id,
                    message_id=msg_id
                )
                if fetched.video:
                    file_id = fetched.video.file_id
                else:
                    await msg.reply_text("الرابط لا يحتوي على فيديو.")
                    return
            else:
                await msg.reply_text("صيغة الرابط غير مدعومة. أرسل رابط رسالة عامة بالشكل: https://t.me/xxx/yyy")
                return
        except Exception as e:
            await msg.reply_text(f"لم أستطع الوصول للفيديو. تأكد أن الرابط عام وأن البوت ليس محظورًا. الخطأ: {e}")
            return
    else:
        await msg.reply_text("أرسل فيديو أو رابط رسالة عامة تحتوي على فيديو.")
        return

    # حفظ file_id مؤقتًا
    sessions[update.effective_chat.id] = {"file_id": file_id}
    # عرض أزرار اختيار الدقة
    keyboard = [[InlineKeyboardButton(f"{res}p", callback_data=f"res_{res}")] for res in RESOLUTIONS]
    keyboard.append([InlineKeyboardButton("إلغاء", callback_data="cancel")])
    await msg.reply_text("اختر الدقة المطلوبة:", reply_markup=InlineKeyboardMarkup(keyboard))

async def resolution_choice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بعد اختيار الدقة نعرض الكوديكات"""
    query = update.callback_query
    await query.answer()
    data = query.data
    chat_id = query.message.chat_id

    if data == "cancel":
        sessions.pop(chat_id, None)
        await query.edit_message_text("تم الإلغاء.")
        return

    if data.startswith("res_"):
        res = data.split("_")[1]
        sessions[chat_id]["resolution"] = res
        # عرض الكوديكات
        keyboard = [[InlineKeyboardButton(v["name"], callback_data=f"codec_{k}")] for k, v in CODECS.items()]
        keyboard.append([InlineKeyboardButton("إلغاء", callback_data="cancel")])
        await query.edit_message_text(f"اختر الكوديك (الدقة: {res}p):", reply_markup=InlineKeyboardMarkup(keyboard))

async def codec_choice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بدء الضغط بعد اختيار الكوديك"""
    query = update.callback_query
    await query.answer()
    data = query.data
    chat_id = query.message.chat_id

    if data == "cancel":
        sessions.pop(chat_id, None)
        await query.edit_message_text("تم الإلغاء.")
        return

    if data.startswith("codec_"):
        codec_key = data.split("_")[1]
        session = sessions.get(chat_id)
        if not session:
            await query.edit_message_text("انتهت الجلسة، أرسل الفيديو مرة أخرى.")
            return

        file_id = session["file_id"]
        resolution = session["resolution"]
        codec_name = CODECS[codec_key]["name"]
        codec_lib = CODECS[codec_key]["lib"]

        await query.edit_message_text(f"جاري الضغط بـ {codec_name} ودقة {resolution}p... قد يستغرق دقيقة.")

        # إنشاء مجلد مؤقت
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            # تحميل الفيديو من تيليجرام
            try:
                file = await context.bot.get_file(file_id)
                input_path = tmpdir / "input.mp4"
                await file.download_to_drive(input_path)
            except Exception as e:
                await query.message.reply_text(f"فشل تحميل الفيديو: {e}")
                return

            # إعداد أوامر FFmpeg
            output_path = tmpdir / f"output_{codec_key}.mp4"
            scale_filter = f"scale=-2:{resolution}"  # يحافظ على نسبة الأبعاد

            cmd = [
                FFMPEG_PATH,
                "-i", str(input_path),
                "-vf", scale_filter,
                "-c:v", codec_lib,
                "-crf", "40",          # كلما زاد قل الحجم
                "-preset", "ultrafast",
                "-c:a", "libopus",
                "-b:a", "12k",
                "-y",
                str(output_path)
            ]

            # تعديلات خاصة بكل كوديك
            if codec_key == "av1":
                cmd[cmd.index("-preset") + 1] = "8"   # preset 8 للسرعة
            elif codec_key == "vp9":
                cmd[cmd.index("-crf") + 1] = "40"
                cmd[cmd.index("-preset") + 1] = "ultrafast"

            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                size_mb = os.path.getsize(output_path) / (1024 * 1024)
                if size_mb > 2000:
                    await query.message.reply_text("حجم الملف الناتج تجاوز 2GB، تعذر الإرسال.")
                else:
                    with open(output_path, "rb") as f:
                        await query.message.reply_document(
                            document=f,
                            caption=f"تم الضغط: {codec_name} - {resolution}p - {size_mb:.1f} MB"
                        )
            except subprocess.CalledProcessError as e:
                await query.message.reply_text(f"فشل الضغط. ربما الملف غير مدعوم أو الكوديك غير متوفر. الخطأ: {e}")
            except Exception as e:
                await query.message.reply_text(f"حدث خطأ غير متوقع: {e}")
        # تنظيف الجلسة
        sessions.pop(chat_id, None)

# ---------- ربط المعالجات ----------
application.add_handler(CommandHandler("start", start))
application.add_handler(MessageHandler(filters.VIDEO | (filters.TEXT & filters.Entity("url")), handle_video_input))
application.add_handler(CallbackQueryHandler(resolution_choice, pattern="^res_"))
application.add_handler(CallbackQueryHandler(codec_choice, pattern="^codec_"))
application.add_handler(CallbackQueryHandler(lambda u,c: u.callback_query.data == "cancel", block=False))

# ---------- حلقة المعالجة الخلفية ----------
async def process_updates_loop():
    async for update in application.update_queue:
        await application.process_update(update)

loop = asyncio.new_event_loop()
t = threading.Thread(target=loop.run_forever, daemon=True)
t.start()
asyncio.run_coroutine_threadsafe(process_updates_loop(), loop)

# ---------- Webhook ----------
@flask_app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(force=True)
    update = Update.de_json(data, application.bot)
    asyncio.run_coroutine_threadsafe(application.update_queue.put(update), loop)
    return "ok"
