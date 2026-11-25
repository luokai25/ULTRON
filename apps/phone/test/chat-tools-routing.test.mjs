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

test("the router's app hints reach the tool agent, and deep work is marked as deep", async () => {
  const efforts = []; const searches = [];
  const composio = {
    getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true }), updateSettings() {}, ensureFresh: async () => {},
    getState: () => ({ status: "connected", groups: [], connections: null, connectedApps: ["gmail", "github"], tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "s", inputSchema: {} }] }),
    accountsFor: () => [], defaultAccount: () => null, connectApp: async () => ({ ok: false }),
    callJson: async (name, args) => { if (name === "COMPOSIO_SEARCH_TOOLS") searches.push(args.queries.map((q) => q.use_case)); return { ok: true, json: { data: { results: [{ primary_tool_slugs: ["GITHUB_LIST_COMMITS"] }], toolkit_connection_statuses: [{ toolkit: "github", has_active_connection: true }], tool_schemas: { GITHUB_LIST_COMMITS: { toolkit: "GITHUB", description: "Lists commits.", input_schema: { properties: { repo: { type: "string" } } }, hasFullSchema: true } }, session: { id: "s" } } }, text: "" }; },
    call: async () => ({ ok: true, text: "ok" }),
  };
  const r = await ct.gatherToolContext("@github what changed last week", [], base({ composio, complete: async (m, _n, _s, effort) => { efforts.push(effort); return JSON.stringify({ calls: [], ask: "Which repo?" }); } }));
  assert.equal(r.usedConnectors, true);
  assert.deepEqual(searches[0], ["what changed last week", "what changed last week (in GitHub)"]);
  assert.deepEqual(efforts, ["deep"]);
});

test("'play my song from Dropbox' finds the file, gets a link, and the chat shows a player instead of a link", async () => {
  const meta = (o) => ({ id: "id:-I0_Bq", name: "Night_Drive.mp3", path_display: "/Ultron/Music/Night_Drive.mp3", path_lower: "/ultron/music/night_drive.mp3", size: 4200000, ...o });
  const wrap = (slug, data) => ({ json: { data: { results: [{ response: { successful: true, data }, tool_slug: slug, index: 0 }] } } });
  const schemas = { DROPBOX_SEARCH_FILE_OR_FOLDER: { toolkit: "DROPBOX", description: "Search files.", input_schema: { required: ["query"], properties: { query: { type: "string" } } }, hasFullSchema: true }, DROPBOX_GET_TEMPORARY_LINK: { toolkit: "DROPBOX", description: "Get a temporary link.", input_schema: { required: ["path"], properties: { path: { type: "string" } } }, hasFullSchema: true } };
  const calls = [];
  const composio = {
    getSettings: () => ({ enabled: true, askBefore: true, allowedTools: [], webInChat: true }), updateSettings() {}, ensureFresh: async () => {},
    getState: () => ({ status: "connected", groups: [], connections: null, connectedApps: ["dropbox", "gmail"], tools: [{ name: "COMPOSIO_SEARCH_TOOLS", description: "", inputSchema: {} }] }),
    accountsFor: () => [], defaultAccount: () => null, connectApp: async () => ({ ok: true }), call: async () => ({ ok: true, text: "" }),
    callJson: async (name, args) => {
      calls.push([name, args]);
      if (name === "COMPOSIO_SEARCH_TOOLS") return { ok: true, text: "", json: { data: { results: [{ primary_tool_slugs: ["DROPBOX_SEARCH_FILE_OR_FOLDER", "DROPBOX_GET_TEMPORARY_LINK"] }], toolkit_connection_statuses: [{ toolkit: "dropbox", has_active_connection: true }], tool_schemas: schemas, session: { id: "s1" } } } };
      const slug = args.tools[0].tool_slug;
      const r = slug === "DROPBOX_SEARCH_FILE_OR_FOLDER" ? wrap(slug, { matches: [{ metadata: { ".tag": "file", ...meta({}) } }] }) : wrap(slug, { link: "https://uc1.dl.dropboxusercontent.com/cd/0/get/xyz/file", metadata: meta({}) });
      return { ok: true, text: "", json: r.json };
    },
  };
  const replies = [
    JSON.stringify({ calls: [{ tool_slug: "DROPBOX_SEARCH_FILE_OR_FOLDER", arguments: { query: "Night Drive" } }], more: true }),
    JSON.stringify({ calls: [{ tool_slug: "DROPBOX_GET_TEMPORARY_LINK", arguments: { path: "/Ultron/Music/Night_Drive.mp3" } }] }),
  ];
  const seen = []; let i = 0; let approvals = 0;
  const r = await ct.gatherToolContext("play my song Night Drive from Dropbox", [], base({ composio, approve: async () => { approvals++; return "once"; }, complete: async (m) => { seen.push(m.at(-1).content); return replies[Math.min(i++, 1)]; } }));
  assert.equal(r.usedConnectors, true); assert.equal(approvals, 0, "searching and getting a link only read, so nothing asks first");
  assert.deepEqual(r.media, [{ id: "dropbox:id:-I0_Bq", kind: "audio", title: "Night Drive", mime: "audio/mpeg", remote: { provider: "dropbox", path: "/Ultron/Music/Night_Drive.mp3", size: 4200000 } }]);
  assert.match(r.context, /showing "Night Drive" in the chat as a player/); assert.match(r.context, /do not print any link/);
  assert.match(seen[0], /Dropbox: the owner's folder for Ultron is \/Ultron \(Music, Videos, Images, Documents, Files\)/);
  assert.match(seen[1], /Results of the earlier steps/); assert.match(seen[1], /Night_Drive\.mp3/);
});
