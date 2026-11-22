import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const fast = await loadSource("connectors/fast-paths.ts");
const agent = await loadSource("connectors/composio-agent.ts");
const composio = await loadSource("connectors/composio.ts");
const cj = await loadSource("connectors/composio-json.ts");

const KEY = "ck_testKEY1234567890";
const acct = (id, label, isDefault = false) => ({ id, label, status: "active", isDefault });
const gmailAccounts = [acct("ca_1", "work@example.com", true), acct("ca_2", "me@example.com")];

/** A fake Composio that records every call and answers like the real service. */
function fakeComposio({ accounts = { gmail: gmailAccounts, googlecalendar: [acct("ca_c", "cal@example.com", true)], github: [acct("ca_g", "octo", true)] }, handler } = {}) {
  const calls = [];
  return { calls, accountsFor: (t) => accounts[t] ?? [], defaultAccount: (t) => (accounts[t] ?? []).find((a) => a.isDefault) ?? (accounts[t] ?? [])[0] ?? null,
    refreshConnections: async () => {}, connectApp: async (slug) => ({ ok: true, url: `https://connect.composio.dev/link/${slug}` }),
    callJson: async (name, args) => { calls.push([name, args]); const out = await handler(name, args); return { ok: out.ok !== false, json: out.json ?? null, text: JSON.stringify(out.json ?? out.text ?? "") }; } };
}
const multi = (results) => ({ json: { data: { results }, successful: true } });
const ok = (slug, data) => ({ tool_slug: slug, response: { successful: true, data } });

test("which requests the app answers itself, and which it leaves alone", () => {
  assert.equal(fast.detectFastIntent("check my gmail").kind, "gmail");
  assert.deepEqual(fast.detectFastIntent("Try checking my Gmail and tell me what inside the last Gmail").detail.latest, true);
  assert.equal(fast.detectFastIntent("any unread emails?").detail.unread, true);
  assert.equal(fast.detectFastIntent("what's on my calendar tomorrow").detail.window, "tomorrow");
  assert.equal(fast.detectFastIntent("list my github repos").kind, "github");
  for (const no of ["send an email to sam", "check my gmail and email Sam back", "delete the old emails", "reply to the last email", "schedule a meeting tomorrow", "explain recursion"]) assert.equal(fast.detectFastIntent(no), null, no);
});

test("Gmail: every connected account is read, with the account named, and the model is not involved", async () => {
  const c = fakeComposio({ handler: async (name, args) => multi(args.tools.map((t) => ok(t.tool_slug, { messages: [{ subject: `Hello from ${t.account}`, sender: "Ana <ana@x.com>", messageTimestamp: "2026-11-19T10:00:00Z", messageText: "Dinner on Friday? Let me know what works for you." }] }))) });
  const status = [];
  const r = await fast.runFastPath(fast.detectFastIntent("tell me what inside the last Gmail"), { composio: c, status: (s) => status.push(s) });
  assert.match(r.answer, /Your latest email, from each of your 2 Gmail accounts/);
  assert.match(r.answer, /\*\*work@example\.com\*\* \(default\)/); assert.match(r.answer, /\*\*me@example\.com\*\*/);
  assert.match(r.answer, /Hello from ca_1/); assert.match(r.answer, /Dinner on Friday/);
  const [name, args] = c.calls[0];
  assert.equal(name, "COMPOSIO_MULTI_EXECUTE_TOOL");
  assert.deepEqual(args.tools.map((t) => [t.tool_slug, t.account, t.arguments.max_results]), [["GMAIL_FETCH_EMAILS", "ca_1", 1], ["GMAIL_FETCH_EMAILS", "ca_2", 1]]);
});

test("one failing account does not hide the others; not-connected apps get a clear message", async () => {
  const c = fakeComposio({ handler: async (name, args) => multi([ok("GMAIL_FETCH_EMAILS", { messages: [{ subject: "Fine", sender: "x" }] }), { tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: false, error: "token expired" } }]) });
  const r = await fast.runFastPath(fast.detectFastIntent("check my gmail"), { composio: c, status: () => {} });
  assert.match(r.answer, /Fine/); assert.match(r.answer, /could not read this account: token expired/);
  const none = await fast.runFastPath(fast.detectFastIntent("what's on my calendar"), { composio: fakeComposio({ accounts: {}, handler: async () => multi([]) }), status: () => {} });
  assert.match(none.answer, /not connected/i);
});

