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

test("connections probe uses the tool's own schema and parses chips", async () => {
  const connTool = { name: "COMPOSIO_MANAGE_CONNECTIONS", description: "Manage", inputSchema: { type: "object", required: ["toolkits"], properties: { toolkits: { type: "array", items: { type: "string" } } } } };
  const { s, http } = server({ tools: [connTool] });
  s.onCall = (p) => (Object.keys(p.arguments).length === 0 ? { isError: true, content: [{ type: "text", text: "toolkits required" }] } : { content: [{ type: "text", text: JSON.stringify({ results: [{ toolkit: "gmail", status: "ACTIVE" }, { toolkit: "slack", status: "INITIATED" }] }) }] });
  const m = new composio.ComposioManager({ http, secrets: memSecrets(), kv: memKv() });
  await m.init(); await m.saveKey(KEY);
  await new Promise((r) => setTimeout(r, 30)); // a successful sync probes connections on its own
  assert.deepEqual(s.calls.map((c) => c.arguments), [{}, { toolkits: [] }]);
  assert.deepEqual(composio.parseConnectionChips(m.getState().connections.text), [{ name: "gmail", status: "active" }, { name: "slack", status: "initiated" }]);
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
