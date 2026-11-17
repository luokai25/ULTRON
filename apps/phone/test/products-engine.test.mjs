import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const engine = await loadSource("products/engine.ts");
const blocks = await loadSource("products/blocks.ts");
const json = await loadSource("products/json.ts");
const scoring = await loadSource("products/scoring.ts");

const MD = `## The Hidden Week
Most people think the problem is effort. Count the hours instead: write down one ordinary week and mark where it broke.

> SORTING CHECK: If the same step fails twice, fix the step, not your willpower.

- [ ] Write the week down
- [ ] Mark two failures

::timeline WEEKLY ORDER
- Monday | Protect the basics | LOCKED IN | Pay fixed costs first.
- Friday | Review | VISIBLE | Look at the week.
::end

::table
| Step | Time |
| Write | 10 min |
::end

::image A notebook beside a calendar and a cup of coffee

Keep the change small enough to survive a bad day. A step that takes five minutes and gets repeated beats a perfect system that lasts four days, which is why the rest of this book leans on it.`;

test("extractJson survives fences, prose and trailing commas", () => {
  assert.deepEqual(json.extractJson('Sure!\n```json\n{"a":[1,2,],"b":"x"}\n```'), { a: [1, 2], b: "x" });
  assert.deepEqual(json.extractJson('Here you go: {"a": {"b": "}"}} thanks'), { a: { b: "}" } });
  assert.throws(() => json.extractJson("no json here"));
});

test("overall score follows the fitted weights and ranking marks one recommended pocket", () => {
  assert.equal(scoring.overallScore({ pain: 9, worsening: 9, purchasing: 9, speed: 8 }), 8.9);
  assert.equal(scoring.overallScore({ pain: 9, worsening: 8, purchasing: 9, speed: 9 }), 8.8);
  assert.equal(scoring.overallScore({ pain: 8, worsening: 9, purchasing: 8, speed: 8 }), 8.3);
  const mk = (id, s) => ({ id, scores: { pain: s, worsening: s, purchasing: s, speed: s } });
  const ranked = scoring.rankPockets([mk("a", 5), mk("b", 9), mk("c", 7)]);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "c", "a"]);
  assert.equal(ranked.filter((p) => p.recommended).length, 1);
  assert.equal(ranked[0].recommended, true);
});