test("Calendar uses the device's real UTC offset in RFC3339, per account", async () => {
  const c = fakeComposio({ handler: async (name, args) => multi(args.tools.map((t) => ok(t.tool_slug, { items: [{ summary: "Standup", start: { dateTime: "2026-11-20T09:00:00+02:00" }, location: "Room 4" }] }))) });
  const r = await fast.runFastPath(fast.detectFastIntent("what's on my calendar today"), { composio: c, status: () => {}, now: () => new Date(2026, 10, 20, 8, 30, 0) });
  assert.match(r.answer, /Standup/); assert.match(r.answer, /Room 4/);
  const a = c.calls[0][1].tools[0].arguments;
  assert.match(a.timeMin, /^2026-11-20T08:30:00[+-]\d\d:\d\d$/); assert.match(a.timeMax, /^2026-11-20T23:59:59[+-]\d\d:\d\d$/);
  assert.equal(a.singleEvents, true); assert.equal(a.calendarId, "primary");
});

// ---------- guided executor for ANY tool ----------
const SEARCH = (slugs, schemas, extra = {}) => ({ json: { data: { results: [{ primary_tool_slugs: slugs, related_tool_slugs: [], recommended_plan_steps: ["Do the thing"], known_pitfalls: ["Ids are not names"] }], toolkit_connection_statuses: [{ toolkit: slugs[0].split("_")[0].toLowerCase(), has_active_connection: true }], tool_schemas: schemas, session: { id: "sess1" }, ...extra }, successful: true } });
const NOTION_SCHEMA = { NOTION_CREATE_PAGE: { input_schema: { properties: { parent_id: { type: "string", description: "Parent page id" }, title: { type: "string", description: "Page title" } }, required: ["parent_id", "title"] } } };
const scripted = (steps) => { let i = 0; const seen = []; return { complete: async (m) => { seen.push(m); return steps[Math.min(i++, steps.length - 1)]; }, seen }; };
const base = (c, over = {}) => ({ composio: c, approve: async () => "once", askBefore: true, alwaysAllowed: new Set(), status: () => {}, ...over });

test("any tool: search, schema-guided arguments, approval for writes, execution with session, and a repair after an error", async () => {
  let attempt = 0; const approvals = [];
  const c = fakeComposio({ handler: async (name, args) => {
    if (name === "COMPOSIO_SEARCH_TOOLS") return SEARCH(["NOTION_CREATE_PAGE"], NOTION_SCHEMA);
    if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") { attempt++; return attempt === 1 ? multi([{ tool_slug: "NOTION_CREATE_PAGE", response: { successful: false, error: "parent_id is not a valid page id" } }]) : multi([ok("NOTION_CREATE_PAGE", { id: "page_9", url: "https://notion.so/page_9" })]); }
    throw new Error(name);
  } });
  const model = scripted([
    JSON.stringify({ calls: [{ tool_slug: "NOTION_CREATE_PAGE", arguments: { title: "Trip plan" } }] }),                       // missing parent_id → repaired
    JSON.stringify({ calls: [{ tool_slug: "NOTION_CREATE_PAGE", arguments: { parent_id: "bad", title: "Trip plan" } }] }),     // runs, fails
    JSON.stringify({ calls: [{ tool_slug: "NOTION_CREATE_PAGE", arguments: { parent_id: "abc123", title: "Trip plan" } }] }),   // fixed
  ]);
  const r = await agent.runComposioTask("create a Notion page called Trip plan", [], base(c, { complete: model.complete, approve: async (q) => { approvals.push(q); return "once"; } }));
  assert.equal(r.ok, true);
  assert.match(r.context, /page_9/); assert.match(r.context, /untrusted/);
  assert.equal(approvals.length, 2, "each attempt that changes something asks first");
  assert.match(model.seen[0].at(-1).content, /NOTION_CREATE_PAGE: [^\n]*\n\s+args: parent_id\*:string \(Parent page id\); title\*:string/);
  assert.match(model.seen[1].at(-1).content, /required arguments are missing: NOTION_CREATE_PAGE\.parent_id/);
  assert.match(model.seen[2].at(-1).content, /parent_id is not a valid page id/);
  const exec = c.calls.filter((x) => x[0] === "COMPOSIO_MULTI_EXECUTE_TOOL");
  assert.equal(exec[0][1].session_id, "sess1");
  assert.equal(exec.length, 2);
});

