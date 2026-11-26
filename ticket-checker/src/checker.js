// المنطق الأساسي: يفحص تذكرة واحدة ويتصرف حسب النتيجة
import fs from "node:fs";
import path from "node:path";
import { buildCategorySchema, readField, fieldUpdate } from "./freshdesk.js";

const SCHEMA_TTL_MS = 10 * 60 * 1000;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isEmpty = (v) => v === null || v === undefined || v === "";

export function createChecker({ fd, classify, config, log = console }) {
  let schemaCache = null;

  async function getSchema() {
    if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.schema;
    const fields = await fd.getTicketFields();
    const schema = buildCategorySchema(fields, config.categoryField);
    schemaCache = { at: Date.now(), schema, fields };
    return schema;
  }

  function fieldLabel(name) {
    const f = schemaCache?.fields?.find((x) => x.name === name);
    return f?.label || name;
  }

  // يحدد المستويات الناقصة والقيم غير الموجودة في القائمة
  function analyzeCompleteness(ticket, schema) {
    const values = schema.levels.map((l) => readField(ticket, l.name));
    const missing = [];
    let invalid = null;
    let node = schema.tree;
    for (let i = 0; i < schema.levels.length; i++) {
      const hasOptions = node && Object.keys(node).length > 0;
      if (!hasOptions) break; // ما فيه مستوى أعمق لهذا الفرع
      const v = values[i];
      if (isEmpty(v)) {
        missing.push(schema.levels[i].label);
        break;
      }
      if (!(v in node)) {
        invalid = { level: schema.levels[i].label, value: v };
        break;
      }
      node = node[v];
    }
    for (const name of config.requiredFields) {
      if (isEmpty(readField(ticket, name))) missing.push(fieldLabel(name));
    }
    const selected = [];
    for (const v of values) {
      if (isEmpty(v)) break;
      selected.push(v);
    }
    return { values, selectedPath: selected.join(" > "), missing, invalid };
  }

  async function agentEmail(id) {
    if (!id) return null;
    try {
      const agent = await fd.getAgent(id);
      return agent?.contact?.email ? { email: agent.contact.email, name: agent.contact.name } : null;
    } catch {
      return null;
    }
  }

  function buildNote({ selectedPath, missing, invalid, ai, wrong, autoFixed }) {
    const lines = ["<div dir=\"rtl\" style=\"font-family:Tahoma,Arial,sans-serif\">", "<b>🤖 تنبيه تصنيف التذكرة</b><br><br>"];
    if (missing.length) lines.push(`⚠️ <b>بيانات ناقصة:</b> ${missing.map(esc).join("، ")}<br>`);
    if (invalid) lines.push(`⚠️ <b>قيمة غير معروفة</b> في «${esc(invalid.level)}»: ${esc(invalid.value)}<br>`);
    lines.push(`📌 <b>التصنيف المختار:</b> ${esc(selectedPath || "(فارغ)")}<br>`);
    if (ai?.suggested_path && (wrong || missing.length || invalid)) {
      lines.push(`✅ <b>التصنيف المقترح:</b> ${esc(ai.suggested_path)} <span style="color:#888">(ثقة ${ai.confidence}%)</span><br>`);
    }
    if (ai?.reason && (wrong || missing.length || invalid)) lines.push(`💡 <b>السبب:</b> ${esc(ai.reason)}<br>`);
    lines.push("<br>");
    lines.push(autoFixed
      ? "تم تصحيح التصنيف تلقائياً. إذا كان التصحيح غير مناسب عدّله يدوياً."
      : "الرجاء تعديل التصنيف في التذكرة. التصنيف الصحيح يوصّل التذكرة للفريق المناسب أسرع ويحسّن التقارير.");
    lines.push("</div>");
    return lines.join("\n");
  }

  function buildReply({ missing, ai }) {
    return [
      "<div dir=\"rtl\">",
      "مرحباً،<br>شكراً لرفع التذكرة. لاحظنا أن تصنيفها يحتاج مراجعة",
      missing.length ? ` (ناقص: ${missing.map(esc).join("، ")})` : "",
      ".<br>",
      ai?.suggested_path ? `التصنيف الأنسب غالباً: <b>${esc(ai.suggested_path)}</b>.<br>` : "",
      "اختيار التصنيف الصحيح عند رفع التذاكر القادمة يساعدنا نخدمك أسرع. 🙏",
      "</div>",
    ].join("");
  }

  function writeLog(entry) {
    try {
      fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
      fs.appendFileSync(config.logFile, JSON.stringify(entry) + "\n");
    } catch (e) {
      log.error("تعذّر كتابة السجل:", e.message);
    }
  }

  return async function checkTicket(ticketId, { force = false } = {}) {
    const ticket = await fd.getTicket(ticketId);
    if (!ticket) return { ticketId, skipped: "not_found" };
    const tags = ticket.tags || [];
    if (!force && tags.includes(config.tags.checked)) return { ticketId, skipped: "already_checked" };

    const schema = await getSchema();
    const { values, selectedPath, missing, invalid } = analyzeCompleteness(ticket, schema);
    const incomplete = missing.length > 0 || !!invalid;

    let ai = null;
    const hasText = (ticket.subject || "").trim() || (ticket.description_text || ticket.description || "").trim();
    if (hasText) ai = await classify({ ticket, schema, selectedPath, incomplete });

    const confident = ai && ai.confidence >= config.minConfidence;
    const wrong = !!(confident && ai.verdict === "incorrect" && ai.suggested_path && ai.suggested_path !== selectedPath);
    const flagged = wrong || incomplete;

    const requester = config.notify.requesterIfAgent || config.notify.replyToRequester
      ? await agentEmail(ticket.requester_id) : null;

    const actions = [];
    let autoFixed = false;
    if (!config.dryRun) {
      const update = { tags: [...new Set([...tags, config.tags.checked,
        ...(wrong || invalid ? [config.tags.wrong] : []),
        ...(missing.length ? [config.tags.incomplete] : [])])] };

      const canFix = config.autoFix && ai?.suggested_path && ai.confidence >= config.autoFixMinConfidence && flagged;
      if (canFix) {
        const parts = ai.suggested_path.split(" > ");
        schema.levels.forEach((lvl, i) => {
          const u = fieldUpdate(lvl.name, parts[i] ?? null);
          if (u.custom_fields) update.custom_fields = { ...(update.custom_fields || {}), ...u.custom_fields };
          else Object.assign(update, u);
        });
        autoFixed = true;
      }
      await fd.updateTicket(ticket.id, update);
      actions.push(autoFixed ? "tagged+autofixed" : "tagged");

      if (flagged) {
        const emails = new Set(config.notify.extraEmails);
        if (config.notify.requesterIfAgent && requester) emails.add(requester.email);
        if (config.notify.responder) {
          const r = await agentEmail(ticket.responder_id);
          if (r) emails.add(r.email);
        }
        await fd.addNote(ticket.id, {
          body: buildNote({ selectedPath, missing, invalid, ai, wrong, autoFixed }),
          notifyEmails: [...emails],
        });
        actions.push(`note(${emails.size} notified)`);

        if (config.notify.replyToRequester && !requester) {
          await fd.reply(ticket.id, buildReply({ missing, ai }));
          actions.push("reply");
        }
      }
    }

    const result = {
      at: new Date().toISOString(),
      ticket_id: ticket.id,
      subject: ticket.subject,
      requester_id: ticket.requester_id,
      requester_name: requester?.name || null,
      responder_id: ticket.responder_id,
      group_id: ticket.group_id,
      selected: values,
      selected_path: selectedPath,
      missing,
      invalid,
      verdict: ai?.verdict || null,
      suggested_path: ai?.suggested_path || null,
      confidence: ai?.confidence ?? null,
      reason: ai?.reason || null,
      flagged,
      wrong,
      incomplete,
      auto_fixed: autoFixed,
      dry_run: config.dryRun,
      actions,
      usage: ai?.usage,
    };
    writeLog(result);
    return result;
  };
}