test("the markdown dialect becomes typed blocks and renders safely", () => {
  const parsed = blocks.normalizeBlocks(blocks.parseBlocks(MD));
  assert.deepEqual(parsed.map((b) => b.type), ["heading", "paragraph", "callout", "checklist", "timeline", "table", "image", "paragraph"]);
  const callout = parsed.find((b) => b.type === "callout");
  assert.equal(callout.label, "SORTING CHECK");
  assert.equal(parsed.find((b) => b.type === "timeline").steps[0].tag, "LOCKED IN");
  assert.equal(parsed.find((b) => b.type === "table").rows[0][1], "10 min");
  assert.ok(blocks.countWords(parsed) > 50);
  const html = blocks.blocksToHtml([{ type: "paragraph", text: "<script>alert(1)</script> **bold**" }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("<strong>bold</strong>"));
});

/** A scripted fake model that answers every pipeline stage the way a well-behaved provider would. */
function fakeModel(log = []) {
  const calls = { n: 0, sections: 0, failSectionOnce: new Set() };
  const complete = async (messages, opts) => {
    calls.n++;
    const user = messages[messages.length - 1].content;
    const pick = (needle) => user.includes(needle);
    log.push(user.slice(user.indexOf("Task:"), user.indexOf("Task:") + 40));
    if (pick("expand this input into")) return JSON.stringify({ directions: Array.from({ length: 12 }, (_, i) => ({ title: `Direction ${i + 1} for budgeting`, category: `Cat ${i % 5}` })) });
    if (pick("profitable pocket")) {
      const ids = [...user.matchAll(/- (d\d+):/g)].map((m) => m[1]);
      return JSON.stringify({ pockets: ids.flatMap((id, i) => [0, 1].map((k) => ({ directionId: id, statement: `I help people ${id} stop overspending number ${k} without spreadsheets.`, industry: "Personal Finance", niche: "Budgets", knowledge: "Know-how and existing books show a market.", problem: "Money disappears before payday; they learn a routine in 14 days." }))) });
    }
    if (pick("score each pocket")) {
      const ids = [...user.matchAll(/- (p\d+):/g)].map((m) => m[1]);
      return JSON.stringify({ scores: ids.map((id, i) => ({ id, pain: 5 + (i % 5), worsening: 6, purchasing: 5 + (i % 4), speed: 6, rationale: "ok" })) });
    }
    if (pick("write product outline option")) {
      const label = user.match(/option ([ABC])/)[1];
      return JSON.stringify({ name: `Method ${label}`, promise: `Within 14 days, ${label}.`, fromTo: "From stressed to calm", chapters: Array.from({ length: 7 }, (_, i) => ({ title: `Chapter ${i + 1} ${label}`, purpose: "Teach." })) });
    }
    if (pick("Visceral Transformation Map")) return JSON.stringify({ rows: ["Emotional State", "Core Fear", "Daily Experience", "Identity"].map((label) => ({ label, before: "Before text.", after: "After text." })), stages: Array.from({ length: 5 }, (_, i) => ({ stage: `Stage ${i + 1}`, goal: "Goal", description: "Do it." })) });
    if (pick("produce the eBook summary")) return JSON.stringify({ title: "The Payday Map", subtitle: "A calm way to budget", about: "About.", learn: ["a", "b", "c", "d"], glossary: [{ term: "Payday Map", meaning: "A weekly plan" }], bonuses: [{ title: "Diagnostic", kind: "diagnostic" }, { title: "Card", kind: "card" }] });
    if (pick("plan the chapters")) return JSON.stringify({ sections: [{ kind: "intro", title: "Start Here", purpose: "Hook" }, ...Array.from({ length: 7 }, (_, i) => ({ kind: "chapter", title: `Chapter ${i + 1}`, purpose: "Teach" })), { kind: "conclusion", title: "Keep Going", purpose: "Recap" }, { kind: "bonus", title: "Diagnostic", purpose: "Check" }, { kind: "bonus", title: "Card", purpose: "Card" }] });
    if (pick("write the intro") || pick("write the chapter") || pick("write the conclusion") || pick("write the bonus material")) {
      calls.sections++;
      const title = user.match(/titled "([^"]+)"/)[1];
      if (calls.failSectionOnce.has(title)) { calls.failSectionOnce.delete(title); throw new Error("provider hiccup"); }
      opts.onToken?.("## Part");
      const withImage = user.includes('"::image');
      return MD.replace("::image A notebook beside a calendar and a cup of coffee", withImage ? `::image ${title} picture` : "::image extra image one\n\n::image extra image two");
    }
    if (pick("design the book's branding")) return JSON.stringify({ palette: { page: "#ffffff", type: "#ffffff", accent: "#fefefe", tint: "#eeeeee", muted: "#fafafa" }, displayFont: "Comic Sans", bodyFont: "Open Sans", style: "flat", mood: "calm", coverPrompt: "a wallet" });
    if (pick("write the sales page copy")) return JSON.stringify({ headline: "Budget calmly", subhead: "Sub", bullets: ["x", "y"], priceSuggestion: "$15", faq: [{ q: "Q", a: "A" }] });
    throw new Error("unexpected prompt: " + user.slice(0, 80));
  };
  return { complete, calls };
}

