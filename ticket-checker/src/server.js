// خادم صغير يستقبل Webhook من Freshdesk عند إنشاء تذكرة
import http from "node:http";
import crypto from "node:crypto";
import { config, assertConfig } from "./config.js";
import { FreshdeskClient } from "./freshdesk.js";
import { createClaudeClassifier } from "./classifier.js";
import { createChecker } from "./checker.js";

export function createServer({ checkTicket, secret, concurrency = 2 }) {
  const queue = [];
  const recent = new Map(); // لمنع فحص نفس التذكرة مرتين خلال دقائق
  let running = 0;

  function enqueue(id) {
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 10 * 60 * 1000) recent.delete(k);
    if (recent.has(id)) return false;
    recent.set(id, now);
    queue.push(id);
    pump();
    return true;
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const id = queue.shift();
      running++;
      checkTicket(id)
        .then((r) => console.log(`#${id}`, r.skipped ? `تخطّي (${r.skipped})` :
          `${r.flagged ? "⚠️ تنبيه" : "✅ سليم"} | ${r.selected_path || "-"} → ${r.suggested_path || "-"} (${r.confidence ?? "-"}%) ${r.actions.join(",")}`))
        .catch((e) => { recent.delete(id); console.error(`#${id} خطأ:`, e.message); })
        .finally(() => { running--; pump(); });
    }
  }

  const safeEqual = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, "http://x");

    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, queued: queue.length, running });
    if (req.method !== "POST" || url.pathname !== "/freshdesk/webhook") return send(404, { error: "not found" });

    const provided = req.headers["x-webhook-secret"] || url.searchParams.get("secret") || "";
    if (secret && !safeEqual(provided, secret)) return send(401, { error: "unauthorized" });

    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let data;
      try { data = JSON.parse(body || "{}"); } catch { return send(400, { error: "invalid json" }); }
      const raw = data.ticket_id ?? data.freshdesk_webhook?.ticket_id ?? data.id;
      const id = Number(String(raw ?? "").replace(/\D/g, ""));
      if (!id) return send(400, { error: "ticket_id missing" });
      const accepted = enqueue(id);
      send(202, { accepted, ticket_id: id });
    });
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertConfig();
  if (!config.webhookSecret) console.warn("⚠️ WEBHOOK_SECRET غير محدد — أي أحد يعرف الرابط يقدر يرسل طلبات.");
  const fd = new FreshdeskClient(config.freshdesk);
  const classify = createClaudeClassifier(config.ai);
  const checkTicket = createChecker({ fd, classify, config });
  createServer({ checkTicket, secret: config.webhookSecret }).listen(config.port, () => {
    console.log(`✅ مدقق التذاكر يعمل على المنفذ ${config.port}${config.dryRun ? " (وضع التجربة: بدون كتابة في Freshdesk)" : ""}`);
  });
}
