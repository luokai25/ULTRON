import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const { runCandidates } = await loadSource("candidate-loop.ts");
const { ProviderHttpError } = await loadSource("provider-adapters.ts");

const cand = (id, model, keyId = id) => ({ provider: "groq", key: { id: keyId }, model });
function harness(script) {
  const recorded = []; const requested = []; const tokens = []; const resets = [];
  const controller = new AbortController();
  const deps = {
    stream: async (c, onToken) => { const step = script[`${c.key.id}|${c.model}`]; return typeof step === "function" ? step(onToken) : step; },
    record: async (c, r) => { recorded.push([c.model, r.outcome]); },
    noteRequest: (id) => requested.push(id), noteTokens: (id, n) => tokens.push([id, n]), providerName: (p) => p.toUpperCase(),
  };
  const run = (candidates, over = {}) => runCandidates(candidates, { signal: over.signal ?? new AbortController().signal, controller, onToken: (t) => { if (t === null) resets.push(1); }, promptChars: 40 }, deps);
  return { run, recorded, requested, tokens, resets, controller };
}
const http = (status, msg = "nope") => () => { throw new ProviderHttpError(status, msg); };

// ---- the bug: a model that answers nothing must not end the request -------------------------------------------------------

test("a model that returns no text is skipped and the next model answers", async () => {
  const h = harness({ "a|strong": "", "b|second": "Hello there" });
  const r = await h.run([cand("a", "strong"), cand("b", "second")]);
  assert.equal(r.content, "Hello there");
  assert.deepEqual(h.requested, ["a|strong", "b|second"]);
  assert.deepEqual(h.recorded, [["second", "success"]], "a blank reply leaves no lasting mark on the key or the model");
});

test("whitespace-only replies count as blank, and text already streamed to the screen is cleared before moving on", async () => {
  const h = harness({ "a|m": async (onToken) => { onToken("  "); onToken("\n"); return "  \n"; }, "b|m": "Answer" });
  const r = await h.run([cand("a", "m"), cand("b", "m")]);
  assert.equal(r.content, "Answer"); assert.equal(h.resets.length, 1);
});

test("when every model returns nothing, the result says which ones, instead of a vague message", async () => {
  const h = harness({ "a|alpha": "", "b|beta": "   " });
  const r = await h.run([cand("a", "alpha"), cand("b", "beta")]);
  assert.equal(r.content, null);
  assert.match(r.lastError.message, /alpha/); assert.match(r.lastError.message, /beta/); assert.match(r.lastError.message, /no text/i);
  assert.deepEqual(h.recorded, []);
});

// ---- behaviour that must not change ---------------------------------------------------------------------------------------

test("a good first answer is returned trimmed, recorded and counted", async () => {
  const h = harness({ "a|m": "  Hi  " });
  const r = await h.run([cand("a", "m"), cand("b", "m")]);
  assert.equal(r.content, "Hi"); assert.deepEqual(h.requested, ["a|m"]); assert.deepEqual(h.recorded, [["m", "success"]]); assert.deepEqual(h.tokens, [["a|m", 12]], "estimated from the untrimmed reply: (40 prompt + 6) / 4, rounded up");
});

test("401, 403 (not about the model) and 429 retire the whole key for this request; the next key is tried", async () => {
  for (const status of [401, 403, 429]) {
    const h = harness({ "k1|m1": http(status), "k1|m2": "must not be tried", "k2|m1": "from the second key" });
    const r = await h.run([cand("k1", "m1", "k1"), cand("k1b", "m2", "k1"), cand("k2", "m1", "k2")]);
    assert.equal(r.content, "from the second key", `HTTP ${status}`);
    assert.ok(!h.requested.includes("k1|m2") && h.requested.includes("k2|m1"));
  }
  const h = harness({ "k1|m1": http(401), "k2|m1": "ok" }); await h.run([cand("k1", "m1"), cand("k2", "m1")]);
  assert.deepEqual(h.recorded[0], ["m1", "invalid"]);
});

test("404 and a 403 that names the model block only that model; 5xx is transient; both move on", async () => {
  const h = harness({ "a|x": http(404), "b|y": http(403, "model not available"), "c|z": http(503), "d|w": "fine" });
  const r = await h.run([cand("a", "x"), cand("b", "y"), cand("c", "z"), cand("d", "w")]);
  assert.equal(r.content, "fine");
  assert.deepEqual(h.recorded, [["x", "model_error"], ["y", "model_error"], ["z", "transient"], ["w", "success"]]);
});

test("an unexpected status such as 400 is the caller's mistake and is raised, not retried", async () => {
  const h = harness({ "a|m": http(400, "bad request"), "b|m": "never" });
  await assert.rejects(() => h.run([cand("a", "m"), cand("b", "m")]), /HTTP 400: bad request/);
  assert.deepEqual(h.requested, ["a|m"]);
});

test("a dropped connection before any text moves on; after text was shown it is raised so answers are never spliced", async () => {
  const early = harness({ "a|m": () => { throw new Error("network down"); }, "b|m": "recovered" });
  assert.equal((await early.run([cand("a", "m"), cand("b", "m")])).content, "recovered"); assert.deepEqual(early.recorded[0], ["m", "transient"]);
  const late = harness({ "a|m": (onToken) => { onToken("Partial"); throw new Error("cut off"); }, "b|m": "never" });
  await assert.rejects(() => late.run([cand("a", "m"), cand("b", "m")]), /cut off/); assert.deepEqual(late.requested, ["a|m"]);
});

test("stopping the request raises an abort and tries nothing further", async () => {
  const stop = new AbortController(); stop.abort();
  const h = harness({ "a|m": "never" });
  await assert.rejects(() => h.run([cand("a", "m")], { signal: stop.signal }), (e) => e.name === "AbortError");
  assert.deepEqual(h.requested, []);
});

test("when every candidate fails, the last error is handed back and nothing is returned", async () => {
  const h = harness({ "a|m": http(503, "busy"), "b|m": http(429, "slow down") });
  const r = await h.run([cand("a", "m"), cand("b", "m")]);
  assert.equal(r.content, null); assert.match(r.lastError.message, /GROQ HTTP 429: slow down/);
});
