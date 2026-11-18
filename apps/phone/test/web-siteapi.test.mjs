import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const api = await loadSource("web/siteapi.ts");

const json = (o) => JSON.stringify(o);
const results = (q) => json({ meta: { q }, data: { books: [{ title: `${q} one`, id: 1 }, { title: `${q} two`, id: 2 }] } });
const pageFor = (q) => [
  { method: "GET", url: "https://www.books.example/static/app.js", contentType: "application/javascript", response: "var x=1" },
  { method: "GET", url: "https://stats.example/collect?cid=777&t=pageview", contentType: "application/json", response: "{}" },
  { method: "GET", url: `https://api.books.example/v2/search?q=${encodeURIComponent(q)}&limit=10`, contentType: "application/json", status: 200, response: results(q) },
];

test("learning diffs two examples, ignores noise and finds the records path", () => {
  const spec = api.learnOperation({ site: "books", name: "search", trigger: "https://www.books.example/search?q={q}", examples: [{ q: "dune" }, { q: "the left hand of darkness" }], first: pageFor("dune"), second: pageFor("the left hand of darkness") });
  assert.ok(spec);
  assert.equal(spec.request.url, "https://api.books.example/v2/search?q={q}&limit=10");
  assert.equal(spec.records, "data.books");
  assert.deepEqual(spec.params, ["q"]);
  assert.ok(!JSON.stringify(spec).toLowerCase().includes("cookie"), "no credentials in specs");
});

test("an unrelated request that merely differs is not mistaken for the operation", () => {
  const noise = (n) => [{ method: "GET", url: `https://stats.example/collect?cid=${n}`, contentType: "application/json", response: "{}" }];
  assert.equal(api.learnOperation({ site: "s", name: "x", trigger: "https://s.example/?q={q}", examples: [{ q: "a" }, { q: "b" }], first: noise(1), second: noise(2) }), null);
  assert.equal(api.learnOperation({ site: "s", name: "x", trigger: "t", examples: [{ q: "same" }, { q: "same" }], first: pageFor("same"), second: pageFor("same") }), null, "identical examples teach nothing");
});

test("POST JSON bodies are templated and replayed", async () => {
  const cap = (q) => [{ method: "POST", url: "https://api.shop.example/graphql", body: json({ query: q, page: 1 }), contentType: "application/json", response: json({ hits: [{ name: q }] }) }];
  const spec = api.learnOperation({ site: "shop", name: "find", trigger: "https://shop.example/s/{q}", examples: [{ q: "mug" }, { q: "lamp" }], first: cap("mug"), second: cap("lamp") });
  assert.equal(spec.request.body, '{"query":"{q}","page":1}');
  let sent;
  const http = { bytes: async () => ({}), get: async () => { throw new Error("no get"); }, request: async (m, u, o) => { sent = { m, u, body: o.body }; return { status: 200, url: u, contentType: "application/json", text: json({ hits: [{ name: 'say "hi"' }] }) }; } };
  const res = await api.callOperation(spec, { q: 'say "hi"' }, { http, parse });
  assert.equal(res.ok, true);
  assert.equal(res.tier, 1);
  assert.deepEqual(JSON.parse(sent.body), { query: 'say "hi"', page: 1 }, "values are JSON-escaped, not injected");
  assert.deepEqual(res.data, [{ name: 'say "hi"' }]);
});

test("calling a learned GET operation returns trimmed records and validates parameters", async () => {
  const spec = api.learnOperation({ site: "books", name: "search", trigger: "https://www.books.example/search?q={q}", examples: [{ q: "dune" }, { q: "emma" }], first: pageFor("dune"), second: pageFor("emma") });
  const urls = [];
  const http = { bytes: async () => ({}), get: async (u) => { urls.push(u); return { status: 200, url: u, contentType: "application/json", text: results("piranesi") }; } };
  const ok = await api.callOperation(spec, { q: "pira nesi&x=1" }, { http, parse });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.length, 2);
  assert.equal(urls[0], "https://api.books.example/v2/search?q=pira%20nesi%26x%3D1&limit=10", "inputs cannot add parameters");
  const bad = await api.callOperation(spec, {}, { http, parse });
  assert.equal(bad.ok, false); assert.equal(bad.class, "params");
  const priv = await api.callOperation({ ...spec, request: { ...spec.request, url: "http://10.0.0.5/search?q={q}" } }, { q: "x" }, { http, parse });
  assert.equal(priv.class, "params");
});

test("failures are classified and the page-render tier recovers when the plain call is refused", async () => {
  const spec = api.learnOperation({ site: "books", name: "search", trigger: "https://www.books.example/search?q={q}", examples: [{ q: "dune" }, { q: "emma" }], first: pageFor("dune"), second: pageFor("emma") });
  const refused = { bytes: async () => ({}), get: async (u) => ({ status: 403, url: u, contentType: "text/html", text: "no" }) };
  const noRender = await api.callOperation(spec, { q: "x" }, { http: refused, parse });
  assert.equal(noRender.class, "auth");
  assert.match(noRender.next, /not try to bypass/);
  const render = async (url) => ({ url, html: "", seenUrls: [], requests: pageFor("x") });
  const viaPage = await api.callOperation(spec, { q: "x" }, { http: refused, parse, render });
  assert.equal(viaPage.ok, true);
  assert.equal(viaPage.tier, 2);
  const limited = await api.callOperation(spec, { q: "x" }, { http: { ...refused, get: async (u) => ({ status: 429, url: u, contentType: "", text: "" }) }, parse });
  assert.equal(limited.class, "blocked");
});

test("html operations extract records with selectors and fall back to rendering", async () => {
  const spec = api.htmlOperation({ site: "hn", name: "links", trigger: "https://news.example/from?site={domain}", params: ["domain"], examples: [{ domain: "a.com" }], items: "tr.athing", fields: { title: ".titleline > a", url: ".titleline > a@href" } });
  const html = `<table><tr class="athing"><td><span class="titleline"><a href="https://x.example/1">First</a></span></td></tr><tr class="athing"><td><span class="titleline"><a href="/item?id=2">Second</a></span></td></tr></table>`;
  const http = { bytes: async () => ({}), get: async (u) => ({ status: 200, url: u, contentType: "text/html", text: html }) };
  const res = await api.callOperation(spec, { domain: "arxiv.org" }, { http, parse });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.map((r) => r.title), ["First", "Second"]);
  const empty = { ...http, get: async (u) => ({ status: 200, url: u, contentType: "text/html", text: "<html><body>JS only</body></html>" }) };
  const viaRender = await api.callOperation(spec, { domain: "x" }, { http: empty, parse, render: async (url) => ({ url, html, requests: [], seenUrls: [] }) });
  assert.equal(viaRender.tier, 2);
  assert.equal(viaRender.data.length, 2);
});
