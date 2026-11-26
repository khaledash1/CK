// الإعدادات كلها تُقرأ من متغيرات البيئة (أو من ملف .env إن وُجد)
import fs from "node:fs";

function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v, d = false) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: Number(env.PORT || 3000),
  webhookSecret: env.WEBHOOK_SECRET || "",

  freshdesk: {
    domain: env.FRESHDESK_DOMAIN || "", // مثال: yourcompany.freshdesk.com
    apiKey: env.FRESHDESK_API_KEY || "",
  },

  // اسم حقل التصنيف الرئيسي في Freshdesk:
  //  - "ticket_type" لحقل Type الافتراضي
  //  - أو اسم الحقل المخصص مثل "cf_category" (لو كان حقلاً متسلسلاً تُكتشف مستوياته تلقائياً)
  categoryField: env.CATEGORY_FIELD || "ticket_type",
  // حقول إضافية لازم تكون معبأة (اختياري)، مثل: cf_location,cf_asset_tag
  requiredFields: list(env.REQUIRED_FIELDS),

  ai: {
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    effort: env.CLAUDE_EFFORT || "low", // low | medium | high
  },

  // متى نعتبر الملاحظة مؤكدة بما يكفي للتنبيه (0-100)
  minConfidence: Number(env.MIN_CONFIDENCE || 70),

  notify: {
    // نبّه الموظف اللي رفع التذكرة إذا كان وكيلاً (Agent) في Freshdesk
    requesterIfAgent: bool(env.NOTIFY_REQUESTER_IF_AGENT, true),
    // نبّه الوكيل المسند له التذكرة
    responder: bool(env.NOTIFY_RESPONDER, false),
    // إيميلات وكلاء إضافيين (مشرفين مثلاً) يوصلهم التنبيه دائماً
    extraEmails: list(env.NOTIFY_EXTRA_EMAILS),
    // ردّ على صاحب التذكرة (لو كان موظفاً عادياً من البوابة) برسالة توعوية
    replyToRequester: bool(env.REPLY_TO_REQUESTER, false),
  },

  tags: {
    wrong: env.TAG_WRONG || "needs-recategorization",
    incomplete: env.TAG_INCOMPLETE || "incomplete-category",
    checked: env.TAG_CHECKED || "category-checked",
  },

  // تصحيح التصنيف تلقائياً بدل الاكتفاء بالتنبيه (مغلق افتراضياً)
  autoFix: bool(env.AUTO_FIX, false),
  autoFixMinConfidence: Number(env.AUTO_FIX_MIN_CONFIDENCE || 90),

  // وضع التجربة: يفحص ويسجل بدون ما يكتب أي شيء في Freshdesk
  dryRun: bool(env.DRY_RUN, false),

  logFile: env.LOG_FILE || "data/checks.jsonl",
};

export function assertConfig() {
  const missing = [];
  if (!config.freshdesk.domain) missing.push("FRESHDESK_DOMAIN");
  if (!config.freshdesk.apiKey) missing.push("FRESHDESK_API_KEY");
  if (missing.length) {
    throw new Error(`إعدادات ناقصة: ${missing.join(", ")} — شوف ملف .env.example`);
  }
}
