import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const dr = await loadSource("products/deep-research.ts");

const TOPIC = "sleep better";
const article = (i) => `<html><head><title>Sleep article ${i}</title></head><body><article>
<p>Adults who sleep better usually keep a consistent bedtime, and studies of 1200 people found that 83% improved within 14 days when they avoided screens late at night.</p>
<p>You should avoid caffeine after noon because it reduces deep sleep and makes it harder to sleep better the next night.</p>
<p>Subscribe to our newsletter for more updates and read our privacy policy about cookies on this site today.</p>
<p>${"A routine of dim lights and cool rooms helps people sleep better and wake feeling rested every morning. ".repeat(3)}</p></article></body></html>`;
const unrelated = `<html><head><title>Cats</title></head><body><article><p>${"Cats enjoy sitting on warm windowsills during the afternoon hours of the day. ".repeat(10)}</p></article></body></html>`;

function webWith(n, hostCount = 60) {
  const calls = { search: 0, pages: 0, hosts: new Map() };
  const http = {
    bytes: async () => ({ status: 404, mime: "", base64: "" }),
    get: async (url) => {
      if (url.includes("duckduckgo")) {
        calls.search++;
        const base = calls.search * 14;
        const items = Array.from({ length: 14 }, (_, k) => { const id = base + k; return `<a class="result__a" href="https://site${id % hostCount}.example/post-${id}">Result ${id}</a><a class="result__snippet">snippet ${id}</a>`; }).join("");
        return { status: 200, url, contentType: "text/html", text: items };
      }
      if (url.includes("wikipedia.org/w/api")) return { status: 200, url, contentType: "application/json", text: JSON.stringify({ query: { search: [{ title: "Sleep", snippet: "x" }] } }) };
      if (url.endsWith("robots.txt")) return { status: 404, url, contentType: "", text: "" };
      calls.pages++;
      const host = new URL(url).hostname; calls.hosts.set(host, (calls.hosts.get(host) ?? 0) + 1);
      if (/post-(3|7)\b/.test(url)) return { status: 404, url, contentType: "text/html", text: "" };
      return { status: 200, url, contentType: "text/html", text: /post-1[0-5]\b/.test(url) ? unrelated : article(url.length) };
    },
  };
  return { http, calls };
}

test("queries expand into many distinct angles", () => {
  const q = dr.expandQueries("sleep better", ["sleep science"]);
  assert.ok(q.length >= 20 && new Set(q).size === q.length);
  assert.equal(q[0], "sleep science");
});

test("digests keep fact-bearing, on-topic sentences and drop boilerplate", () => {
  const { digest } = dr.digestPage("# T\n\n" + [
    "Adults who sleep better usually keep a consistent bedtime, and studies of 1200 people found that 83% improved.",
    "Subscribe to our newsletter for more updates and read our privacy policy about cookies on this site today.",
    "Cats enjoy sitting on warm windowsills during the afternoon hours of the day in most homes.",
  ].join("\n\n"), new Set(dr.tokens("sleep better")));
  assert.match(digest, /83%/);
  assert.ok(!/newsletter|Cats/.test(digest));
});

test("reads ~150 useful sources politely, dedupes, numbers them and condenses in batches", async () => {
  const { http, calls } = webWith(400, 400);
  const progress = []; const condensed = []; let clock = 0;
  const res = await dr.deepResearch(http, parse, TOPIC, {
    target: 150, concurrency: 8, sleep: async (ms) => { clock += ms; }, onProgress: (p) => progress.push(p.phase),
    condense: async (batch) => { condensed.push(batch); return `- finding from ${batch.split("\n")[0].slice(0, 5)}`; },
  });
  assert.ok(res.digests.length >= 100, `read ${res.digests.length}`);
  assert.ok(res.digests.length <= 150);
  assert.deepEqual(res.digests.slice(0, 3).map((d) => d.n), [1, 2, 3]);
  assert.equal(new Set(res.digests.map((d) => d.url)).size, res.digests.length, "no source twice");
  assert.ok([...calls.hosts.values()].every((n) => n <= 2), "at most two pages per site");
  assert.ok(condensed.length >= 4 && condensed.every((b) => b.split("\n").length <= 25), "model sees small batches");
  assert.ok(res.notes.length > 0 && res.notes.length <= 6000);
  assert.ok(["search", "read", "condense"].every((p) => progress.includes(p)));
  assert.ok(res.digests.every((d) => !/Cats enjoy/.test(d.digest)), "off-topic pages are not counted as sources");
  assert.ok(res.digests.every((d) => !/newsletter/.test(d.digest)));
});

test("works with no model (extractive notes) and survives a failing condense step", async () => {
  const { http } = webWith(60, 60);
  const plain = await dr.deepResearch(http, parse, TOPIC, { target: 30, sleep: async () => {} });
  assert.ok(plain.notes.includes("[1]"));
  const broken = await dr.deepResearch(http, parse, TOPIC, { target: 30, sleep: async () => {}, condense: async () => { throw new Error("rate limited"); } });
  assert.ok(broken.notes.includes("[1]"), "falls back to the raw digests");
});

test("each chapter gets the sources most relevant to it", () => {
  const digests = [
    { n: 1, title: "Caffeine and sleep", url: "https://a.example", digest: "Avoid caffeine after noon because it reduces deep sleep.", score: 6 },
    { n: 2, title: "Bedroom temperature", url: "https://b.example", digest: "Cool rooms around 18 degrees help people fall asleep faster.", score: 6 },
    { n: 3, title: "Budget tips", url: "https://c.example", digest: "Track every expense for a month before cutting costs.", score: 6 },
  ];
  const picked = dr.digestsForSection(digests, "Caffeine and the afternoon crash", "Explain how caffeine timing affects sleep");
  assert.equal(picked[0].n, 1);
  assert.ok(!picked.some((d) => d.n === 3));
});

test("aborting stops reading promptly", async () => {
  const { http, calls } = webWith(400, 400);
  const controller = new AbortController();
  const res = await dr.deepResearch(http, parse, TOPIC, { target: 150, sleep: async () => {}, signal: controller.signal, onProgress: (p) => { if (p.phase === "read" && p.done >= 10) controller.abort(); } });
  assert.ok(res.digests.length < 60, `stopped early (${res.digests.length})`);
  assert.ok(calls.pages < 80);
});
