// AJ's private Follow Up Boss connector for Claude.
// A small MCP server (Streamable HTTP, stateless JSON responses) with no outside dependencies.
//
// Environment variables (set these in Railway, never in code):
//   FUB_API_KEY      Your Follow Up Boss API key (Follow Up Boss: Admin > API)
//   CONNECTOR_TOKEN  A long random string (24+ characters). It becomes part of the connector URL.
//   READ_ONLY        Optional. Set to "true" to turn off every write tool.
//   PORT             Set automatically by Railway.

import http from "node:http";
import crypto from "node:crypto";

const FUB_API_KEY = process.env.FUB_API_KEY || "";
const CONNECTOR_TOKEN = process.env.CONNECTOR_TOKEN || "";
const READ_ONLY = String(process.env.READ_ONLY || "").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 3000);
const FUB_BASE = process.env.FUB_BASE_URL || "https://api.followupboss.com/v1";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

if (!FUB_API_KEY) console.warn("Warning: FUB_API_KEY is not set. Tool calls will fail until it is.");
if (CONNECTOR_TOKEN.length < 24) {
  console.error("CONNECTOR_TOKEN must be set to a random string of at least 24 characters.");
  process.exit(1);
}

/* ---------------- Follow Up Boss API ---------------- */

async function fub(path, { method = "GET", query, body } = {}) {
  const url = new URL(FUB_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(FUB_API_KEY + ":").toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-System": "AJ-Claude-Connector"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.errorMessage || data?.message || text || res.statusText;
    throw new Error(`Follow Up Boss returned ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return data;
}

let meCache = null;
async function me() { if (!meCache) { const m = await fub("/me"); meCache = { id: m.id, name: m.name || [m.firstName, m.lastName].filter(Boolean).join(" "), email: m.email }; } return meCache; }


// Follow Up Boss blocks deep offsets; page with its "next" cursor instead.
async function* pages(path, query) {
  let next = null;
  for (let i = 0; i < 60; i++) {
    const d = await fub(path, { query: next ? { ...query, offset: undefined, next } : query });
    yield d;
    next = d?._metadata?.next || null;
    if (!next) break;
  }
}

const values = (arr) => (Array.isArray(arr) ? arr.map((x) => x?.value).filter(Boolean) : []);
const slimPerson = (p) => p && ({
  id: p.id, name: p.name || [p.firstName, p.lastName].filter(Boolean).join(" "),
  stage: p.stage, source: p.source, assignedTo: p.assignedTo, tags: p.tags || [],
  emails: values(p.emails), phones: values(p.phones), price: p.price,
  lastActivity: p.lastActivity, created: p.created, updated: p.updated
});
const slimNote = (n) => ({ id: n.id, created: n.created, createdBy: n.createdBy, subject: n.subject, body: n.body });
const slimCall = (c) => ({ id: c.id, created: c.created, userName: c.userName, isIncoming: c.isIncoming, duration: c.duration, outcome: c.outcome, note: c.note });
const slimText = (t) => ({ id: t.id, created: t.created, isIncoming: t.isIncoming, message: t.message });
const slimDeal = (d) => d && ({
  id: d.id, name: d.name, status: d.status, pipelineId: d.pipelineId, pipelineName: d.pipelineName,
  stageId: d.stageId, stageName: d.stageName, price: d.price, projectedCloseDate: d.projectedCloseDate,
  commissionValue: d.commissionValue, agentCommission: d.agentCommission, teamCommission: d.teamCommission,
  people: (d.people || []).map((p) => ({ id: p.id, name: p.name })),
  users: (d.users || d.assignedUsers || []).map((u) => ({ id: u.id, name: u.name })), description: d.description,
  enteredStageAt: d.enteredStageAt, createdAt: d.createdAt || d.created, updatedAt: d.updatedAt || d.updated
});

/* ---------------- Input checks ---------------- */

class InputError extends Error {}
function need(args, key, type, { optional = false, min, max, pattern, oneOf } = {}) {
  const v = args?.[key];
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw new InputError(`Missing required "${key}".`);
  }
  if (type === "integer" && !Number.isInteger(v)) throw new InputError(`"${key}" must be a whole number.`);
  if (type === "string" && typeof v !== "string") throw new InputError(`"${key}" must be text.`);
  if (type === "boolean" && typeof v !== "boolean") throw new InputError(`"${key}" must be true or false.`);
  if (type === "integer" && min !== undefined && v < min) throw new InputError(`"${key}" must be at least ${min}.`);
  if (type === "integer" && max !== undefined && v > max) throw new InputError(`"${key}" must be at most ${max}.`);
  if (type === "string" && max !== undefined && v.length > max) throw new InputError(`"${key}" is too long (max ${max} characters).`);
  if (type === "string" && pattern && !pattern.test(v)) throw new InputError(`"${key}" is not in the expected format.`);
  if (oneOf && !oneOf.includes(v)) throw new InputError(`"${key}" must be one of: ${oneOf.join(", ")}.`);
  return v;
}

/* ---------------- Tools ---------------- */

const OUTCOMES = ["Interested", "Not Interested", "Left Message", "No Answer", "Busy", "Bad Number"];
const personId = { type: "integer", description: "Follow Up Boss contact id (from search_people)" };

const tools = [
  {
    name: "search_people",
    description: "Search AJ's Follow Up Boss contacts by name, email or phone. Returns id, stage, contact info and last activity, most recently active first.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Name, email or phone" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const d = await fub("/people", { query: { q: need(a, "query", "string", { max: 200 }), limit: need(a, "limit", "integer", { optional: true, min: 1, max: 50 }) || 10, sort: "-lastActivity" } });
      return (d.people || []).map(slimPerson);
    }
  },
  {
    name: "get_person",
    description: "Get one Follow Up Boss contact by id.",
    inputSchema: { type: "object", properties: { personId }, required: ["personId"] },
    annotations: { readOnlyHint: true },
    run: async (a) => slimPerson(await fub(`/people/${need(a, "personId", "integer")}`))
  },
  {
    name: "get_recent_activity",
    description: "A contact's recent notes, calls and texts from Follow Up Boss (newest first) plus latestTouch, the date of the most recent one.",
    inputSchema: { type: "object", properties: { personId, limit: { type: "integer", minimum: 1, maximum: 25 } }, required: ["personId"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const q = { personId: need(a, "personId", "integer"), limit: need(a, "limit", "integer", { optional: true, min: 1, max: 25 }) || 10, sort: "-created" };
      const [notes, calls, texts] = await Promise.allSettled([fub("/notes", { query: q }), fub("/calls", { query: q }), fub("/textMessages", { query: q })]);
      const take = (r, key, alt, fn) => r.status === "fulfilled" ? (r.value[key] || r.value[alt] || []).map(fn) : { error: r.reason?.message };
      const out = { notes: take(notes, "notes", "notes", slimNote), calls: take(calls, "calls", "calls", slimCall), texts: take(texts, "textmessages", "textMessages", slimText) };
      const dates = [out.notes, out.calls, out.texts].flatMap((x) => (Array.isArray(x) ? x.map((i) => i.created) : [])).filter(Boolean).sort();
      out.latestTouch = dates.at(-1) || null;
      return out;
    }
  },
  {
    name: "recent_calls",
    description: "Calls logged in Follow Up Boss across all contacts since a date (newest first), with the contact's name and any call notes. Use it to see what AJ logged.",
    inputSchema: { type: "object", properties: { since: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["since"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const since = need(a, "since", "string", { pattern: /^\d{4}-\d{2}-\d{2}$/ });
      const max = need(a, "limit", "integer", { optional: true, min: 1, max: 200 }) || 100;
      const out = [];
      for await (const d of pages("/calls", { sort: "-created", limit: 100 })) {
        const page = d.calls || [];
        for (const c of page) { if ((c.created || "") < since) return out; out.push({ ...slimCall(c), personId: c.personId, name: c.name || c.personName }); if (out.length >= max) break; }
        if (page.length < 100) break;
      }
      return out;
    }
  },
  {
    name: "recent_notes",
    description: "Notes added in Follow Up Boss across all contacts since a date (newest first).",
    inputSchema: { type: "object", properties: { since: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["since"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const since = need(a, "since", "string", { pattern: /^\d{4}-\d{2}-\d{2}$/ });
      const max = need(a, "limit", "integer", { optional: true, min: 1, max: 200 }) || 100;
      const out = [];
      for await (const d of pages("/notes", { sort: "-created", limit: 100 })) {
        const page = d.notes || [];
        for (const n of page) { if ((n.created || "") < since) return out; out.push({ ...slimNote(n), personId: n.personId }); if (out.length >= max) break; }
        if (page.length < 100) break;
      }
      return out;
    }
  },
  {
    name: "list_smart_lists",
    description: "AJ's Follow Up Boss smart lists (id and name), e.g. his 30/60/90-day sphere lists. Optionally filter by part of the name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Only lists whose name contains this text (case-insensitive), e.g. \"sphere\"" } } },
    annotations: { readOnlyHint: true },
    run: async (a = {}) => {
      // all=true asks Follow Up Boss for every smart list on the account, not only the
      // ones visible to the API key's user, so personal lists like "30 Day Sphere" show up.
      const seen = new Map();
      for (let offset = 0; offset < 1000; offset += 100) {
        const d = await fub("/smartLists", { query: { limit: 100, offset, all: true } });
        const page = d.smartlists || d.smartLists || [];
        for (const s of page) if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name });
        if (page.length < 100) break;
      }
      const filter = typeof a.name === "string" ? a.name.trim().toLowerCase() : "";
      const lists = [...seen.values()];
      return filter ? lists.filter((s) => String(s.name || "").toLowerCase().includes(filter)) : lists;
    }
  },
  {
    name: "smart_list_people",
    description: "The people currently in one Follow Up Boss smart list (who's due for follow-up), with last activity. AJ is an admin, so lists show the whole team: pass mine=true to get only people assigned to AJ.",
    inputSchema: { type: "object", properties: { smartListId: { type: "integer" }, mine: { type: "boolean", description: "Only people assigned to AJ (the API key's user)" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["smartListId"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const id = need(a, "smartListId", "integer");
      const max = need(a, "limit", "integer", { optional: true, min: 1, max: 200 }) || 100;
      const mine = need(a, "mine", "boolean", { optional: true });
      if (!mine) {
        const out = []; let total = null;
        for (let offset = 0; offset < max; offset += 100) {
          const d = await fub("/people", { query: { smartListId: id, limit: Math.min(100, max - offset), offset, sort: "lastActivity" } });
          total = d._metadata?.total ?? total;
          const page = d.people || [];
          out.push(...page.map(slimPerson));
          if (page.length < 100) break;
        }
        return { total: total ?? out.length, people: out };
      }
      // mine=true: ask Follow Up Boss to filter by assigned user, and also check each person
      // ourselves, so the result is right even if the API ignores the filter. We scan the
      // whole list (up to 5,000 people) so the total counts only AJ's people.
      const self = await me();
      const isMine = (p) => p.assignedUserId === self.id ||
        (p.assignedTo && self.name && String(p.assignedTo).toLowerCase() === self.name.toLowerCase());
      const out = []; let count = 0; let scanned = 0; let complete = false;
      for (let offset = 0; offset < 5000; offset += 100) {
        const d = await fub("/people", { query: { smartListId: id, assignedUserId: self.id, limit: 100, offset, sort: "lastActivity" } });
        const page = d.people || [];
        scanned += page.length;
        for (const p of page) if (isMine(p)) { count++; if (out.length < max) out.push(slimPerson(p)); }
        if (page.length < 100) { complete = true; break; }
      }
      return { assignedTo: self.name, total: count, totalIsExact: complete, scanned, people: out };
    }
  },
  {
    name: "list_pipelines",
    description: "Follow Up Boss deal pipelines and their stages (ids and names).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const d = await fub("/pipelines", { query: { limit: 100 } });
      return (d.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) }));
    }
  },
  {
    name: "list_deals",
    description: "Follow Up Boss deals with stage, price, close date, commission, people and assigned agents. This account is shared with AJ's team: pass mine=true to get only deals AJ is assigned to. Optionally filter by pipeline or person.",
    inputSchema: { type: "object", properties: { mine: { type: "boolean", description: "Only deals assigned to AJ (the API key's user)" }, pipelineId: { type: "integer" }, personId, status: { type: "string", enum: ["Active", "Archived"] }, limit: { type: "integer", minimum: 1, maximum: 3000 } } },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const max = need(a, "limit", "integer", { optional: true, min: 1, max: 3000 }) || 500;
      const mine = need(a, "mine", "boolean", { optional: true });
      const q = { pipelineId: need(a, "pipelineId", "integer", { optional: true }), personId: need(a, "personId", "integer", { optional: true }), status: need(a, "status", "string", { optional: true, oneOf: ["Active", "Archived"] }) };
      const self = mine ? await me() : null;
      const out = [];
      for await (const d of pages("/deals", { ...q, limit: 100, sort: "-updated" })) {
        for (const raw of d.deals || []) {
          const deal = slimDeal(raw);
          if (self && !deal.users.some((u) => u.id === self.id || (u.name && self.name && u.name.toLowerCase() === self.name.toLowerCase()))) continue;
          out.push(deal); if (out.length >= max) break;
        }
        if (out.length >= max || (d.deals || []).length < 100) break;
      }
      return out;
    }
  },
  {
    name: "whoami",
    description: "The Follow Up Boss user this connector acts as (AJ): id, name, email.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => me()
  },
  {
    name: "get_deal",
    description: "One Follow Up Boss deal by id, including every field Follow Up Boss returns.",
    inputSchema: { type: "object", properties: { dealId: { type: "integer" } }, required: ["dealId"] },
    annotations: { readOnlyHint: true },
    run: async (a) => fub(`/deals/${need(a, "dealId", "integer")}`)
  },
  {
    name: "save_deal",
    description: "Create a deal (no dealId) or update one (dealId) in Follow Up Boss. New deals are assigned to AJ. Only the fields you pass are changed.",
    inputSchema: { type: "object", properties: {
      dealId: { type: "integer" }, name: { type: "string", maxLength: 200 }, stageId: { type: "integer" },
      price: { type: "number" }, projectedCloseDate: { type: "string", description: "YYYY-MM-DD" },
      commissionValue: { type: "number", description: "AJ's gross commission in dollars" },
      peopleIds: { type: "array", items: { type: "integer" } }, description: { type: "string", maxLength: 2000 },
      status: { type: "string", enum: ["Active", "Archived"], description: "Archive a duplicate deal (reversible) or restore one" }
    } },
    write: true,
    run: async (a) => {
      const body = {};
      const dealId = need(a, "dealId", "integer", { optional: true });
      const name = need(a, "name", "string", { optional: true, max: 200 }); if (name) body.name = name;
      const stageId = need(a, "stageId", "integer", { optional: true }); if (stageId) body.stageId = stageId;
      for (const k of ["price", "commissionValue"]) { if (a[k] !== undefined && a[k] !== null) { if (typeof a[k] !== "number" || a[k] < 0) throw new InputError(`"${k}" must be a positive number.`); body[k] = a[k]; } }
      const close = need(a, "projectedCloseDate", "string", { optional: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }); if (close) body.projectedCloseDate = close;
      const desc = need(a, "description", "string", { optional: true, max: 2000 }); if (desc) body.description = desc;
      const st = need(a, "status", "string", { optional: true, oneOf: ["Active", "Archived"] }); if (st) body.status = st;
      if (Array.isArray(a.peopleIds)) { if (!a.peopleIds.every(Number.isInteger)) throw new InputError('"peopleIds" must be whole numbers.'); body.peopleIds = a.peopleIds; }
      if (!dealId && (!body.name || !body.stageId)) throw new InputError("A new deal needs a name and a stageId.");
      if (!dealId) body.userIds = [(await me()).id]; // new deals are always assigned to AJ
      if (dealId && !Object.keys(body).length) throw new InputError("Nothing to change.");
      return slimDeal(await fub(dealId ? `/deals/${dealId}` : "/deals", { method: dealId ? "PUT" : "POST", body }));
    }
  },
  {
    name: "add_note",
    description: "Add a note to a contact in Follow Up Boss.",
    inputSchema: { type: "object", properties: { personId, subject: { type: "string", maxLength: 200 }, body: { type: "string", maxLength: 5000 } }, required: ["personId", "body"] },
    write: true,
    run: async (a) => slimNote(await fub("/notes", { method: "POST", body: {
      personId: need(a, "personId", "integer"), subject: need(a, "subject", "string", { optional: true, max: 200 }) || "Note from Claude", body: need(a, "body", "string", { max: 5000 })
    } }))
  },
  {
    name: "log_call",
    description: "Log a phone call AJ made or received with a contact in Follow Up Boss. Uses the contact's first phone number if none is given.",
    inputSchema: { type: "object", properties: {
      personId, note: { type: "string", maxLength: 5000, description: "What was discussed" },
      outcome: { type: "string", enum: OUTCOMES }, isIncoming: { type: "boolean" }, phone: { type: "string" }
    }, required: ["personId", "note"] },
    write: true,
    run: async (a) => {
      const id = need(a, "personId", "integer");
      const note = need(a, "note", "string", { max: 5000 });
      const outcome = need(a, "outcome", "string", { optional: true, oneOf: OUTCOMES });
      const isIncoming = Boolean(need(a, "isIncoming", "boolean", { optional: true }));
      let phone = need(a, "phone", "string", { optional: true, max: 40 });
      if (!phone) phone = values((await fub(`/people/${id}`)).phones)[0];
      if (!phone) throw new InputError("This contact has no phone number in Follow Up Boss. Use add_note instead, or pass a phone number.");
      return slimCall(await fub("/calls", { method: "POST", body: { personId: id, phone, note, outcome, isIncoming, duration: 0 } }));
    }
  }
];
const byName = new Map(tools.map((t) => [t.name, t]));

/* ---------------- MCP JSON-RPC ---------------- */

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null; // notifications/initialized, cancellations, etc.

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "follow-up-boss", title: "Follow Up Boss", version: "1.2.0" },
        instructions: "Tools for AJ Pettersen's own Follow Up Boss account. Look people up with search_people before using an id." + (READ_ONLY ? " Read-only mode: write tools are turned off." : "")
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: tools.filter((t) => !(t.write && READ_ONLY)).map(({ name, description, inputSchema, annotations, write }) => ({
        name, description, inputSchema, annotations: annotations || { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
      })) });
    case "tools/call": {
      const tool = byName.get(msg.params?.name);
      if (!tool || (tool.write && READ_ONLY)) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const data = await tool.run(msg.params?.arguments || {});
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return rpcResult(msg.id, { isError: true, content: [{ type: "text", text: e instanceof InputError ? e.message : String(e?.message || e) }] });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/* ---------------- HTTP ---------------- */

const expected = Buffer.from("/mcp/" + CONNECTOR_TOKEN);
const pathOk = (p) => { const got = Buffer.from(p); return got.length === expected.length && crypto.timingSafeEqual(got, expected); };
const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
  if (req.method === "GET" && (path === "" || path === "/")) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("Follow Up Boss connector is running."); }
  if (!pathOk(path)) return send(res, 404, { error: "Not found" });
  if (req.method !== "POST") return send(res, 405, rpcError(null, -32000, "Method not allowed."), { Allow: "POST" });

  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return send(res, 413, rpcError(null, -32600, "Request too large")); }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, rpcError(null, -32700, "Parse error")); }

  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202);
    }
    const out = await handle(body);
    return out ? send(res, 200, out) : send(res, 202);
  } catch (e) {
    console.error(e);
    return send(res, 500, rpcError(body?.id, -32603, "Internal error"));
  }
});

server.listen(PORT, () => console.log(`Follow Up Boss connector listening on ${PORT}${READ_ONLY ? " (read-only)" : ""}`));
