import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const { catalogScore, effectiveComplexity } = await loadSource("model-effort.ts");
const { catalogModel } = await loadSource("model-eligibility.ts");

test("a lower catalogue rank is a smarter model and must score higher (the old formula had it upside down)", () => {
  for (let r = 1; r < 40; r++) assert.ok(catalogScore(r) > catalogScore(r + 1), `rank ${r} should beat rank ${r + 1}`);
  assert.ok(catalogScore(1) <= 1955 && catalogScore(30) >= 600, "stays in the band the other scores were built around");
});

test("with the real catalogue, the stronger free model wins on the same provider", () => {
  const rank = (provider, id) => { const m = catalogModel(provider, id); assert.ok(m, `${provider}/${id} is in the catalogue`); return m.rank; };
  assert.ok(catalogScore(rank("groq", "llama-3.3-70b-versatile")) > catalogScore(rank("groq", "llama-3.1-8b-instant")), "70B beats 8B on Groq");
  assert.ok(catalogScore(rank("ollama_cloud", "gpt-oss:120b")) > catalogScore(rank("ollama_cloud", "gemma4:31b")), "gpt-oss 120B beats Gemma 31B on Ollama");
  assert.ok(catalogScore(rank("google_ai_studio", "gemini-3-flash-preview")) > catalogScore(rank("google_ai_studio", "gemini-2.5-flash-lite")), "Gemini 3 Flash beats 2.5 Flash-Lite");
});

test("effort: deep work counts as complex, light work as simple, and the default is untouched", () => {
  assert.equal(effectiveComplexity(0, "deep"), 4); assert.equal(effectiveComplexity(6, "deep"), 6);
  assert.equal(effectiveComplexity(5, "light"), 1); assert.equal(effectiveComplexity(0, "light"), 0);
  assert.equal(effectiveComplexity(3), 3);
  assert.equal(catalogScore(5), catalogScore(5, "deep"), "deep keeps the full spread so the best model leads");
});

test("light work flattens the spread so the usage penalty can move it to fresher keys, without reordering", () => {
  const spread = (e) => catalogScore(4, e) - catalogScore(28, e);
  assert.ok(spread("light") < spread() * 0.4 && spread("light") > 0);
  assert.ok(spread() > 400, "normal work: a heavily used key (penalty up to 400) cannot overturn a 24-rank gap on its own");
});
