import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSource } from "./_ts-loader.mjs";

/**
 * Routing benchmark: of the messages in fixtures/routing-cases.json, how often does the router make the right
 * "use the connected apps or just answer" call? Deterministic and model-free, so it runs in CI and can only ratchet up.
 */
const loop = await loadSource("connectors/agent-loop.ts");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/routing-cases.json", import.meta.url), "utf8"));

export function scoreRouter(decide) {
  const rows = fixture.cases.map((c) => ({ ...c, got: decide(c.text, fixture.connectedApps) }));
  const by = {};
  for (const r of rows) { const t = (by[r.tag] ??= { n: 0, ok: 0 }); t.n++; if (r.got === r.use) t.ok++; }
  const tp = rows.filter((r) => r.use && r.got).length, fp = rows.filter((r) => !r.use && r.got).length, fn = rows.filter((r) => r.use && !r.got).length;
  const ok = rows.filter((r) => r.got === r.use).length;
  return { rows, by, accuracy: ok / rows.length, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), misses: rows.filter((r) => r.got !== r.use) };
}

export const report = (name, s) => {
  const pct = (x) => (x * 100).toFixed(0) + "%";
  const lines = [`${name}: accuracy ${pct(s.accuracy)} · precision ${pct(s.precision)} · recall ${pct(s.recall)}`,
    ...Object.entries(s.by).map(([t, v]) => `  ${t.padEnd(9)} ${v.ok}/${v.n}`)];
  return lines.join("\n");
};

test("baseline: keyword router (wantsConnectors) — measured, not guessed", () => {
  const s = scoreRouter((text, apps) => loop.wantsConnectors(text, apps));
  console.log(report("keyword router", s));
  // Ratchet: this is the measured baseline. Improving the router raises it; it must never drop below it.
  assert.ok(s.accuracy >= 0.39, `accuracy ${s.accuracy}`);
});

const router = await loadSource("connectors/intent-router.ts");

test("new router (rules only; deferred cases count as misses = worst case)", () => {
  const s = scoreRouter((text, apps) => router.routeIntent(text, apps).use);
  const deferred = fixture.cases.filter((c) => router.routeIntent(c.text, fixture.connectedApps).mode === "defer");
  console.log(report("intent router", s));
  console.log(`  deferred to model: ${deferred.length}`);
  assert.ok(s.accuracy >= 0.95, `rules-only accuracy fell to ${s.accuracy}`);
  assert.equal(s.precision, 1, "the router must not send plain chat to the tools");
  for (const m of s.misses) console.log(`  MISS [${m.tag}] want ${m.use} got ${m.got}: ${m.text}  -> ${JSON.stringify(router.routeIntent(m.text, fixture.connectedApps).apps)} ${router.routeIntent(m.text, fixture.connectedApps).mode}`);
});

const heldout = JSON.parse(readFileSync(new URL("./fixtures/routing-heldout.json", import.meta.url), "utf8"));
test("held-out phrasings the rules were not tuned on", () => {
  const rows = heldout.cases.map((c) => ({ ...c, d: router.routeIntent(c.text, heldout.connectedApps) }));
  const ok = rows.filter((r) => r.d.use === r.use).length;
  const pos = rows.filter((r) => r.use), neg = rows.filter((r) => !r.use);
  console.log(`held-out: ${ok}/${rows.length} correct · apps: ${pos.length} requests needing tools (${pos.filter((r) => r.d.use).length} caught, ${pos.filter((r) => r.d.mode === "defer").length} deferred to model) · ${neg.length} chat-only (${neg.filter((r) => !r.d.use).length} kept chat-only)`);
  for (const r of rows.filter((r) => r.d.use !== r.use)) console.log(`  MISS [${r.tag}] ${r.d.mode}: ${r.text} -> ${JSON.stringify(r.d.apps)}`);
  const old = heldout.cases.filter((c) => loop.wantsConnectors(c.text, heldout.connectedApps) === c.use).length;
  console.log(`  old keyword router on the same set: ${old}/${rows.length}`);
  assert.ok(ok / rows.length >= 0.9, `held-out accuracy fell to ${ok / rows.length}`);
});
