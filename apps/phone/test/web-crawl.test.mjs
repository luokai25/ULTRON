import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const { Crawler, parseRobots, normalizeUrl } = await loadSource("web/crawl.ts");

const body = (title, links = []) => `<html><head><title>${title}</title></head><body><article>${"<p>Real content for the page here and there. </p>".repeat(12)}${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</article></body></html>`;

test("robots.txt: longest match wins, agent groups and crawl-delay are honoured", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/open\nCrawl-delay: 2\n\nUser-agent: ultron\nDisallow: /nope$\n`);
  assert.equal(r.allow("/anything"), true);
  assert.equal(r.allow("/nope"), false);
  assert.equal(r.allow("/nope/yes"), true, "the ultron group replaces the * group and only blocks the exact path");
  const star = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/open\nCrawl-delay: 2`);
  assert.equal(star.allow("/private/x"), false);
  assert.equal(star.allow("/private/open/page"), true);
  assert.equal(star.crawlDelayMs, 2000);
});

test("URLs are normalised so tracking variants are not fetched twice", () => {
  assert.equal(normalizeUrl("https://a.example/p?utm_source=x&b=2&a=1#top"), "https://a.example/p?a=1&b=2");
  assert.equal(normalizeUrl("https://a.example/"), "https://a.example");
});

test("crawler obeys robots, per-domain caps, private-address rules and delay, and reports results", async () => {
  let clock = 0;
  const fetched = [];
  const http = {
    bytes: async () => ({ status: 404, mime: "", base64: "" }),
    get: async (url) => {
      if (url.endsWith("/robots.txt")) return { status: 200, url, contentType: "text/plain", text: url.includes("blocked.example") ? "User-agent: *\nDisallow: /" : "User-agent: *\nDisallow: /secret" };
      fetched.push({ url, at: clock });
      if (url.includes("bad.example")) return { status: 500, url, contentType: "text/html", text: "" };
      if (url.includes("redirect.example")) return { status: 200, url: "http://10.0.0.1/", contentType: "text/html", text: body("x") };
      return { status: 200, url, contentType: "text/html", text: body("T " + url, ["/a", "/b", "/secret/x", "https://other.example/off"]) };
    },
  };
  const crawler = new Crawler({ http, parse, now: () => clock, sleep: async (ms) => { clock += ms; } }, { maxPages: 20, concurrency: 3, perDomainDelayMs: 500, follow: true, sameSiteOnly: true, maxPerDomain: 3 });
  crawler.seed(["https://one.example/", "https://blocked.example/x", "https://bad.example/", "http://192.168.1.5/", "https://redirect.example/", "https://one.example/"]);
  const seen = [];
  const results = await crawler.run();
  results.forEach((r) => seen.push(r.url));
  assert.ok(!seen.some((u) => u.includes("blocked.example")), "robots disallow is respected");
  assert.ok(!seen.some((u) => u.includes("192.168")), "private seeds are refused");
  assert.ok(!seen.some((u) => u.includes("/secret")), "robots disallow applies to followed links too");
  assert.ok(!seen.some((u) => u.includes("other.example")), "same-site only");
  const one = results.filter((r) => r.url.includes("one.example"));
  assert.equal(one.length, 3, "per-domain cap");
  assert.ok(one.every((r) => r.ok && r.title.startsWith("T ") && r.markdown.includes("Real content")));
  assert.equal(results.find((r) => r.url.includes("bad.example")).ok, false);
  assert.match(results.find((r) => r.url.includes("redirect.example")).error, /private/);
  const times = fetched.filter((f) => f.url.includes("one.example")).map((f) => f.at);
  assert.ok(times.slice(1).every((t, i) => t - times[i] >= 500), `requests to one site are spaced out (${times})`);
});

test("crawl state can be saved and restored", async () => {
  const http = { bytes: async () => ({ status: 404, mime: "", base64: "" }), get: async (url) => (url.endsWith("robots.txt") ? { status: 404, url, contentType: "", text: "" } : { status: 200, url, contentType: "text/html", text: body("p") }) };
  const a = new Crawler({ http, parse, sleep: async () => {} }, { maxPages: 1, perDomainDelayMs: 0 });
  a.seed(["https://s1.example/a", "https://s2.example/b", "https://s3.example/c"]);
  await a.run();
  const state = JSON.parse(JSON.stringify(a.state()));
  assert.equal(state.done, 1);
  assert.equal(state.queue.length, 2);
  const b = new Crawler({ http, parse, sleep: async () => {} }, { maxPages: 10, perDomainDelayMs: 0 });
  b.restore(state);
  const rest = await b.run();
  assert.equal(rest.length, 2);
});
