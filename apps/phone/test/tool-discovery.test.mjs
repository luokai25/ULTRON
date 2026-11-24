import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const d = await loadSource("connectors/tool-discovery.ts");

// Trimmed from a real two-query COMPOSIO_SEARCH_TOOLS reply.
const REAL = { data: {
  results: [
    { index: 1, use_case: "find the latest email from a person and reply to it", primary_tool_slugs: ["GMAIL_REPLY_TO_THREAD", "GMAIL_LIST_THREADS"], related_tool_slugs: ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_FETCH_EMAILS", "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE"], toolkits: ["gmail", "googledrive"], recommended_plan_steps: ["List threads", "Reply"], known_pitfalls: ["thread id, not message id"] },
    { index: 2, use_case: "check whether my website deployment succeeded", primary_tool_slugs: ["VERCEL_GET_DEPLOYMENT"], related_tool_slugs: ["VERCEL_GET_DEPLOYMENTS", "VERCEL_CREATE_NEW_DEPLOYMENT"], toolkits: ["vercel"], known_pitfalls: ["thread id, not message id", "ids are not names"] },
  ],
  toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true }, { toolkit: "googledrive", has_active_connection: true }, { toolkit: "vercel", has_active_connection: true }, { toolkit: "slack", has_active_connection: false }],
  tool_schemas: {
    GMAIL_REPLY_TO_THREAD: { toolkit: "GMAIL", description: "Sends a reply to a Gmail thread.", input_schema: { properties: {} }, hasFullSchema: true },
    GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE: { toolkit: "GOOGLEDRIVE", description: "DEPRECATED: Use GOOGLEDRIVE_CREATE_PERMISSION instead; use GOOGLEDRIVE_UPDATE_PERMISSION to modify e...", hasFullSchema: false, schemaRef: {} },
  },
  session: { id: "mind", generate_id: true },
} };

test("every query's results are read, not just the first, and each tool remembers which need it serves", () => {
  const disc = d.parseDiscovery(REAL.data);
  assert.deepEqual(disc.candidates.map((c) => c.slug), ["GMAIL_REPLY_TO_THREAD", "GMAIL_LIST_THREADS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_FETCH_EMAILS", "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", "VERCEL_GET_DEPLOYMENT", "VERCEL_GET_DEPLOYMENTS", "VERCEL_CREATE_NEW_DEPLOYMENT"]);
  assert.equal(disc.candidates.find((c) => c.slug === "VERCEL_GET_DEPLOYMENT").need, "check whether my website deployment succeeded");
  assert.equal(disc.candidates.find((c) => c.slug === "GMAIL_LIST_THREADS").primary, true);
  assert.equal(disc.candidates.find((c) => c.slug === "GMAIL_FETCH_EMAILS").primary, false);
  assert.equal(disc.sessionId, "mind");
  assert.deepEqual([...disc.connected].sort(), ["gmail", "googledrive", "vercel"]); assert.deepEqual(disc.notConnected, ["slack"]);
  assert.deepEqual(disc.pitfalls, ["thread id, not message id", "ids are not names"], "hints are merged without repeats");
  assert.equal(disc.candidates.find((c) => c.slug === "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE").deprecated, true);
  assert.equal(disc.candidates.find((c) => c.slug === "VERCEL_GET_DEPLOYMENT").toolkit, "vercel", "the toolkit falls back to the slug prefix");
});

test("the old single-result shape still parses", () => {
  const disc = d.parseDiscovery({ results: [{ primary_tool_slugs: ["NOTION_CREATE_PAGE"], related_tool_slugs: [] }], session: { id: "s1" } });
  assert.deepEqual(disc.candidates.map((c) => c.slug), ["NOTION_CREATE_PAGE"]); assert.equal(disc.sessionId, "s1");
  assert.deepEqual(d.parseDiscovery(null).candidates, []);
});

test("candidates interleave across needs, deprecated ones go last, and unconnected apps are dropped", () => {
  const disc = d.parseDiscovery(REAL.data);
  const picked = d.pickCandidates(disc, { limit: 6 }).map((c) => c.slug);
  assert.deepEqual(picked, ["GMAIL_REPLY_TO_THREAD", "VERCEL_GET_DEPLOYMENT", "GMAIL_LIST_THREADS", "VERCEL_GET_DEPLOYMENTS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "VERCEL_CREATE_NEW_DEPLOYMENT"], "one need cannot crowd out the other");
  const all = d.pickCandidates(disc, { limit: 20 }).map((c) => c.slug);
  assert.equal(all.at(-1), "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", "deprecated tool is last");
  const slack = d.parseDiscovery({ results: [{ primary_tool_slugs: ["SLACK_SEND_MESSAGE"] }], toolkit_connection_statuses: [{ toolkit: "slack", has_active_connection: false }] });
  assert.deepEqual(d.pickCandidates(slack), [], "nothing usable from an app that is not connected");
  assert.deepEqual(d.unconnectedToolkits(slack), ["slack"]);
});

test("an app the owner pointed at comes first", () => {
  const disc = d.parseDiscovery(REAL.data);
  assert.equal(d.pickCandidates(disc, { pointed: ["vercel"], limit: 3 })[0].toolkit, "vercel");
  assert.equal(d.pickCandidates(disc, { pointed: ["google_analytics"], limit: 3 }).length, 3, "pointing at an app with no tools hides nothing");
});

test("search phrasings: the request, then the request aimed at each suspected app, never repeating one already named", () => {
  assert.deepEqual(d.buildQueries("check my build").map((q) => q.use_case), ["check my build"]);
  assert.deepEqual(d.buildQueries("check my build", { likely: ["vercel", "github"] }).map((q) => q.use_case), ["check my build", "check my build (in Vercel)", "check my build (in GitHub)"]);
  assert.deepEqual(d.buildQueries("check my vercel build", { likely: ["vercel"] }).map((q) => q.use_case), ["check my vercel build"]);
  assert.equal(d.buildQueries("x", { pointed: ["a_b", "c", "d", "e"] }).length, 3, "at most three searches");
  assert.equal(d.buildQueries("summarise last week\n\n[The owner pointed at: GitHub. Use those apps.]")[0].use_case, "summarise last week");
});

test("a widened search merges into the first, and connected in either counts as connected", () => {
  const a = d.parseDiscovery({ results: [{ use_case: "a", primary_tool_slugs: ["SLACK_SEND_MESSAGE"] }], toolkit_connection_statuses: [{ toolkit: "slack", has_active_connection: false }], session: { id: "s" } });
  const b = d.parseDiscovery({ results: [{ use_case: "b", primary_tool_slugs: ["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"] }], toolkit_connection_statuses: [{ toolkit: "gmail", has_active_connection: true }] });
  const m = d.mergeDiscovery(a, b);
  assert.deepEqual(m.candidates.map((c) => c.slug), ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"]);
  assert.deepEqual(d.pickCandidates(m).map((c) => c.slug), ["GMAIL_SEND_EMAIL"]); assert.equal(m.sessionId, "s");
});

test("the widening prompt names the connected apps, what was already tried, and asks for JSON", () => {
  const p = d.widenPrompt("message Ali", ["gmail", "outlook"], ["message Ali"]);
  assert.match(p, /gmail \(Gmail\), outlook \(Outlook\)/); assert.match(p, /already tried: "message Ali"/); assert.match(p, /"try"/);
});