test("declining a write stops everything and nothing is executed", async () => {
  const c = fakeComposio({ handler: async (name) => (name === "COMPOSIO_SEARCH_TOOLS" ? SEARCH(["NOTION_CREATE_PAGE"], NOTION_SCHEMA) : (() => { throw new Error("must not execute " + name); })()) });
  const model = scripted([JSON.stringify({ calls: [{ tool_slug: "NOTION_CREATE_PAGE", arguments: { parent_id: "p", title: "t" } }] })]);
  const r = await agent.runComposioTask("create a page", [], base(c, { complete: model.complete, approve: async () => "deny" }));
  assert.equal(r.declined, true); assert.match(r.answer, /did not do it/);
  assert.ok(!c.calls.some((x) => x[0] === "COMPOSIO_MULTI_EXECUTE_TOOL"));
});

test("reads run without asking; 'always allow' is remembered; accounts default sensibly", async () => {
  const schemas = { GITHUB_LIST_REPOSITORY_ISSUES: { input_schema: { properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } } };
  const c = fakeComposio({ handler: async (name, args) => (name === "COMPOSIO_SEARCH_TOOLS" ? SEARCH(["GITHUB_LIST_REPOSITORY_ISSUES"], schemas) : multi([ok("GITHUB_LIST_REPOSITORY_ISSUES", [{ number: 3, title: "Bug" }])])) });
  let asked = 0;
  const model = scripted([JSON.stringify({ calls: [{ tool_slug: "GITHUB_LIST_REPOSITORY_ISSUES", arguments: { owner: "luokai25", repo: "ULTRON" } }] })]);
  const r = await agent.runComposioTask("show open issues in luokai25/ULTRON", [], base(c, { complete: model.complete, approve: async () => { asked++; return "deny"; } }));
  assert.equal(r.ok, true); assert.equal(asked, 0);
  assert.equal(c.calls.at(-1)[1].tools[0].account, "ca_g", "the default account is filled in");
  const always = new Set(); let n = 0;
  const w = fakeComposio({ handler: async (name) => (name === "COMPOSIO_SEARCH_TOOLS" ? SEARCH(["NOTION_CREATE_PAGE"], NOTION_SCHEMA) : multi([ok("NOTION_CREATE_PAGE", { id: "x" })])) });
  const step = () => scripted([JSON.stringify({ calls: [{ tool_slug: "NOTION_CREATE_PAGE", arguments: { parent_id: "p", title: "t" } }] })]);
  await agent.runComposioTask("create page", [], base(w, { complete: step().complete, alwaysAllowed: always, approve: async () => { n++; return "always"; } }));
  await agent.runComposioTask("create page", [], base(w, { complete: step().complete, alwaysAllowed: always, approve: async () => { n++; return "deny"; } }));
  assert.equal(n, 1);
});

test("missing information becomes one question; an app that is not connected gives a sign-in link", async () => {
  const c = fakeComposio({ handler: async () => SEARCH(["NOTION_CREATE_PAGE"], NOTION_SCHEMA) });
  const asks = await agent.runComposioTask("make a page", [], base(c, { complete: scripted([JSON.stringify({ calls: [], ask: "Which page should it go under?" })]).complete }));
  assert.equal(asks.asked, "Which page should it go under?"); assert.match(asks.context, /Ask the owner exactly/);
  const none = fakeComposio({ handler: async () => ({ json: { data: { results: [{ primary_tool_slugs: [] }], toolkit_connection_statuses: [{ toolkit: "slack", has_active_connection: false }] }, successful: true } }) });
  const link = await agent.runComposioTask("post to slack", [], base(none, { complete: scripted(["{}"]).complete }));
  assert.match(link.answer, /slack is not connected yet[^]*https:\/\/connect\.composio\.dev\/link\/slack/);
});

test("garbled model output is retried, then reported plainly instead of crashing", async () => {
  const c = fakeComposio({ handler: async () => SEARCH(["NOTION_CREATE_PAGE"], NOTION_SCHEMA) });
  const r = await agent.runComposioTask("make a page", [], base(c, { complete: scripted(["no json at all"]).complete }));
  assert.equal(r.ok, false); assert.match(r.context, /could not prepare a valid action/);
});

