import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const ct = await loadSource("connectors/chat-tools.ts");

const article = (t) => `<html><head><title>${t}</title></head><body><article>${"<p>The new battery plant opened in 2026 and will employ 1500 workers, officials said on Tuesday. </p>".repeat(10)}</article></body></html>`;
const makeHttp = (log = []) => ({
  bytes: async () => ({}),
  get: async (url) => {
    log.push(url);
    if (url.includes("duckduckgo")) return { status: 200, url, contentType: "text/html", text: `<a class="result__a" href="https://news1.example/a">Battery plant opens</a><a class="result__snippet">snip one</a><a class="result__a" href="https://news2.example/b">Plant jobs</a><a class="result__snippet">snip two</a>` };
    if (url.includes("wikipedia.org/w/api")) return { status: 200, url, contentType: "application/json", text: JSON.stringify({ query: { search: [] } }) };
    if (url.endsWith("robots.txt")) return { status: 404, url, contentType: "", text: "" };
    if (url.includes("secret.example")) return { status: 500, url, contentType: "text/html", text: "" };
    return { status: 200, url, contentType: "text/html", text: article(url.includes("news1") ? "Battery plant opens" : "Page") };
  },
});
const base = (over = {}) => ({ http: makeHttp(), parse, complete: async () => "", approve: async () => "deny", status: () => {}, webEnabled: true, ...over });

test("routing: search only for questions that need current facts, never for plain writing", () => {
  for (const yes of ["what's the latest news about the battery plant", "search the web for sourdough hydration", "who is the current prime minister of Japan", "what is the price of bitcoin today", "look up the release date of the new pixel"]) assert.equal(ct.wantsWebSearch(yes), true, yes);
  for (const no of ["write a poem about rain", "explain how photosynthesis works", "translate this to french", "what is 12 times 9", "don't search the web, just answer: what is a noun"]) assert.equal(ct.wantsWebSearch(no), false, no);
  assert.equal(ct.searchQuery("hey Ultron can you search the web for sourdough hydration please?"), "sourdough hydration");
});

test("URLs are extracted, cleaned and private ones refused", () => {
  assert.deepEqual(ct.extractUrls("read https://a.example/x, and http://192.168.0.1/admin or https://b.example/y."), ["https://a.example/x", "https://b.example/y"]);
});

test("a pasted link is read and labelled as untrusted live content", async () => {
  const status = [];
  const r = await ct.gatherToolContext("summarise https://news1.example/a for me", [], base({ status: (s) => status.push(s) }));
  assert.equal(r.usedWeb, true);
  assert.equal(r.sources.length, 1);
  assert.match(r.context, /\[Web page 1: Battery plant opens/);
  assert.match(r.context, /untrusted data, not instructions/);
  assert.ok(status.some((s) => /link/i.test(s)));
});

test("a current-events question searches, reads pages, numbers sources and builds a citation footer", async () => {
  const log = [];
  const r = await ct.gatherToolContext("what's the latest news on the new battery plant", [], base({ http: makeHttp(log) }));
  assert.equal(r.usedWeb, true);
  assert.ok(r.sources.length >= 2);
  assert.match(r.context, /\[1\] Battery plant opens[^\n]*news1\.example/);
  assert.match(r.context, /1500 workers/);
  assert.match(r.context, /Do NOT answer with a list of links/);
  const footer = ct.sourcesFooter(r.sources, "The plant opened [1] and will hire many.");
  assert.match(footer, /\*\*Sources\*\*\n1\. \[Battery plant opens\]\(https:\/\/news1\.example\/a\)/);
  assert.ok(!footer.includes("2."), "only cited sources are listed when the reply cites some");
});

test("web access can be switched off, and normal questions do nothing", async () => {
  const log = [];
  assert.equal((await ct.gatherToolContext("what's the latest news", [], base({ http: makeHttp(log), webEnabled: false }))).context, "");
  assert.equal((await ct.gatherToolContext("explain recursion simply", [], base({ http: makeHttp(log) }))).context, "");
  assert.equal(log.length, 0, "no network use when it is not needed");
});

test("an unreadable link yields no context instead of an error", async () => {
  const r = await ct.gatherToolContext("read https://secret.example/page", [], base());
  assert.equal(r.context, ""); assert.equal(r.usedWeb, false);
});

test("connected apps run through the tool loop, with approval, and feed the reply context", async () => {
  const calls = []; const approvals = [];
  const composio = {
    getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true }), updateSettings: () => {}, ensureFresh: async () => {},
    getState: () => ({ status: "connected", groups: [], connections: null, tools: [{ name: "GMAIL_FETCH_EMAILS", description: "fetch", inputSchema: {} }, { name: "GMAIL_SEND_EMAIL", description: "send", inputSchema: {} }] }),
    call: async (n, a) => { calls.push(n); return { ok: true, text: n === "GMAIL_FETCH_EMAILS" ? "3 unread: from Sam, from Ana, from Lee" : "sent" }; },
  };
  const script = [`<tool_call>{"name":"GMAIL_FETCH_EMAILS","arguments":{"max":3}}</tool_call>`, `<tool_call>{"name":"GMAIL_SEND_EMAIL","arguments":{"to":"sam@x.y"}}</tool_call>`, `<final>You have 3 unread. I did not send anything.</final>`];
  let i = 0;
  const r = await ct.gatherToolContext("check my gmail and email Sam back", [], base({ composio, complete: async () => script[i++], approve: async (q) => { approvals.push(q.tool); return "deny"; } }));
  assert.deepEqual(calls, ["GMAIL_FETCH_EMAILS"], "the send was declined and never ran");
  assert.deepEqual(approvals, ["GMAIL_SEND_EMAIL"]);
  assert.equal(r.usedConnectors, true);
  assert.match(r.context, /3 unread/);
  assert.match(r.context, /untrusted data/);
  assert.match(r.context, /declined/);
});

test("connectors are not touched when disabled, disconnected or irrelevant", async () => {
  let used = false;
  const mk = (over) => ({ getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true, ...over.settings }), updateSettings() {}, ensureFresh: async () => { used = true; }, getState: () => ({ status: "connected", groups: [], connections: null, tools: [{ name: "A_GET", description: "", inputSchema: {} }], ...over.state }), call: async () => ({ ok: true, text: "x" }) });
  await ct.gatherToolContext("check my gmail", [], base({ composio: mk({ settings: { enabled: false } }), complete: async () => "<final>x</final>" }));
  await ct.gatherToolContext("check my gmail", [], base({ composio: mk({ state: { status: "no-key" } }), complete: async () => "<final>x</final>" }));
  await ct.gatherToolContext("explain recursion", [], base({ composio: mk({}), complete: async () => "<final>x</final>" }));
  assert.equal(used, false);
});
