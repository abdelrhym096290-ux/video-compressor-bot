import os, tempfile, subprocess, logging
from pathlib import Path
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes
import yt_dlp

TOKEN = os.environ["TELEGRAM_TOKEN"]

CODECS = {
    "av1": {"lib": "libsvtav1", "name": "AV1"},
    "h265": {"lib": "libx265", "name": "H.265"},
}
RESOLUTIONS = ["240", "360", "480", "720", "1080"]

logging.basicConfig(level=logging.INFO)
sessions = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "أرسل رابط فيديو تيليجرام عام. سأحمله وأضغطه بـ AV1 أو H.265."
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg.text or not msg.text.startswith("https://t.me/"):
        await msg.reply_text("أرسل رابط فيديو عام من تيليجرام فقط.")
        return
    sessions[update.effective_chat.id] = {"url": msg.text.strip()}
    keyboard = [[InlineKeyboardButton(f"{res}p", callback_data=f"res_{res}")] for res in RESOLUTIONS]
    keyboard.append([InlineKeyboardButton("إلغاء", callback_data="cancel")])
    await msg.reply_text("اختر الدقة:", reply_markup=InlineKeyboardMarkup(keyboard))

async def res_choice(update: Update, context: ContextTypes.DEFAULT_TYPE):
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
        keyboard = [[InlineKeyboardButton(v["name"], callback_data=f"codec_{k}")] for k, v in CODECS.items()]
        keyboard.append([InlineKeyboardButton("إلغاء", callback_data="cancel")])
        await query.edit_message_text(f"اختر الكوديك ({res}p):", reply_markup=InlineKeyboardMarkup(keyboard))

async def codec_choice(update: Update, context: ContextTypes.DEFAULT_TYPE):
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
            await query.edit_message_text("انتهت الجلسة.")
            return
        resolution = session["resolution"]
        codec_name = CODECS[codec_key]["name"]
        codec_lib = CODECS[codec_key]["lib"]

        await query.edit_message_text(f"جاري تحميل وضغط الفيديو بـ {codec_name} ({resolution}p)...")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir = Path(tmpdir)
            input_path = tmpdir / "input.mp4"
            try:
                ydl_opts = {"outtmpl": str(input_path), "quiet": True}
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([session["url"]])
            except Exception as e:
                await query.message.reply_text(f"فشل التحميل: {e}")
                return

            output_path = tmpdir / f"output_{codec_key}.mkv"
            scale_filter = f"scale=-2:{resolution}"
            cmd = [
                "ffmpeg", "-i", str(input_path),
                "-vf", scale_filter,
                "-c:v", codec_lib,
                "-crf", "40",
                "-preset", "faster" if codec_key == "av1" else "ultrafast",
                "-c:a", "libopus", "-b:a", "16k",
                "-y", str(output_path)
            ]
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                size_mb = os.path.getsize(output_path) / (1024 * 1024)
                if size_mb > 2000:
                    await query.message.reply_text("الناتج > 2GB. جرب دقة أقل.")
                else:
                    with open(output_path, "rb") as f:
                        await query.message.reply_document(
                            document=f,
                            caption=f"{codec_name} {resolution}p - {size_mb:.1f} MB"
                        )
            except Exception as e:
                await query.message.reply_text(f"فشل الضغط: {e}")
        sessions.pop(chat_id, None)

def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(res_choice, pattern="^res_"))
    app.add_handler(CallbackQueryHandler(codec_choice, pattern="^codec_"))
    app.add_handler(CallbackQueryHandler(lambda u,c: u.callback_query.data == "cancel", block=False))
    app.run_polling()

if __name__ == "__main__":
    main()
