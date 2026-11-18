import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const { Page } = await loadSource("web/page.ts");
const adaptive = await loadSource("web/adaptive.ts");
const sim = await loadSource("web/similarity.ts");

const V1 = `<html lang="en"><head><title>Shop</title><meta name="description" content="Things"><meta property="og:title" content="Shop OG">
<script type="application/ld+json">{"@type":"Product","name":"Mug"}</script></head><body>
<nav><a href="/menu">Menu</a></nav>
<div id="content"><div class="grid"><div class="product"><h2 class="name">Blue Mug</h2><span class="price">$12</span><a class="buy" href="/p/1">Buy</a></div>
<div class="product"><h2 class="name">Red Mug</h2><span class="price">$14</span><a class="buy" href="/p/2">Buy</a></div>
<div class="product"><h2 class="name">Green Mug</h2><span class="price">$9</span><a class="buy" href="/p/3">Buy</a></div></div></div></body></html>`;
// The same page after a redesign: every class name and wrapper changed.
const V2 = `<html lang="en"><body><header><a href="/menu">Menu</a></header><main><section class="listing-v2"><article class="card"><h2 class="card-title">Blue Mug</h2><b class="cost">$12</b><a class="cta" href="/p/1">Buy</a></article>
<article class="card"><h2 class="card-title">Red Mug</h2><b class="cost">$14</b><a class="cta" href="/p/2">Buy</a></article></section></main></body></html>`;

test("CSS, ::text, @attr and records behave like Scrapling's selectors", () => {
  const page = new Page(V1, "https://shop.example/list", parse);
  assert.deepEqual(page.values(".name::text"), ["Blue Mug", "Red Mug", "Green Mug"]);
  assert.deepEqual(page.values("a.buy@href"), ["https://shop.example/p/1", "https://shop.example/p/2", "https://shop.example/p/3"]);
  const rows = page.records(".product", { name: ".name", price: ".price", link: "a.buy@href" });
  assert.deepEqual(rows[1], { name: "Red Mug", price: "$14", link: "https://shop.example/p/2" });
  assert.equal(page.findByText("green mug", { tag: "h2" }).length, 1);
  assert.equal(page.findByRegex(/^\$\d+$/, "span").length, 3);
});

test("adaptive selection relocates an element after a redesign", async () => {
  const store = adaptive.memoryStore();
  const before = new Page(V1, "https://shop.example/list", parse, store);
  const saved = await before.select(".price", { key: "price", save: true });
  assert.equal(saved.elements.length, 3);
  assert.equal(store.size(), 1);
  const after = new Page(V2, "https://shop.example/list", parse, store);
  assert.equal((await after.select(".price", { key: "price" })).elements.length, 0, "without adaptive the stale selector finds nothing");
  const moved = await after.select(".price", { key: "price", adaptive: true });
  assert.equal(moved.relocated, true);
  assert.ok(moved.score >= 40);
  assert.equal(moved.elements[0].tagName.toLowerCase(), "b");
  assert.equal(moved.elements[0].textContent, "$12");
});

test("findSimilar returns sibling cards and structured() reads machine-readable data", () => {
  const page = new Page(V1, "https://shop.example/list", parse);
  const first = page.first(".product");
  assert.equal(page.findSimilar(first).length, 2);
  const s = page.structured();
  assert.equal(s.title, "Shop");
  assert.equal(s.openGraph["og:title"], "Shop OG");
  assert.deepEqual(s.jsonLd, [{ "@type": "Product", name: "Mug" }]);
  assert.equal(s.lang, "en");
});

test("markdown keeps headings, links and lists and drops navigation and scripts", () => {
  const html = `<html><body><nav><a href="/x">Skip me</a></nav><article><h1>Title</h1><p>Intro with <a href="/a">a link</a> and <strong>bold</strong>.</p><ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><script>evil()</script><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>${"<p>Body text. </p>".repeat(40)}</article><footer>Foot</footer></body></html>`;
  const md = new Page(html, "https://x.example/post", parse).markdown();
  assert.match(md, /^# Title/);
  assert.match(md, /\[a link\]\(https:\/\/x\.example\/a\)/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /- One/);
  assert.match(md, /  - Nested/);
  assert.match(md, /\| A \| B \|/);
  assert.ok(!md.includes("Skip me") && !md.includes("evil()") && !md.includes("Foot"));
});

test("main content detection prefers the text-dense block over navigation", () => {
  const html = `<html><body><div class="menu"><a href="/1">One</a><a href="/2">Two</a></div><div class="story">${"<p>This is a real paragraph of the article with enough words in it to count. </p>".repeat(8)}</div></body></html>`;
  const page = new Page(html, "https://x.example/", parse);
  assert.equal(page.mainNode().getAttribute("class"), "story");
});

test("text similarity is sensible", () => {
  assert.ok(sim.ratio("product-card item", "product-card  item") > 0.95);
  assert.ok(sim.ratio("abcdef", "uvwxyz") < 0.1);
  assert.equal(sim.jaccard(["a", "b"], ["a", "b"]), 1);
});
