import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { jsPDF } = require("jspdf");
const fflate = require("fflate");
const blocks = await loadSource("products/blocks.ts");
const epub = await loadSource("products/epub.ts");
const pdf = await loadSource("products/pdf.ts");
const book = await loadSource("products/book.ts");
const intent = await loadSource("products/intent.ts");

const font = (rel) => readFileSync(require.resolve(`@expo-google-fonts/${rel}`)).toString("base64");
const fonts = { display: font("merriweather/700Bold/Merriweather_700Bold.ttf"), body: font("open-sans/400Regular/OpenSans_400Regular.ttf"), bodyBold: font("open-sans/700Bold/OpenSans_700Bold.ttf") };

const MD = `## The Hidden Week
Most people think the problem is effort. Count the hours instead, with **bold** text, café, “quotes” and ünïcödé.

> CHECK: Fix the step, not your willpower.

- [ ] Write the week down

::timeline WEEK
- Monday | Basics | LOCKED | Pay fixed costs first.
::end

::table
| Step | Time |
| Write | 10 min |
::end

::image A notebook beside a calendar

${"Keep the change small enough to survive a bad day. ".repeat(40)}`;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const section = (i, kind, title) => ({ id: `s${i}`, position: i, kind, title, purpose: "", status: "done", words: 300, blocks: blocks.normalizeBlocks(blocks.parseBlocks(MD)).map((b) => (b.type === "image" ? { ...b, assetId: "img1" } : b)) });
const product = {
  id: "prod_test1", schema: 1, title: "t", createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z", mode: "guided", topic: "household budgeting",
  directions: [], pockets: [], pocket: { industry: "Personal Finance", niche: "Budgets" }, outlines: [], custom: {}, images: [{ id: "img1", prompt: "A notebook", mime: "image/png", data: PNG }],
  sections: [section(1, "intro", "Start Here"), section(2, "chapter", "Where Time Goes"), section(3, "conclusion", "Keep Going"), { ...section(4, "bonus", "Unfinished"), status: "queued", blocks: [] }],
  summary: { title: "The Payday Map", subtitle: "Calm budgeting for one income", about: "", learn: [], glossary: [], wordRange: [1, 2], readingMinutes: 5, bonuses: [] },
  brand: { page: "#f6f1e9", type: "#2b2a27", accent: "#b5532f", tint: "#ead9c5", muted: "#6b6760", displayFont: "Merriweather", bodyFont: "Open Sans", style: "", mood: "", coverPrompt: "" },
  stage: "done", runningSummary: "", history: [], source: "tab",
};

test("EPUB has the required structure, only finished sections, and embeds images", () => {
  const bytes = epub.buildEpub(product, fflate, null);
  const files = fflate.unzipSync(bytes);
  assert.equal(Object.keys(files)[0], "mimetype", "mimetype must be the first entry");
  assert.equal(fflate.strFromU8(files["mimetype"]), "application/epub+zip");
  assert.ok(files["META-INF/container.xml"] && files["OEBPS/content.opf"] && files["OEBPS/nav.xhtml"] && files["OEBPS/toc.ncx"]);
  const chapters = Object.keys(files).filter((f) => /chapter\d+\.xhtml$/.test(f));
  assert.equal(chapters.length, 3, "the unfinished bonus section is left out");
  assert.ok(Object.keys(files).some((f) => /images\/img1\.png$/.test(f)));
  const opf = fflate.strFromU8(files["OEBPS/content.opf"]);
  assert.match(opf, /<dc:title>The Payday Map<\/dc:title>/);
  assert.match(opf, /urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  for (const f of chapters) assert.ok(!fflate.strFromU8(files[f]).includes("data:image"), "images are files, not data URIs");
});

test("PDF is a 6x9 book with embedded fonts, a contents page and all finished sections", () => {
  const bytes = pdf.buildPdf(product, { jsPDF, fonts });
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), "%PDF-");
  const text = Buffer.from(bytes).toString("latin1");
  assert.match(text, /MediaBox \[0 0 432\.?\d* 648\.?\d*\]/, "6 x 9 inch pages");
  assert.ok(Number(text.match(/\/Count (\d+)/)?.[1]) >= 6, "cover, title, contents and sections");
  assert.match(text, /BookDisplay/);
  assert.match(text, /BookBody/);
});

test("HTML and Markdown exports are complete and escape unsafe text", () => {
  const evil = { ...product, summary: { ...product.summary, title: "<script>alert(1)</script>" } };
  assert.ok(!book.buildHtml(evil).includes("<script>alert(1)"));
  const md = book.buildMarkdown(product);
  assert.match(md, /Where Time Goes/);
  assert.ok(!md.includes("Unfinished"));
});

test("chat hand-off only triggers on explicit requests to make a digital product", () => {
  assert.deepEqual(intent.detectProductIntent("make me an ebook about sourdough baking for beginners"), { topic: "sourdough baking for beginners" });
  assert.deepEqual(intent.detectProductIntent("Create a digital product on budgeting for single parents please"), { topic: "budgeting for single parents" });
  assert.deepEqual(intent.detectProductIntent("can you write an ebook"), { topic: "" });
  assert.equal(intent.detectProductIntent("how do I write an ebook?"), null);
  assert.equal(intent.detectProductIntent("what is a digital product"), null);
  assert.equal(intent.detectProductIntent("write a python function to parse a guide.json file"), null);
  assert.equal(intent.detectProductIntent("summarize this ebook for me"), null);
});
