import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const b = await loadSource("products/browser.ts");

const DDG = `<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbudget-guide&amp;rut=abc">Budget Guide &amp; Tips</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbudget-guide">A <b>simple</b> way to budget on one income.</a></div>
<div class="result"><a class="result__a" href="https://second.example.org/post">Second result</a><a class="result__snippet" href="x">Another snippet.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F192.168.0.1%2Fadmin">Router</a></div>`;

const PAGE = `<html><head><title>Budget &amp; Calm</title><meta name="description" content="How to budget calmly."><script>var x="<p>no</p>"</script><style>p{}</style></head>
<body><nav><a href="/menu">Menu</a></nav><header>Site header</header><article><h1>Budget calmly</h1><p>${"Most people struggle with budgets because the plan is too big. ".repeat(10)}</p><p>Second paragraph with a <a href="/related">related guide</a> and <a href="javascript:alert(1)">bad</a>.</p></article><footer>Copyright</footer></body></html>`;

test("only public http(s) URLs are allowed", () => {
  for (const ok of ["https://example.com/a", "http://news.site/x?y=1", "https://8.8.8.8/"]) assert.equal(b.isPublicHttpUrl(ok), true, ok);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://localhost:8080", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://router.local/", "https://user:pw@example.com/", "ftp://example.com"]) assert.equal(b.isPublicHttpUrl(bad), false, bad);
});

test("DuckDuckGo results are unwrapped and private targets dropped", () => {
  const hits = b.parseDuckDuckGo(DDG);
  assert.deepEqual(hits.map((h) => h.url), ["https://example.com/budget-guide", "https://second.example.org/post"]);
  assert.equal(hits[0].title, "Budget Guide & Tips");
  assert.equal(hits[0].snippet, "A simple way to budget on one income.");
});

test("pages are reduced to readable text with resolved links and no scripts", () => {
  const page = b.htmlToReadable(PAGE, "https://example.com/post");
  assert.equal(page.title, "Budget & Calm");
  assert.equal(page.description, "How to budget calmly.");
  assert.ok(page.text.includes("Most people struggle"));
  assert.ok(!page.text.includes("Site header") && !page.text.includes("Copyright") && !page.text.includes("var x"));
  assert.deepEqual(page.links.map((l) => l.url), ["https://example.com/related"]);
  assert.deepEqual(page.headings, ["Budget calmly"]);
});

test("fetchPage refuses private addresses, redirects into them and error pages", async () => {
  const http = { get: async (url) => ({ status: 200, url, text: PAGE, contentType: "text/html" }), bytes: async () => ({ status: 200, mime: "image/png", base64: "" }) };
  await assert.rejects(b.fetchPage(http, "http://192.168.0.2/"), /public/);
  await assert.rejects(b.fetchPage({ ...http, get: async () => ({ status: 200, url: "http://10.0.0.1/", text: PAGE, contentType: "text/html" }) }, "https://example.com/"), /private/);
  await assert.rejects(b.fetchPage({ ...http, get: async (url) => ({ status: 503, url, text: "", contentType: "" }) }, "https://example.com/"), /503/);
  const ok = await b.fetchPage(http, "https://example.com/post");
  assert.equal(ok.title, "Budget & Calm");
});

test("research merges public sources into notes and survives a failing source", async () => {
  const http = {
    bytes: async () => ({ status: 404, mime: "", base64: "" }),
    get: async (url) => {
      if (url.includes("duckduckgo")) return { status: 200, url, text: DDG, contentType: "text/html" };
      if (url.includes("wikipedia.org/w/api")) throw new Error("offline");
      if (url.includes("openlibrary")) return { status: 200, url, contentType: "application/json", text: JSON.stringify({ docs: [{ title: "The Budget Book", author_name: ["A. Writer"], first_publish_year: 2018, key: "/works/OL1W" }] }) };
      return { status: 200, url, text: PAGE, contentType: "text/html" };
    },
  };
  const r = await b.research(http, "budgeting");
  assert.ok(r.notes.includes('"The Budget Book" (A. Writer, 2018)'));
  assert.ok(r.notes.includes("Top web results: Budget Guide & Tips"));
  assert.ok(r.notes.includes("Page excerpts:"));
  assert.ok(r.sources.length >= 3);
  assert.ok(r.sources.every((s) => b.isPublicHttpUrl(s.url)));
});

test("trending headlines fall back to Wikipedia and illustrations are validated", async () => {
  const http = {
    get: async (url) => {
      if (url.includes("trends.google")) throw new Error("blocked");
      return { status: 200, url, contentType: "application/json", text: JSON.stringify({ items: [{ articles: [{ article: "Main_Page" }, { article: "Sleep_hygiene" }, { article: "Index_fund" }, { article: "Special:Search" }, { article: "Houseplant" }, { article: "Budget" }, { article: "Sourdough" }] }] }) };
    },
    bytes: async (url) => (url.includes("tiny") ? { status: 200, mime: "image/png", base64: "AAAA" } : { status: 200, mime: "image/jpeg", base64: "A".repeat(4000) }),
  };
  assert.deepEqual((await b.trendingHeadlines(http)).slice(0, 2), ["Sleep hygiene", "Index fund"]);
  assert.equal((await b.generateIllustration(http, "a wallet", "calm"))?.mime, "image/jpeg");
  assert.equal(await b.generateIllustration({ ...http, bytes: async () => ({ status: 200, mime: "text/html", base64: "A".repeat(4000) }) }, "x", ""), null);
  assert.equal(await b.generateIllustration({ ...http, bytes: async () => ({ status: 200, mime: "image/png", base64: "AAAA" }) }, "x", ""), null);
});
