import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const ct = await loadSource("connectors/chat-tools.ts");

const http = { bytes: async () => ({}), get: async (url) => ({ status: 404, url, contentType: "", text: "" }) };
const base = (over = {}) => ({ http, parse: (html) => parseHTML(html).document, complete: async () => "", approve: async () => "deny", status: () => {}, webEnabled: false, ...over });

test("routing by intent: implicit requests, @mentions, and general questions that merely name an app", async () => {
  const seen = []; let fresh = 0;
  const composio = {
    getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true }), updateSettings() {}, ensureFresh: async () => { fresh++; },
    getState: () => ({ status: "connected", groups: [], connections: null, connectedApps: ["gmail", "github", "googlecalendar"], tools: [{ name: "GMAIL_FETCH_EMAILS", description: "fetch", inputSchema: {} }] }),
    call: async () => ({ ok: true, text: "ok" }),
  };
  const run = (text, over = {}) => ct.gatherToolContext(text, [], base({ composio, complete: async (m) => { seen.push(m.map((x) => x.content).join("\n")); return "<final>done</final>"; }, ...over }));

  // No trigger word at all: still goes to the apps, because of what it asks for.
  let r = await run("what did Sarah say to me this morning");
  assert.equal(r.usedConnectors, true);

  // @mention: removed from the task the tools see, and the pointer is passed on.
  seen.length = 0;
  r = await run("@git summarise last week");
  assert.equal(r.usedConnectors, true);
  assert.ok(seen.some((s) => /The owner pointed at: GitHub/.test(s)), "the pointed-at app is named");
  assert.ok(!seen.some((s) => /@git /.test(s)), "the raw @token is not left in the task");

  // A general question that names an app is answered in chat, with no tool run and no classifier call.
  fresh = 0; seen.length = 0;
  r = await run("explain how github actions caching works");
  assert.equal(r.usedConnectors, false); assert.equal(fresh, 0); assert.equal(seen.length, 0);
});

test("routing by intent: a borderline message asks the model once, and 'no tools' means no tools", async () => {
  let asked = 0; let ran = 0;
  const composio = {
    getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true }), updateSettings() {}, ensureFresh: async () => { ran++; },
    getState: () => ({ status: "connected", groups: [], connections: null, connectedApps: ["gmail"], tools: [{ name: "GMAIL_FETCH_EMAILS", description: "fetch", inputSchema: {} }] }),
    call: async () => ({ ok: true, text: "ok" }),
  };
  const r = await ct.gatherToolContext("I need a better morning routine", [], base({ composio, complete: async (m) => { asked++; return '{"tools": false, "apps": [], "why": "chit chat"}'; } }));
  assert.equal(asked, 1); assert.equal(ran, 0); assert.equal(r.usedConnectors, false);
});
