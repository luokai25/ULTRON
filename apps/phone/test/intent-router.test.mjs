import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const r = await loadSource("connectors/intent-router.ts");
const APPS = ["gmail", "github", "gumroad", "google_analytics", "googlecalendar", "googledrive", "notion", "linear", "hugging_face"];

test("activeMention finds the @token being typed and only at a word start", () => {
  assert.deepEqual(r.activeMention("@g"), { start: 0, end: 2, query: "g" });
  assert.deepEqual(r.activeMention("check @gm"), { start: 6, end: 9, query: "gm" });
  assert.deepEqual(r.activeMention("hello @"), { start: 6, end: 7, query: "" });
  assert.equal(r.activeMention("mail me at sam@gmail"), null);
  assert.equal(r.activeMention("@gmail what's new"), null);
  assert.deepEqual(r.activeMention("@gm what's new", 3), { start: 0, end: 3, query: "gm" });
});

test("suggestMentions narrows as letters are typed and ranks prefix matches first", () => {
  assert.deepEqual(r.suggestMentions("g", APPS).map((s) => s.slug), ["github", "gmail", "google_analytics", "googlecalendar", "googledrive", "gumroad"]);
  assert.deepEqual(r.suggestMentions("gi", APPS).map((s) => s.slug), ["github"]);
  assert.deepEqual(r.suggestMentions("goo", APPS).map((s) => s.slug), ["google_analytics", "googlecalendar", "googledrive"]);
  assert.equal(r.suggestMentions("analytics", APPS)[0].slug, "google_analytics", "a later word of the name still matches");
  assert.equal(r.suggestMentions("hug", APPS)[0].label, "Hugging Face");
  assert.equal(r.suggestMentions("", APPS, 50).length, APPS.length, "a bare @ lists everything connected");
  assert.equal(r.suggestMentions("", APPS).length, 8, "the default list is capped for a small screen");
  assert.deepEqual(r.suggestMentions("zzz", APPS), []);
  assert.ok(!r.suggestMentions("g", APPS).some((s) => s.slug === "hugging_face"), "one letter means starts-with, not contains");
});

test("applyMention completes the token and moves the cursor past it", () => {
  const a = r.activeMention("check @gi", 9);
  assert.deepEqual(r.applyMention("check @gi", a, "github"), { text: "check @github ", cursor: 14 });
  const b = r.activeMention("@no later words", 3);
  assert.deepEqual(r.applyMention("@no later words", b, "notion"), { text: "@notion later words", cursor: 8 });
});

test("parseMentions resolves exact names and unique prefixes, strips them, and reports unknown ones", () => {
  const p = r.parseMentions("@gmail and @git summarise @nothing today", APPS);
  assert.deepEqual(p.mentions, ["gmail", "github"]);
  assert.deepEqual(p.unknown, ["nothing"]);
  assert.equal(p.task, "and summarise @nothing today");
  assert.deepEqual(r.parseMentions("@g hi", APPS).mentions, [], "an ambiguous prefix is not guessed");
  assert.deepEqual(r.parseMentions("@google_analytics top pages", APPS), { mentions: ["google_analytics"], unknown: [], task: "top pages" });
});

test("a mention always routes to the tools, with no guessing", () => {
  const d = r.routeIntent("@linear what's assigned", APPS);
  assert.equal(d.use, true); assert.equal(d.mode, "mention"); assert.deepEqual(d.apps, ["linear"]); assert.equal(d.task, "what's assigned");
});

test("general questions that name an app stay in chat", () => {
  for (const t of ["explain how github actions caching works", "what is a pull request", "how do I write a good calendar invite", "notion vs obsidian"]) assert.equal(r.routeIntent(t, APPS).use, false, t);
  assert.equal(r.routeIntent("how do I check my gmail", APPS).use, true, "'my' makes it about the owner");
});

test("requests that say nothing about an app are still caught by what they ask for", () => {
  assert.deepEqual(r.routeIntent("am I free thursday at 3", APPS).apps, ["googlecalendar"]);
  assert.equal(r.routeIntent("anything new on main since yesterday", APPS).apps[0], "github");
  assert.equal(r.routeIntent("how many people visited my site yesterday", APPS).apps[0], "google_analytics");
});

test("the model settles the middle band, and its answer is validated against connected apps", async () => {
  const asked = [];
  const yes = async (m) => { asked.push(m[1].content); return '```json\n{"tools": true, "apps": ["gmail", "made_up_app"], "why": "wants mail"}\n```'; };
  const d = await r.routeWithModel("anything urgent I should know about", APPS, yes);
  assert.equal(d.use, true); assert.deepEqual(d.apps, ["gmail"], "invented slugs are dropped");
  assert.match(asked[0], /Connected apps: gmail \(Gmail\)/);
  const no = async () => '{"tools": false, "apps": [], "why": "chit chat"}';
  assert.equal((await r.routeWithModel("I need a better morning routine", APPS, no)).use, false);
});

test("the model is not called when the rules are sure", async () => {
  let calls = 0; const spy = async () => { calls++; return "{}"; };
  await r.routeWithModel("check my gmail", APPS, spy); await r.routeWithModel("what is the capital of japan", APPS, spy);
  assert.equal(calls, 0);
});

test("a broken or failing model falls back to the owner cue instead of crashing", async () => {
  const junk = async () => "sure thing!"; const boom = async () => { throw new Error("rate limited"); };
  assert.equal((await r.routeWithModel("anything urgent I should know about", APPS, junk)).use, true);
  assert.equal((await r.routeWithModel("I need a better morning routine", APPS, boom)).use, false);
});

test("routing works before the connected list is known", () => {
  assert.equal(r.routeIntent("check my gmail and email Sam back", []).use, true);
  assert.equal(r.routeIntent("explain recursion simply", []).use, false);
});
