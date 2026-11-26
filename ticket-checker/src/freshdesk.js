// عميل بسيط لواجهة Freshdesk API v2
export class FreshdeskClient {
  constructor({ domain, apiKey, baseUrl }) {
    const host = String(domain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.base = baseUrl || `https://${host}/api/v2`;
    this.auth = "Basic " + Buffer.from(`${apiKey}:X`).toString("base64");
  }

  async request(method, path, body, attempt = 0) {
    const res = await fetch(this.base + path, {
      method,
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") || 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, path, body, attempt + 1);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Freshdesk ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? {} : res.json();
  }

  getTicket(id) { return this.request("GET", `/tickets/${id}`); }
  getTicketFields() { return this.request("GET", `/ticket_fields`); }
  getAgent(id) { return this.request("GET", `/agents/${id}`); }
  updateTicket(id, data) { return this.request("PUT", `/tickets/${id}`, data); }
  addNote(id, { body, notifyEmails = [] }) {
    const payload = { body, private: true };
    if (notifyEmails.length) payload.notify_emails = notifyEmails;
    return this.request("POST", `/tickets/${id}/notes`, payload);
  }
  reply(id, body) { return this.request("POST", `/tickets/${id}/reply`, { body }); }
}

// ---------- شجرة التصنيفات ----------

// يحوّل خيارات الحقل (بأي شكل ترجعه Freshdesk) إلى شجرة: { "اسم": { ...أبناء } }
function choicesToTree(choices) {
  if (!choices) return {};
  if (Array.isArray(choices)) {
    const tree = {};
    for (const c of choices) {
      if (typeof c === "string") tree[c] = {};
      else if (c && typeof c === "object") {
        const name = c.value ?? c.label ?? c.name;
        if (name != null) tree[name] = choicesToTree(c.choices);
      }
    }
    return tree;
  }
  if (typeof choices === "object") {
    const tree = {};
    for (const [k, v] of Object.entries(choices)) tree[k] = choicesToTree(v);
    return tree;
  }
  return {};
}

/**
 * يبني وصف التصنيف من تعريف الحقول.
 * يرجع: { levels: [{name,label}], tree, paths: ["أ > ب > ج", ...] }
 */
export function buildCategorySchema(fields, categoryField) {
  const top = fields.find((f) => f.name === categoryField);
  if (!top) {
    const names = fields.map((f) => f.name).join(", ");
    throw new Error(`ما لقيت الحقل "${categoryField}" في Freshdesk. الحقول المتاحة: ${names}`);
  }
  const levels = [{ name: top.name, label: top.label_for_customers || top.label || top.name }];
  for (const n of [...(top.nested_ticket_fields || [])].sort((a, b) => a.level - b.level)) {
    levels.push({ name: n.name, label: n.label_in_portal || n.label || n.name });
  }
  const tree = choicesToTree(top.choices);
  const paths = [];
  const walk = (node, prefix) => {
    const keys = Object.keys(node);
    if (!keys.length || prefix.length >= levels.length) {
      if (prefix.length) paths.push(prefix.join(" > "));
      return;
    }
    for (const k of keys) walk(node[k], [...prefix, k]);
  };
  walk(tree, []);
  return { levels, tree, paths };
}

// يقرأ قيمة حقل من التذكرة (الافتراضية أو المخصصة)
export function readField(ticket, name) {
  if (name === "ticket_type") return ticket.type ?? null;
  if (name in ticket && !name.startsWith("cf_")) return ticket[name] ?? null;
  return ticket.custom_fields?.[name] ?? null;
}

// يكتب قيمة حقل بصيغة جاهزة لـ PUT /tickets
export function fieldUpdate(name, value) {
  if (name === "ticket_type") return { type: value };
  if (!name.startsWith("cf_")) return { [name]: value };
  return { custom_fields: { [name]: value } };
}
