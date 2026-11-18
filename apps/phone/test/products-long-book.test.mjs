import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { jsPDF } = require("jspdf");
const engine = await loadSource("products/engine.ts");
const pdf = await loadSource("products/pdf.ts");
const book = await loadSource("products/book.ts");
const types = await loadSource("products/types.ts");
const prompts = await loadSource("products/prompts.ts");

const font = (rel) => readFileSync(require.resolve(`@expo-google-fonts/${rel}`)).toString("base64");
const fonts = { display: font("merriweather/700Bold/Merriweather_700Bold.ttf"), body: font("open-sans/400Regular/OpenSans_400Regular.ttf"), bodyBold: font("open-sans/700Bold/OpenSans_700Bold.ttf") };
const realPages = (p) => pdf.buildPdfWithInfo(p, { jsPDF, fonts }).pages;

const SENT = "Most people think the problem is effort but the plan usually breaks in the same two places each week and fixing those two places matters more than extra discipline";
/** Writes ~`words` words of unique paragraphs in the dialect. A stingy model returns far less than asked, like real ones do. */
const writing = (words, tag) => {
  const per = SENT.split(" ").length; const n = Math.max(2, Math.round(words / per));
  return `## ${tag} heading\n` + Array.from({ length: n }, (_, i) => `${SENT} (${tag} ${i}). [${(i % 9) + 1}]`).join("\n\n") + `\n\n> RULE: Fix the step, not your willpower, then repeat it daily for two weeks.\n`;
};

function product(depth, chapters, bonuses) {
  const p = engine.newProduct("household budgeting", "guided", { complete: async () => "" });
  p.custom.depth = depth; p.custom.imageCount = 0; p.pocket = { id: "p", directionId: "d", statement: "I help.", industry: "Finance", niche: "n", knowledge: "k", problem: "p", scores: { pain: 7, worsening: 7, purchasing: 7, speed: 7 }, overall: 7, rationale: "" };
  p.title = "The Payday Map"; p.summary = { title: "The Payday Map", subtitle: "Calm budgeting", about: "", learn: [], glossary: [], wordRange: [1, 2], readingMinutes: 5, bonuses: [] };
  const mk = (kind, title) => ({ id: `s${p.sections.length + 1}`, position: p.sections.length + 1, kind, title, purpose: `Explain ${title}`, status: "queued", words: 0, blocks: [] });
  p.sections = [mk("intro", "Start Here"), ...Array.from({ length: chapters }, (_, i) => mk("chapter", `Chapter ${i + 1} topic`)), mk("conclusion", "Keep Going"), ...Array.from({ length: bonuses }, (_, i) => mk("bonus", `Bonus ${i + 1}`))];
  p.research = { query: "q", notes: "n", sources: [], deep: true, digests: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, title: `Source ${i + 1}`, url: `https://s${i + 1}.example/page`, digest: `Digest about topic ${i + 1} and budgeting habits.`, score: 6 })) };
  return p;
}

/** A model that under-delivers: asks for ~1000 words, writes ~300. Returns call counts so two-part writing is visible. */
function stingyModel(wordsPerCall = 300) {
  const stats = { calls: 0, firstHalf: 0, secondHalf: 0, expand: 0 };
  const complete = async (messages) => {
    const user = messages[messages.length - 1].content; stats.calls++;
    if (user.includes("is already written. Headings so far")) { stats.expand++; return writing(wordsPerCall, "More"); }
    if (user.includes("SECOND half")) { stats.secondHalf++; return writing(wordsPerCall, "Second"); }
    if (user.includes("FIRST half")) stats.firstHalf++;
    if (/write (?:the FIRST half of )?the (?:intro|chapter|conclusion|bonus material) titled/.test(user)) return writing(wordsPerCall, "First");
    throw new Error("unexpected prompt " + user.slice(0, 60));
  };
  return { complete, stats };
}

for (const [depth, chapters, bonuses, target] of [["book45", 12, 2, 45], ["book50", 14, 3, 50]]) {
  test(`${depth}: a stingy model still ends at ${target}+ measured PDF pages, chapters are written in two parts`, async () => {
    const { complete, stats } = stingyModel(130);
    const env = { complete, sleep: async () => {}, concurrency: 2, measurePages: realPages };
    const p = product(depth, chapters, bonuses);
    await engine.writeManuscript(p, env);
    assert.ok(p.sections.every((s) => s.status === "done"));
    assert.equal(stats.firstHalf, chapters + 2, "intro, chapters and conclusion are written in two parts");
    assert.equal(stats.secondHalf, chapters + 2);
    const before = realPages(p);
    assert.ok(before < target, `the first draft is too short on purpose (${before} pages)`);
    const res = await engine.expandToTarget(p, env, target);
    assert.ok(res.pages >= target, `reached ${res.pages} of ${target}`);
    assert.ok(res.pages <= target + 8, `did not wildly overshoot (${res.pages})`);
    assert.equal(realPages(p), res.pages, "the reported length is the real PDF length");
    assert.ok(stats.expand > 0 && res.rounds >= 1);
  });
}

test("expansion stops when the model gives nothing new, instead of looping forever", async () => {
  const p = product("book45", 4, 1);
  const { complete } = stingyModel(130);
  await engine.writeManuscript(p, { complete, sleep: async () => {}, concurrency: 2 });
  let calls = 0;
  const res = await engine.expandToTarget(p, { complete: async () => { calls++; return "Too short."; }, sleep: async () => {}, concurrency: 2, measurePages: realPages }, 45);
  assert.ok(res.pages < 45); assert.equal(res.added, 0); assert.ok(calls <= 6);
});

test("page estimate tracks the real layout", async () => {
  const blocks = await loadSource("products/blocks.ts");
  const p = product("book45", 6, 1);
  p.sections.forEach((s, i) => { s.status = "done"; s.blocks = blocks.normalizeBlocks(blocks.parseBlocks(writing(500 + i * 120, "Est"))); s.words = blocks.countWords(s.blocks); });
  const est = types.estimatePages(p.sections);
  const real = realPages(p);
  assert.ok(Math.abs(est - real) <= Math.max(4, real * 0.15), `estimate ${est} vs real ${real}`);
});

test("sources: cited ones are listed in every export, and the section prompt carries numbered notes", () => {
  const p = product("book45", 2, 0);
  p.sections.forEach((s) => { s.status = "done"; s.words = 300; s.blocks = [{ type: "paragraph", text: "A claim from the research [2] and another one [7]. More text here to be long enough." }, { type: "paragraph", text: "Third [3], fourth [4], fifth [5], sixth [6]." }]; });
  const list = book.usedSources(p);
  assert.deepEqual(list.map((x) => x.n), [2, 3, 4, 5, 6, 7]);
  assert.match(book.buildHtml(p), /Sources and further reading[^]*https:\/\/s2\.example\/page/);
  assert.match(book.buildMarkdown(p), /\[7\] Source 7 — https:\/\/s7\.example\/page/);
  const notes = prompts.sourceNotes({ ...p, research: p.research }, "budgeting habits", "Explain budgeting habits");
  assert.match(notes, /\[\d+\] Digest about topic/);
  assert.match(notes, /never invent/);
  const noDeep = { ...p, research: { query: "q", notes: "n", sources: [] } };
  assert.equal(book.usedSources(noDeep).length, 0);
  assert.equal(prompts.sourceNotes(noDeep, "x", "y"), "");
});