// ---------- manager: connections, accounts, retries ----------
const KEYS = KEY;
function server(onCall) {
  const tools = ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MULTI_EXECUTE_TOOL"].map((name) => ({ name, description: "d", inputSchema: {} }));
  return { calls: [], http: { bytes: async () => ({}), get: async () => { throw 0; }, request: async (m, u, o) => {
    const b = JSON.parse(o.body); const r = (result) => ({ status: 200, url: u, headers: { "mcp-session-id": "s" }, contentType: "application/json", text: JSON.stringify({ jsonrpc: "2.0", id: b.id, result }) });
    if (b.method === "initialize") return r({ serverInfo: { name: "c" } }); if (b.method === "notifications/initialized") return { status: 202, url: u, text: "", contentType: "" };
    if (b.method === "tools/list") return r({ tools }); if (b.method === "tools/call") return r(onCall(b.params));
  } } };
}
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); }, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

test("manager reads real apps and accounts from MANAGE_CONNECTIONS, shows pending sign-ins, and retries with the default account", async () => {
  const seen = [];
  const s = server((p) => {
    seen.push(p);
    if (p.name === "COMPOSIO_MANAGE_CONNECTIONS") {
      const results = {};
      for (const t of p.arguments.toolkits) results[t.name] = t.name === "gmail" ? { toolkit: "gmail", status: "active", accounts: [{ id: "ca_1", status: "ACTIVE", is_default: true, user_info: { email: "a@x.com" } }, { id: "ca_2", status: "ACTIVE", user_info: { email: "b@x.com" } }] } : t.name === "slack" ? { toolkit: "slack", status: "initiated", accounts: [] } : { toolkit: t.name, status: "not_connected", accounts: [] };
      return text({ data: { results }, successful: true });
    }
    if (p.name === "COMPOSIO_MULTI_EXECUTE_TOOL") return p.arguments.tools.some((t) => !t.account) ? text({ successful: false, error: "Multiple accounts found: account selection required" }) : text({ data: { results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [] } } }] }, successful: true });
    return text({ ok: true });
  });
  const m = new composio.ComposioManager({ http: s.http, secrets: mem(), kv: mem() });
  await m.init(); await m.saveKey(KEYS); await new Promise((r) => setTimeout(r, 50));
  const st = m.getState();
  assert.deepEqual(m.accountsFor("gmail").map((a) => [a.id, a.label, a.isDefault]), [["ca_1", "a@x.com", true], ["ca_2", "b@x.com", false]]);
  assert.ok(st.connectedApps.includes("gmail")); assert.ok(!st.connectedApps.includes("slack"), "a pending sign-in is not 'connected'");
  assert.equal(st.apps.slack.status, "initiated");
  assert.equal(m.defaultAccount("gmail").id, "ca_1");
  const r = await m.call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] });
  assert.equal(r.ok, true, "the missing account was filled in and the call retried");
  const sent = seen.filter((p) => p.name === "COMPOSIO_MULTI_EXECUTE_TOOL");
  assert.equal(sent.length, 2); assert.equal(sent[1].arguments.tools[0].account, "ca_1");
});

test("connecting another app returns Composio's sign-in link", async () => {
  const s = server(() => text({ data: { results: { slack: { status: "initiated", redirect_url: "https://connect.composio.dev/link/lk_abc" } } }, successful: true }));
  const m = new composio.ComposioManager({ http: s.http, secrets: mem(), kv: mem() });
  await m.init(); await m.saveKey(KEYS);
  assert.deepEqual(await m.connectApp("Slack"), { ok: true, url: "https://connect.composio.dev/link/lk_abc" });
});

test("JSON helpers find data wherever Composio puts it", () => {
  assert.equal(cj.findObjectArray({ a: { b: [{ x: 1 }, { subject: "s" }] } }, ["subject"]).length, 2);
  assert.equal(cj.deepFind({ x: { y: { session_id: "q" } } }, "session_id"), "q");
  assert.deepEqual(cj.executionResults({ data: { results: [{ tool_slug: "A", response: { successful: false, error: "boom" } }] } }).map((r) => [r.slug, r.ok, r.error]), [["A", false, "boom"]]);
});
