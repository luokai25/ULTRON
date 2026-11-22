import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const mcp = await loadSource("connectors/mcp-client.ts");
const loop = await loadSource("connectors/agent-loop.ts");
const composio = await loadSource("connectors/composio.ts");

const KEY = "ck_testKEY1234567890";

/** A scripted Streamable-HTTP MCP server. Tools can be changed between syncs, like adding an app in Composio. */
function server(opts = {}) {
  const s = { tools: opts.tools ?? [{ name: "COMPOSIO_SEARCH_TOOLS", description: "Find tools", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }], calls: [], inits: 0, sessions: new Set(), expireNext: false, down: false, sse: opts.sse ?? false, pageSize: opts.pageSize ?? 100 };
  const http = {
    bytes: async () => ({}), get: async () => { throw new Error("no get"); },
    request: async (method, url, o) => {
      if (s.down) throw new Error("network down");
      assert.equal(method, "POST"); assert.equal(url, "https://connect.composio.dev/mcp");
      if (o.headers["x-consumer-api-key"] !== KEY) return { status: 401, url, contentType: "application/json", text: "{}" };
      const body = JSON.parse(o.body);
      const reply = (result, headers = {}) => ({ status: 200, url, headers, contentType: s.sse ? "text/event-stream" : "application/json", text: s.sse ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n` : JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
      if (body.method === "initialize") { s.inits++; const id = `sess-${s.inits}`; s.sessions.add(id); return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "composio-connect", version: "1" }, capabilities: {} }, { "mcp-session-id": id }); }
      if (body.method === "notifications/initialized") return { status: 202, url, contentType: "", text: "" };
      if (!s.sessions.has(o.headers["Mcp-Session-Id"]) || s.expireNext) { s.expireNext = false; s.sessions.clear(); return { status: 404, url, contentType: "", text: "" }; }
      if (body.method === "tools/list") { const start = Number(body.params?.cursor ?? 0); const page = s.tools.slice(start, start + s.pageSize); return reply({ tools: page, ...(start + s.pageSize < s.tools.length ? { nextCursor: String(start + s.pageSize) } : {}) }); }
      if (body.method === "tools/call") { s.calls.push(body.params); const handler = s.onCall?.(body.params); return reply(handler ?? { content: [{ type: "text", text: `ran ${body.params.name}` }] }); }
      return { status: 200, url, contentType: "application/json", text: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }) };
    },
  };
  return { s, http };
}

const memSecrets = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); }, m }; };
const memKv = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const tool = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} }, ...extra });

test("handshake, session id, SSE replies and paginated tool listing", async () => {
  const { s, http } = server({ sse: true, pageSize: 2, tools: ["A_ONE", "A_TWO", "B_THREE", "B_FOUR", "C_FIVE"].map((n) => tool(n)) });
  const client = new mcp.McpClient({ url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": KEY }, http });
  const tools = await client.listTools();
  assert.equal(tools.length, 5);
  assert.equal(client.serverInfo.name, "composio-connect");
  assert.equal(s.inits, 1);
  const r = await client.callTool("A_ONE", { x: 1 });
  assert.deepEqual([r.isError, r.text], [false, "ran A_ONE"]);
});

test("an expired session is re-established once, transparently", async () => {
  const { s, http } = server();
  const client = new mcp.McpClient({ url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": KEY }, http });
  await client.listTools();
  s.expireNext = true;
  await client.listTools();
  assert.equal(s.inits, 2);
});

test("a wrong key is reported as an auth problem, not a crash", async () => {
  const { http } = server();
  const client = new mcp.McpClient({ url: "https://connect.composio.dev/mcp", headers: { "x-consumer-api-key": "ck_wrongwrongwrong" }, http });
  await assert.rejects(client.listTools(), (e) => e.kind === "auth" && /API key/.test(e.message));
});

test("manager: key validation, secure storage, connect, and the key never lands in the cache", async () => {
  const { http } = server();
  const secrets = memSecrets(); const kv = memKv();
  const m = new composio.ComposioManager({ http, secrets, kv });
  await m.init();
  assert.equal(m.getState().status, "no-key");
  assert.equal((await m.saveKey("not-a-key")).ok, false);
  assert.equal((await m.saveKey("ck_wrongwrongwrong")).ok, false);
  assert.equal(m.getState().status, "error");
  const ok = await m.saveKey(`  ${KEY}  `);
  assert.equal(ok.ok, true);
  assert.equal(m.getState().status, "connected");
  assert.equal(m.getState().tools.length, 1);
  assert.equal([...secrets.m.values()][0], KEY, "stored in secure storage");
  assert.ok(![...kv.m.values()].some((v) => v.includes(KEY)), "never written to plain storage");
  assert.ok(!m.getState().keyHint.includes("testKEY12345"), "only a masked hint is shown");
});

test("manager follows Composio: tools added or removed show up on the next sync, offline keeps the last list", async () => {
  const { s, http } = server({ tools: [tool("COMPOSIO_SEARCH_TOOLS")] });
  const secrets = memSecrets(); const kv = memKv();
  const m = new composio.ComposioManager({ http, secrets, kv });
  await m.init(); await m.saveKey(KEY);
  const events = []; m.subscribe((_st, change) => events.push(change));
  s.tools = [tool("COMPOSIO_SEARCH_TOOLS"), tool("GMAIL_FETCH_EMAILS"), tool("GMAIL_SEND_EMAIL"), tool("SLACK_SEND_MESSAGE")];
  await m.sync("test");
  assert.deepEqual(m.getState().groups.map((g) => [g.id, g.count]), [["GMAIL", 2], ["SLACK", 1], ["COMPOSIO", 1]]);
  assert.ok(events.includes("tools"));
  s.tools = [tool("COMPOSIO_SEARCH_TOOLS"), tool("SLACK_SEND_MESSAGE")];
  await m.sync("test");
  assert.deepEqual(m.getState().groups.map((g) => g.id), ["SLACK", "COMPOSIO"], "a removed connector disappears");
  s.down = true;
  await m.sync("test");
  assert.equal(m.getState().status, "connected", "offline: keep showing what was last known");
  assert.match(m.getState().error, /network/i);
  // a fresh manager (app restart) shows the cached tools immediately, before any network call
  s.down = true;
  const m2 = new composio.ComposioManager({ http, secrets, kv });
  await m2.init();
  assert.equal(m2.getState().tools.length, 2);
  s.down = false; await m2.sync("again");
  await m.removeKey();
  assert.equal(m.getState().status, "no-key");
  assert.equal(secrets.m.size, 0);
});

// ---------- tool loop ----------
const scripted = (steps) => { let i = 0; const seen = []; return { complete: async (messages) => { seen.push(messages); return steps[Math.min(i++, steps.length - 1)]; }, seen }; };
const call = (name, args = {}) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

test("approval policy: reads run freely, writes and wrapped writes ask first", () => {
  const n = (name, args = {}, t) => loop.needsApproval(t, name, args);
  assert.equal(n("GMAIL_FETCH_EMAILS"), false);
  assert.equal(n("GITHUB_LIST_ISSUES"), false);
  assert.equal(n("COMPOSIO_SEARCH_TOOLS"), false);
  assert.equal(n("GMAIL_SEND_EMAIL"), true);
  assert.equal(n("SLACK_SEND_MESSAGE"), true);
  assert.equal(n("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] }), false);
  assert.equal(n("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL" }] }), true);
  assert.equal(n("COMPOSIO_MULTI_EXECUTE_TOOL", {}), true);
  assert.equal(n("SOME_ODD_THING", {}, { annotations: { readOnlyHint: true } }), false);
});

test("loop: runs read tools, asks before writes, honours deny and remembers 'always'", async () => {
  const tools = [tool("GMAIL_FETCH_EMAILS"), tool("GMAIL_SEND_EMAIL")];
  const executed = []; const asked = [];
  const execute = async (name, args) => { executed.push(name); return { ok: true, text: `result of ${name}` }; };
  const a = scripted([call("GMAIL_FETCH_EMAILS", { max: 3 }), `<final>You have 3 emails.</final>`]);
  const r1 = await loop.runToolLoop("what's in my inbox", [], tools, { complete: a.complete, execute, approve: async (q) => { asked.push(q); return "deny"; } });
  assert.deepEqual(executed, ["GMAIL_FETCH_EMAILS"]); assert.equal(asked.length, 0);
  assert.equal(r1.final, "You have 3 emails.");
  assert.match(a.seen[1].at(-1).content, /TOOL RESULT for GMAIL_FETCH_EMAILS[^]*untrusted/);

  const b = scripted([call("GMAIL_SEND_EMAIL", { to: "x@y.z" }), `<final>I could not send it.</final>`]);
  const r2 = await loop.runToolLoop("email x@y.z hi", [], tools, { complete: b.complete, execute, approve: async (q) => { asked.push(q); return "deny"; } });
  assert.equal(executed.includes("GMAIL_SEND_EMAIL"), false, "a denied write never runs");
  assert.equal(asked.length, 1); assert.deepEqual(r2.denied.length, 1);

  const always = new Set();
  const c = scripted([call("GMAIL_SEND_EMAIL", { to: "x@y.z" }), `<final>Sent.</final>`]);
  await loop.runToolLoop("email x@y.z hi", [], tools, { complete: c.complete, execute, approve: async () => "always", alwaysAllowed: always });
  assert.ok(executed.includes("GMAIL_SEND_EMAIL")); assert.ok(always.has("GMAIL_SEND_EMAIL"));
  const askedBefore = asked.length;
  await loop.runToolLoop("again", [], tools, { complete: scripted([call("GMAIL_SEND_EMAIL", {}), "<final>ok</final>"]).complete, execute, approve: async (q) => { asked.push(q); return "deny"; }, alwaysAllowed: always });
  assert.equal(asked.length, askedBefore, "'always allow' is remembered");
  await loop.runToolLoop("x", [], tools, { complete: scripted([call("GMAIL_SEND_EMAIL", {}), "<final>ok</final>"]).complete, execute, approve: async (q) => { asked.push(q); return "deny"; }, askBefore: false });
});

test("loop: unknown tools are corrected, failures reported, rounds are capped, no-tool replies pass through", async () => {
  const tools = [tool("A_GET_THING")];
  const exec = async () => ({ ok: false, text: "HTTP 500" });
  const r = await loop.runToolLoop("x", [], tools, { complete: scripted([call("NOT_A_TOOL"), call("A_GET_THING"), "<final>It failed.</final>"]).complete, execute: exec });
  assert.deepEqual(r.runs.map((x) => [x.name, x.ok]), [["A_GET_THING", false]]);
  const capped = await loop.runToolLoop("x", [], tools, { complete: scripted([call("A_GET_THING")]).complete, execute: async () => ({ ok: true, text: "again" }) }, 3);
  assert.equal(capped.stoppedReason, "limit"); assert.equal(capped.runs.length, 3);
  const plain = await loop.runToolLoop("hello", [], tools, { complete: scripted(["Hi there, no tools needed."]).complete, execute: exec });
  assert.equal(plain.final, "Hi there, no tools needed."); assert.equal(plain.stoppedReason, "no-tools");
  assert.match(loop.loopContext(capped), /untrusted/);
});

test("parser accepts sloppy model output and routing only triggers for app-related requests", () => {
  assert.deepEqual(loop.parseStep('Sure!\n<tool_call>{"name":"X","arguments":{"a":1,}}</tool_call>').call, { name: "X", arguments: { a: 1 } });
  assert.deepEqual(loop.parseStep('<tool_call>{"tool":"Y","args":{}}</tool_call>').call, { name: "Y", arguments: {} });
  assert.equal(loop.parseStep("<final>done").final, "done");
  for (const yes of ["check my gmail inbox", "what's on my calendar tomorrow", "create a github issue for the login bug", "use composio to list my notion pages", "post this to slack"]) assert.equal(loop.wantsConnectors(yes), true, yes);
  for (const no of ["explain photosynthesis", "write a poem about rain", "what is 12 times 9"]) assert.equal(loop.wantsConnectors(no), false, no);
});

test("built-in key: connects with no setup, can be turned off and on, and an own key overrides it", async () => {
  const { s, http } = server({ tools: [tool("COMPOSIO_SEARCH_TOOLS"), tool("GMAIL_FETCH_EMAILS")] });
  const secrets = memSecrets(); const kv = memKv();
  const m = new composio.ComposioManager({ http, secrets, kv, builtInKey: KEY });
  await m.init();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.getState().status, "connected", "connected with no key entered");
  assert.equal(m.getState().keySource, "built-in");
  assert.equal(m.getState().tools.length, 2);
  assert.equal(secrets.m.size, 0, "the built-in key is never copied into storage");
  assert.ok(![...kv.m.values()].some((v) => v.includes(KEY)));
  await m.disconnect();
  assert.equal(m.getState().status, "no-key");
  const again = new composio.ComposioManager({ http, secrets, kv, builtInKey: KEY });
  await again.init();
  assert.equal(again.getState().status, "no-key", "turning it off persists across restarts");
  await again.enableBuiltIn(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(again.getState().status, "connected");
  // an owner-provided key takes precedence, and removing it falls back to the built-in one
  const bad = await again.saveKey("ck_wrongwrongwrong");
  assert.equal(bad.ok, false);
  await again.removeKey(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(again.getState().keySource, "built-in"); assert.equal(again.getState().status, "connected");
  assert.equal(new composio.ComposioManager({ http, secrets, kv, builtInKey: "garbage" }).hasBuiltIn(), false);
  void s;
});

// ---------- real-service knowledge ----------
const REAL_DESC = "Tool Server Info: Composio connects 500+ apps.\n  - User has manually connected the apps: agent_mail, amazon, brave_search, github, gmail, googlecalendar, googledrive, linear, notion, vercel, youtube, zoom. Prefer these apps when intent is unclear.\n\nSplitting guidelines (Important):\n  1. Atomic queries.";

test("the connected-app list is read from Composio's own tool description", () => {
  const apps = composio.parseConnectedApps([{ name: "COMPOSIO_SEARCH_TOOLS", description: REAL_DESC }, { name: "OTHER", description: "nothing" }]);
  assert.deepEqual(apps, ["agent_mail", "amazon", "brave_search", "github", "gmail", "googlecalendar", "googledrive", "linear", "notion", "vercel", "youtube", "zoom"], "the last app is not lost to the sentence after the list");
  assert.deepEqual(composio.parseConnectedApps([{ name: "X", description: "no list here" }]), []);
});

test("adding or removing an app in Composio changes the state and fires a tools event on the next sync", async () => {
  const mk = (list) => [{ name: "COMPOSIO_SEARCH_TOOLS", description: `x\n  - User has manually connected the apps: ${list}. Prefer these apps.\n`, inputSchema: {} }];
  const { s, http } = server({ tools: mk("gmail, github") });
  const m = new composio.ComposioManager({ http, secrets: memSecrets(), kv: memKv() });
  await m.init(); await m.saveKey(KEY);
  assert.deepEqual(m.getState().connectedApps, ["gmail", "github"]);
  const events = []; m.subscribe((_st, c) => events.push(c));
  s.tools = mk("gmail, github, notion");
  await m.sync("t");
  assert.deepEqual(m.getState().connectedApps, ["gmail", "github", "notion"]);
  assert.ok(events.includes("tools"), "a same-length tool list still counts as a change when the apps differ");
  s.tools = mk("gmail");
  await m.sync("t");
  assert.deepEqual(m.getState().connectedApps, ["gmail"]);
  const awareness = await loadSource("connectors/awareness.ts");
  assert.deepEqual(awareness.connectedAppNames(m.getState()), ["gmail"]);
});

test("the tool worker is taught the real Composio protocol, with the owner's apps, and no personal data", async () => {
  const pb = await loadSource("connectors/playbook.ts");
  const text = loop.systemPrompt([{ name: "COMPOSIO_SEARCH_TOOLS", description: "d", inputSchema: {} }, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "d", inputSchema: {} }], "check my gmail", ["gmail", "github"]);
  for (const must of ["COMPOSIO_SEARCH_TOOLS", "session_id", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "account_selection", "redirect_url", "nextPageToken", "RFC3339", "gmail, github", "ASK which account"]) assert.ok(text.includes(must), must);
  assert.ok(!/@gmail\.com|luokai|creationslous/i.test(pb.composioPlaybook(["gmail"])), "no personal data in shipped knowledge");
  assert.ok(!loop.systemPrompt([tool("OTHER_TOOL")], "x").includes("COMPOSIO PLAYBOOK"), "only for Composio");
});

test("approval policy covers Composio's meta tools exactly", () => {
  const n = (name, args = {}) => loop.needsApproval(undefined, name, args);
  for (const free of ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_WAIT_FOR_CONNECTIONS", "COMPOSIO_SEARCH_SKILLS"]) assert.equal(n(free, {}), false, free);
  assert.equal(n("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: "gmail", action: "list" }] }), false);
  assert.equal(n("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: "gmail" }] }), false, "add only produces a sign-in link");
  assert.equal(n("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: "gmail", action: "remove", account_id: "x" }] }), true);
  assert.equal(n("COMPOSIO_PROXY_EXECUTE", { method: "GET", endpoint: "/user/repos", toolkit_slug: "github" }), false);
  assert.equal(n("COMPOSIO_PROXY_EXECUTE", { method: "DELETE", endpoint: "/x", toolkit_slug: "github" }), true);
  for (const asks of ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_MANAGE_SKILL", "COMPOSIO_SUBMIT_FEEDBACK"]) assert.equal(n(asks, {}), true, asks);
  const multi = (...slugs) => n("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) });
  assert.equal(multi("GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST", "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", "GITHUB_FIND_REPOSITORIES", "GOOGLECALENDAR_GET_CURRENT_DATE_TIME"), false, "the reads seen in the live service run freely");
  for (const w of ["GMAIL_SEND_EMAIL", "GMAIL_BATCH_MODIFY_MESSAGES", "GMAIL_CREATE_EMAIL_DRAFT", "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", "GOOGLEDRIVE_CREATE_PERMISSION", "NOTION_UPDATE_PAGE", "LINEAR_DELETE_ISSUE", "GITHUB_CREATE_AN_ISSUE", "SLACK_SEND_MESSAGE"]) assert.equal(multi("GMAIL_FETCH_EMAILS", w), true, w);
  assert.equal(multi("UNKNOWN_FROBNICATE_THING"), true, "anything unrecognised asks first");
});
