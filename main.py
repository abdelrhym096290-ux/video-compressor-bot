import os
import subprocess
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, CallbackQueryHandler, filters, ContextTypes

TOKEN = os.getenv("BOT_TOKEN")
user_sessions = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "⚡️ أهلاً بك في منصة الضغط الاحترافية الفائقة لملفات العمل!\n\n"
        "أنظمة المعالجة المدمجة الحالية:\n"
        "🔹 الحفاظ على جودة الصوت الأصلية بالكامل.\n"
        "🔹 دمج وحفظ مسارات الترجمة والمحطات المدمجة.\n"
        "🔹 تهيئة الملفات للبث السريع المستقر تليجرام.\n\n"
        "📥 أرسل لي أي فيديو الآن لنبدأ المعالجة المخصصة."
    )

async def handle_video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    status_message = await update.message.reply_text("📥 جاري سحب وتحميل الملف إلى السيرفر بأمان...")
    
    input_path = f"input_{user_id}.mp4"
    video_file = await update.message.video.get_file()
    await video_file.download_to_drive(input_path)
    
    orig_size = round(os.path.getsize(input_path) / (1024 * 1024), 2)
    
    user_sessions[user_id] = {
        "input_path": input_path,
        "orig_size": orig_size,
        "codec": None,
        "resolution": None
    }
    
    keyboard = [
        [
            InlineKeyboardButton("🎯 متوافق (H.264)", callback_data="codec_h264"),
            InlineKeyboardButton("💎 عالي الكفاءة (H.265/HEVC)", callback_data="codec_h265")
        ],
        [
            InlineKeyboardButton("🚀 متطور (AV1)", callback_data="codec_av1"),
            InlineKeyboardButton("🧪 النطاق الأقصى (VVC/H.266)", callback_data="codec_vvc")
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await status_message.delete()
    await update.message.reply_text(f"📊 حجم الملف الأصلي: {orig_size} MB\n\nStep 1️⃣: اختر معيار كوديك الضغط المطلوب:", reply_markup=reply_markup)

async def handle_callbacks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    data = query.data
    
    if user_id not in user_sessions or not os.path.exists(user_sessions[user_id]["input_path"]):
        await query.edit_message_text("❌ انتهت صلاحية الجلسة أو تم تنظيف الملفات أوتوماتيكياً لحماية السيرفر. أرسل الفيديو مجدداً.")
        return

    if data.startswith("codec_"):
        chosen_codec = data.split("_")[1]
        user_sessions[user_id]["codec"] = chosen_codec
        
        keyboard = [
            [InlineKeyboardButton("🎞️ نفس الأبعاد الأصلية (ينصح به)", callback_data="res_original")],
            [InlineKeyboardButton("🖥️ دقة Full HD (1080p)", callback_data="res_1080")],
            [InlineKeyboardButton("📺 دقة HD (720p)", callback_data="res_720")],
            [InlineKeyboardButton("📱 دقة عادية (480p)", callback_data="res_480")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(f"الترميز المعتمد: {chosen_codec.upper()}\n\nStep 2️⃣: اختر أبعاد الشاشة (Resolution):", reply_markup=reply_markup)
        
    elif data.startswith("res_"):
        chosen_res = data.split("_")[1]
        user_sessions[user_id]["resolution"] = chosen_res
        codec = user_sessions[user_id]["codec"]
        
        keyboard = [
            [InlineKeyboardButton("🍏 جودة فائقة (أكبر حجم)", callback_data="quality_high")],
            [InlineKeyboardButton("⚖️ متوازنة (أفضل خيار للعمل والأنمي)", callback_data="quality_medium")],
            [InlineKeyboardButton("🗜️ أقصى ضغط متاح (أصغر حجم)", callback_data="quality_low")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(f"الترميز: {codec.upper()} | الأبعاد: {chosen_res.upper()}\n\nStep 3️⃣: اختر مستوى ضغط البيانات البصرية:", reply_markup=reply_markup)
        
    elif data.startswith("quality_"):
        chosen_quality = data.split("_")[1]
        session = user_sessions[user_id]
        codec = session["codec"]
        resolution = session["resolution"]
        input_path = session["input_path"]
        orig_size = session["orig_size"]
        output_path = f"compressed_{user_id}.mp4"
        
        await query.edit_message_text(f"⚙️ السيرفر يعالج خياراتك الآن...\n🎬 الترميز: {codec.upper()} | 📺 الأبعاد: {resolution.upper()} | 🗜️ الضغط: {chosen_quality.upper()}\n\nيرجى الانتظار، يتم فحص البيانات وإعادة التشفير...")

        crf_values = {
            "h264": {"high": "21", "medium": "25", "low": "29"},
            "h265": {"high": "23", "medium": "27", "low": "31"},
            "av1":  {"high": "26", "medium": "31", "low": "36"},
            "vvc":  {"high": "26", "medium": "31", "low": "36"}
        }
        crf = crf_values[codec][chosen_quality]
        
        scale_filter = "" if resolution == "original" else f"-vf scale=-2:{resolution}"
        
        if codec == "h264":
            command = f"ffmpeg -y -i {input_path} -map 0 -vcodec libx264 {scale_filter} -crf {crf} -preset fast -c:a copy -movflags +faststart {output_path}"
        elif codec == "h265":
            command = f"ffmpeg -y -i {input_path} -map 0 -vcodec libx265 {scale_filter} -crf {crf} -preset fast -c:a copy -movflags +faststart {output_path}"
        elif codec == "av1":
            command = f"ffmpeg -y -i {input_path} -map 0 -vcodec libsvtav1 {scale_filter} -crf {crf} -preset 8 -c:a copy -movflags +faststart {output_path}"
        elif codec == "vvc":
            command = f"ffmpeg -y -i {input_path} -map 0 -vcodec libvvenc {scale_filter} -crf {crf} -preset fast -c:a copy -movflags +faststart {output_path}"

        try:
            subprocess.run(command, shell=True, check=True)
            new_size = round(os.path.getsize(output_path) / (1024 * 1024), 2)
            saved_percentage = round(((orig_size - new_size) / orig_size) * 100, 1) if orig_size > 0 else 0
            
            await query.edit_message_text("📤 اكتملت عملية الهندسة والضغط بنجاح! جاري تسليم ملف العمل...")
            with open(output_path, 'rb') as video:
                await query.message.reply_video(
                    video, 
                    caption=f"✅ **اكتمل الضغط الاحترافي الحقيقي!**\n\n"
                            f"🎞 **الترميز:** {codec.upper()}\n"
                            f"📺 **الأبعاد:** {resolution.upper()}\n"
                            f"🗜 **مستوى الضغط:** {chosen_quality.upper()}\n\n"
                            f"📊 **تحليلات المساحة:**\n"
                            f"📉 الحجم السابق: {orig_size} MB\n"
                            f"📈 الحجم الحالي: {new_size} MB\n"
                            f"🎉 نسبة التوفير في المساحة: {saved_percentage}%"
                )
        except Exception as e:
            await query.edit_message_text("❌ عذراً، فشلت المعالجة. يرجى التأكد من دعم المنصة للمكتبة المطلوبة.")
        
        if os.path.exists(input_path): os.remove(input_path)
        if os.path.exists(output_path): os.remove(output_path)
        if user_id in user_sessions: del user_sessions[user_id]

def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.VIDEO, handle_video))
    app.add_handler(CallbackQueryHandler(handle_callbacks))
    app.run_polling()

if __name__ == '__main__':
    main()
