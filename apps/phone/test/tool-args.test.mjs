import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const args = await loadSource("connectors/tool-args.ts");

// Schemas copied from real Composio replies.
const LIST_THREADS = { toolkit: "GMAIL", tool_slug: "GMAIL_LIST_THREADS", description: "Retrieves a list of email threads from a Gmail account.", input_schema: { type: "object", properties: {
  query: { type: "string", description: "Filter for threads, using Gmail search query syntax." }, user_id: { type: "string", default: "me" },
  verbose: { type: "boolean", default: false }, page_token: { type: "string" }, max_results: { type: "integer", default: 10, maximum: 500, minimum: 1, description: "Maximum number of threads to return." } } }, hasFullSchema: true };
const REPLY = { toolkit: "GMAIL", tool_slug: "GMAIL_REPLY_TO_THREAD", description: "Sends a reply to a Gmail thread.", input_schema: { type: "object", required: ["thread_id"], properties: {
  cc: { type: "array", items: { type: "string" } }, is_html: { type: "boolean" }, thread_id: { type: "string" }, message_body: { type: "string" }, recipient_email: { type: "string" },
  attachment: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] } } }, hasFullSchema: true };
const EVENTS = { toolkit: "VERCEL", description: "Retrieve events for a deployment.", input_schema: { type: "object", required: ["idOrUrl"], properties: {
  idOrUrl: { type: "string" }, builds: { enum: [0, 1], type: "integer" }, direction: { enum: ["backward", "forward"], type: "string" }, limit: { type: "integer" } } }, hasFullSchema: true };
const STUB = { toolkit: "GMAIL", tool_slug: "GMAIL_FETCH_EMAILS", description: "Lists Gmail messages with query and label filtering, pagination, and optional message details. Indiv...", hasFullSchema: false, schemaRef: { tool: "COMPOSIO_GET_TOOL_SCHEMAS", args: { tool_slugs: ["GMAIL_FETCH_EMAILS"] } } };

test("a schema stub is recognised, so the real schema is fetched instead of telling the model the tool takes no arguments", () => {
  assert.equal(args.isSchemaStub(STUB), true);
  assert.equal(args.isSchemaStub(LIST_THREADS), false);
  assert.equal(args.isSchemaStub({ input_schema: { properties: { a: { type: "string" } } } }), false);
  assert.equal(args.isSchemaStub(undefined), true);
  const t = args.toolInfoFromSchema("GMAIL_FETCH_EMAILS", STUB);
  assert.equal(t.hasSchema, false); assert.equal(t.toolkit, "gmail");
});

test("toolInfoFromSchema keeps types, enums and limits, flags deprecation, and lists required arguments first", () => {
  const t = args.toolInfoFromSchema("VERCEL_GET_DEPLOYMENT_EVENTS2", EVENTS);
  assert.equal(t.toolkit, "vercel"); assert.equal(t.hasSchema, true);
  assert.deepEqual(t.params.find((p) => p.name === "builds").enumValues, [0, 1]);
  assert.match(args.toolLine(t), /^- VERCEL_GET_DEPLOYMENT_EVENTS2: Retrieve events for a deployment\.\n  args: idOrUrl\*:string; builds:integer\[0\|1\]; direction:string\[backward\|forward\]; limit:integer$/);
  assert.equal(args.toolInfoFromSchema("X", { description: "DEPRECATED: use Y instead", input_schema: { properties: {} } }).deprecated, true);
  assert.match(args.toolLine(args.toolInfoFromSchema("X", { description: "DEPRECATED: use Y", input_schema: { properties: {} } })), /deprecated/);
  const many = args.toolInfoFromSchema("BIG", { input_schema: { required: ["z_last"], properties: Object.fromEntries([...Array.from({ length: 20 }, (_, i) => [`a${i}`, { type: "string" }]), ["z_last", { type: "string" }]]) } });
  assert.match(args.toolLine(many), /z_last\*:string/, "a required argument can never be cut off by a long schema");
  const anyOf = args.toolInfoFromSchema("R", REPLY).params.find((p) => p.name === "attachment");
  assert.equal(anyOf.type, "object");
});

test("normalizeArgs repairs what a small model gets wrong", () => {
  const info = args.toolInfoFromSchema("GMAIL_LIST_THREADS", LIST_THREADS);
  const r = args.normalizeArgs(info, { query: "is:unread", max_results: "5", verbose: "True", bogus: "x", page_token: "", user_id: null });
  assert.deepEqual(r.args, { query: "is:unread", max_results: 5, verbose: true });
  assert.equal(r.problems.length, 0);
  assert.ok(r.fixes.some((f) => /max_results/.test(f)) && r.fixes.some((f) => /bogus/.test(f)));
  assert.equal(args.normalizeArgs(info, { max_results: 9000 }).args.max_results, 500, "clamped to the schema maximum");
  assert.equal(args.normalizeArgs(info, { max_results: "0" }).args.max_results, 1, "and the minimum");
  assert.equal(args.normalizeArgs(info, { max_results: "2.7" }).args.max_results, 3, "integers are rounded");
  assert.equal(args.normalizeArgs(info, { max_results: "1,000" }).args.max_results, 500);
});

test("lists, objects and enums are put in the shape the tool expects", () => {
  const reply = args.toolInfoFromSchema("GMAIL_REPLY_TO_THREAD", REPLY);
  assert.deepEqual(args.normalizeArgs(reply, { thread_id: "19bf", cc: "a@x.com, b@x.com" }).args.cc, ["a@x.com", "b@x.com"]);
  assert.deepEqual(args.normalizeArgs(reply, { thread_id: "19bf", cc: '["a@x.com"]' }).args.cc, ["a@x.com"]);
  assert.deepEqual(args.normalizeArgs(reply, { thread_id: "19bf", cc: "solo@x.com" }).args.cc, ["solo@x.com"]);
  assert.equal(args.normalizeArgs(reply, { thread_id: 12345 }).args.thread_id, "12345", "a number given for text becomes text");
  const ev = args.toolInfoFromSchema("VERCEL_GET_DEPLOYMENT_EVENTS2", EVENTS);
  assert.deepEqual(args.normalizeArgs(ev, { idOrUrl: "dpl_1", direction: "Backward", builds: "1" }).args, { idOrUrl: "dpl_1", direction: "backward", builds: 1 });
});

test("what cannot be repaired is reported with the allowed values, not guessed", () => {
  const ev = args.toolInfoFromSchema("VERCEL_GET_DEPLOYMENT_EVENTS2", EVENTS);
  const r = args.normalizeArgs(ev, { idOrUrl: "dpl_1", direction: "sideways", limit: "many" });
  assert.deepEqual(r.problems.sort(), ["direction must be one of backward, forward", "limit must be a number"]);
  assert.deepEqual(args.missingRequired(ev, { direction: "forward" }), ["idOrUrl"]);
  assert.deepEqual(args.missingRequired(ev, { idOrUrl: "" }), ["idOrUrl"], "an empty string does not satisfy a required argument");
});

test("a tool with an unknown schema is left alone, so nothing real is dropped", () => {
  const unknown = args.toolInfoFromSchema("GMAIL_FETCH_EMAILS", STUB);
  assert.deepEqual(args.normalizeArgs(unknown, { query: "x", anything: 1, empty: "" }).args, { query: "x", anything: 1 }, "only empty optionals are removed");
  assert.deepEqual(args.normalizeArgs(undefined, { a: 1 }).args, { a: 1 });
});
