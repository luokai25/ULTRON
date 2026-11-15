import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const toUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const transpile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;

const eligibility = toUrl(transpile(src("model-eligibility.ts")));
globalThis.window = { localStorage: { getItem: () => null, setItem: () => {} } };
const limitsMod = await import(toUrl(transpile(src("free-tier-limits.ts")).replace('"./model-eligibility"', JSON.stringify(eligibility))));
const limitsUrl = toUrl(transpile(src("free-tier-limits.ts")).replace('"./model-eligibility"', JSON.stringify(eligibility)));
const ledgerMod = await import(toUrl(transpile(src("usage-ledger.ts")).replace('"./free-tier-limits"', JSON.stringify(limitsUrl))));
const { FREE_TIER_LIMITS, estimateFreeCapacity, formatTokens, NOT_AUTO_ROUTED } = limitsMod;
const { createUsageLedger } = ledgerMod;
const { automaticModels } = await import(eligibility);

function ledger(startMs = Date.UTC(2026, 10, 14, 12, 0, 0)) {
  const store = new Map();
  const clock = { now: startMs };
  const l = createUsageLedger({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, now: () => clock.now });
  return { l, clock, store };
}

test("a key's utilization follows requests per minute and resets as the minute passes", () => {
  const { l, clock } = ledger();
  const limits = { rpm: 10 };
  assert.equal(l.utilization("k1", limits), 0);
  for (let i = 0; i < 5; i++) l.noteRequest("k1");
  assert.equal(l.utilization("k1", limits), 0.5);
  clock.now += 61_000;
  assert.equal(l.utilization("k1", limits), 0, "the minute window has passed");
  assert.equal(l.snapshot("k1").requestsToday, 5, "the daily count is kept");
});

test("daily request and token caps are tracked per key and reset on the next UTC day", () => {
  const { l, clock } = ledger();
  const limits = { rpd: 100, tpd: 1000 };
  for (let i = 0; i < 20; i++) l.noteRequest("a");
  l.noteTokens("a", 900);
  assert.equal(l.utilization("a", limits), 0.9, "the highest ratio wins");
  assert.equal(l.utilization("b", limits), 0, "other keys are independent");
  l.noteTokens("a", 200);
  assert.ok(l.utilization("a", limits) > 1, "past the cap reads above 1");
  clock.now += 24 * 3600_000;
  assert.equal(l.utilization("a", limits), 0, "a new UTC day starts empty");
});

test("the ledger survives corrupt storage and ignores nonsense token counts", () => {
  const store = new Map([["ultron.usage-ledger.v1", "{not json"]]);
  const l = createUsageLedger({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, now: () => Date.now() });
  l.noteTokens("x", NaN); l.noteTokens("x", -5); l.noteTokens("x", 0);
  assert.equal(l.snapshot("x").tokensToday, 0);
  l.noteRequest("x");
  assert.equal(l.snapshot("x").requestsToday, 1);
});

test("capacity is counted once per provider, excludes Cerebras, and never claims billions from a few providers", () => {
  const none = estimateFreeCapacity({});
  assert.equal(none.totalMonthlyTokens, 0);
  const mine = estimateFreeCapacity({ groq: 15, openrouter: 15, google_ai_studio: 15 });
  assert.equal(mine.lines.length, 3);
  assert.equal(mine.totalMonthlyTokens, FREE_TIER_LIMITS.groq.monthlyTokens + FREE_TIER_LIMITS.openrouter.monthlyTokens + FREE_TIER_LIMITS.google_ai_studio.monthlyTokens);
  assert.ok(mine.totalMonthlyTokens < 100_000_000, "fifteen keys from one provider are not fifteen allowances");
  const withCerebras = estimateFreeCapacity({ cerebras: 2, groq: 1 });
  assert.deepEqual(withCerebras.excluded, ["cerebras"]);
  assert.equal(withCerebras.lines.length, 1);
  assert.ok(NOT_AUTO_ROUTED.has("cerebras"));
  assert.equal(formatTokens(24_000_000), "24M");
  assert.equal(formatTokens(1_500_000_000), "1.5B");
  assert.equal(formatTokens(500_000), "500k");
});

test("every provider with a free tier has limits, and every limit note is present", () => {
  for (const provider of ["openrouter", "mistral", "cerebras", "groq", "cohere", "google_ai_studio", "huggingface", "nvidia", "zhipu", "ollama_cloud"]) {
    const entry = FREE_TIER_LIMITS[provider];
    assert.ok(entry && entry.monthlyTokens > 0 && entry.note.length > 10, provider);
  }
  assert.equal(FREE_TIER_LIMITS.github_models, undefined, "GitHub Models was retired upstream and must not return");
});

test("Z.ai only auto-routes its free flash models; Ollama Cloud routes hosted chat models", () => {
  assert.deepEqual(automaticModels("zhipu", ["glm-4.5-flash", "glm-4.7-flash", "glm-4.6v-flash", "glm-4.6", "glm-5"]).sort(), ["glm-4.5-flash", "glm-4.6v-flash", "glm-4.7-flash"]);
  assert.deepEqual(automaticModels("ollama_cloud", ["gpt-oss:120b", "nomic-embed-text"]), ["gpt-oss:120b"]);
});

test("Automatic ranks by load, rests keys past their cap, and counts every attempt", () => {
  const cloud = src("cloud-llm.ts");
  assert.match(cloud, /usageLedger\.utilization\(key\.id, FREE_TIER_LIMITS\[candidateProvider\]\)/);
  assert.match(cloud, /Number\(a\.used >= 1\) - Number\(b\.used >= 1\)/, "exhausted keys go to the back");
  assert.match(cloud, /usageLedger\.noteRequest\(candidate\.key\.id\)/);
  assert.match(cloud, /usageLedger\.noteTokens\(candidate\.key\.id/);
});

test("GitHub Models is gone everywhere it was wired in", () => {
  const files = ["provider-adapters.ts", "model-eligibility.ts", "local-llm-vault.ts", "cloud-llm.ts", "ultron-key-import.mjs", "main.ts"].map(src).join("\n") + readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(files, /github_models|GitHub Models|models\.github\.ai/);
  const java = readFileSync(new URL("../android/app/src/main/java/app/ultron/mobile/UltronProviderHttpPlugin.java", import.meta.url), "utf8");
  assert.doesNotMatch(java, /models\.github\.ai|x-github-api-version/);
  assert.match(java, /"api\.z\.ai"/);
  assert.match(java, /"ollama\.com"/);
});
