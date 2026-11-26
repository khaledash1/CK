/* =========================================================
   ⚙️ إعدادات البث — عدّل هنا فقط
   ========================================================= */
window.STREAM_CONFIG = {
  // اسم قناتك في تويتش (بالإنجليزي، كما يظهر في الرابط twitch.tv/xxxx)
  channel: "your_channel",

  // الاسم المعروض في التصاميم
  displayName: "KHALED",
  tagline: "قيمنق • سواليف • تحديات",

  // الألوان (نيون)
  colors: {
    primary: "#9146FF",   // بنفسجي تويتش
    accent:  "#00F0FF",   // سماوي
    hot:     "#FF2E88",   // وردي للتنبيهات
    gold:    "#FFC93C"    // ذهبي للدونيشن
  },

  // حساباتك (اتركه فاضي "" لإخفائه)
  socials: {
    twitch:    "your_channel",
    x:         "your_handle",
    instagram: "your_handle",
    tiktok:    "your_handle",
    youtube:   "",
    discord:   "discord.gg/xxxx"
  },

  // هدف الدونيشن
  goal: {
    title: "هدف البث: مايك جديد 🎙️",
    current: 0,       // المبلغ الحالي عند البداية
    target: 500,      // المبلغ المستهدف
    currency: "$"
  },

  // مدة العد التنازلي لشاشة "البث يبدأ قريباً" بالدقائق
  countdownMinutes: 5,

  // 🔑 توكن StreamElements (JWT) — للتنبيهات الحية
  // تجده في: streamelements.com → Account → Channels → Show secrets → JWT Token
  // ⚠️ لا تشاركه مع أحد ولا ترفعه على GitHub عام
  streamElementsJWT: ""

};