test("full pipeline: discovery, outlines, map, summary, manuscript, branding, store", async () => {
  const { complete, calls } = fakeModel();
  const saved = [];
  const progress = [];
  const env = { complete, sleep: async () => {}, concurrency: 2, persist: (p) => { saved.push(p.stage); }, progress: (e) => progress.push(e.phase) };
  const product = engine.newProduct("household budgeting", "guided", env);
  await engine.discoverPockets(product, env);
  assert.equal(product.directions.length, 12);
  assert.equal(product.pockets.length, 24);
  assert.equal(product.pockets.filter((p) => p.recommended).length, 1);
  assert.ok(product.pockets[0].overall >= product.pockets[23].overall);
  assert.ok(["directions", "brainstorm", "score"].every((phase) => progress.includes(phase)));

  product.pocket = product.pockets[0];
  await engine.generateOutlines(product, env);
  assert.deepEqual(product.outlines.map((o) => o.label), ["A", "B", "C"]);
  engine.approveOutline(product, product.outlines[1].id, env);
  assert.equal(product.title, "Method B");
  assert.equal(product.stage, "customise");

  const vtm = await engine.buildVtm(product, env);
  assert.equal(vtm.rows.length, 4);
  assert.equal(vtm.stages.length, 5);
  await engine.buildSummary(product, env);
  assert.equal(product.title, "The Payday Map");
  assert.ok(product.summary.readingMinutes >= 5);
  await engine.planChapters(product, env);
  assert.equal(product.sections.length, 11);
  assert.equal(product.sections[0].kind, "intro");
  assert.equal(product.sections.at(-1).kind, "bonus");

  calls.failSectionOnce.add("Chapter 3");
  await engine.writeManuscript(product, env);
  assert.ok(product.sections.every((s) => s.status === "done"), product.sections.map((s) => s.status + (s.error ?? "")).join());
  assert.ok(product.sections.every((s) => s.words >= 60));
  const images = product.sections.flatMap((s) => s.blocks).filter((b) => b.type === "image");
  assert.equal(images.length, product.custom.imageCount, "extra image slots are dropped");
  assert.ok(product.runningSummary.includes("Start Here"));

  const brand = await engine.designBranding(product, env);
  assert.equal(brand.displayFont, "Merriweather", "fonts are restricted to the allow-list");
  assert.ok(engine.contrast(brand.page, brand.type) >= 7, "unreadable palettes are replaced");
  await engine.buildStore(product, env);
  assert.equal(product.store.headline, "Budget calmly");
  assert.ok(product.charter.structure.length === 11);
  assert.deepEqual(engine.qualityReport(product).issues.filter((i) => /not written/.test(i)), []);
  assert.ok(saved.length > 10, "progress is persisted as it happens");
});

test("a stopped manuscript resumes without redoing finished sections", async () => {
  const { complete, calls } = fakeModel();
  const controller = new AbortController();
  const env = { complete, sleep: async () => {}, concurrency: 1, signal: controller.signal, progress: (e) => { if (e.phase === "section" && e.index === 3) controller.abort(); } };
  const product = engine.newProduct("budgeting", "guided", env);
  product.pocket = { id: "p1", directionId: "d1", statement: "I help a without b.", industry: "Finance", niche: "n", knowledge: "k", problem: "p", scores: { pain: 7, worsening: 7, purchasing: 7, speed: 7 }, overall: 7, rationale: "" };
  await engine.generateOutlines(product, { ...env, signal: undefined, progress: undefined });
  engine.approveOutline(product, product.outlines[0].id, env);
  await engine.buildSummary(product, { ...env, signal: undefined });
  await engine.planChapters(product, { ...env, signal: undefined });
  await assert.rejects(engine.writeManuscript(product, env), (e) => e.name === "AbortError");
  const doneBefore = product.sections.filter((s) => s.status === "done").length;
  assert.ok(doneBefore >= 1 && doneBefore < 11, `partial progress kept (${doneBefore})`);
  const callsBefore = calls.sections;
  await engine.writeManuscript(product, { complete, sleep: async () => {}, concurrency: 2 });
  assert.ok(product.sections.every((s) => s.status === "done"));
  assert.equal(calls.sections - callsBefore, 11 - doneBefore, "only the missing sections are written");
});

test("askJson retries with the model's own bad output and gives up cleanly", async () => {
  let n = 0;
  const env = { complete: async () => (++n < 3 ? "not json" : '{"ok":true}'), sleep: async () => {} };
  assert.deepEqual(await engine.askJson(env, "x", (r) => r), { ok: true });
  assert.equal(n, 3);
  n = -10;
  await assert.rejects(engine.askJson({ ...env, complete: async () => "nope" }, "x", (r) => r));
});
