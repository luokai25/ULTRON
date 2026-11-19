import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./_ts-loader.mjs";

const require = createRequire(import.meta.url);
const { parseHTML } = require("linkedom");
const parse = (html) => parseHTML(html).document;
const wr = await loadSource("connectors/web-research.ts");
const ct = await loadSource("connectors/chat-tools.ts");
const aw = await loadSource("connectors/awareness.ts");

const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const SERP = (items) => `<html><body><ol id="b_results">${items.map(([t, u, sn]) => `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc&u=a1${b64u(u)}&ntb=1">${t}</a></h2><div class="b_caption"><p>${sn}</p></div></li>`).join("")}</ol></body></html>`;
const NEWS = (items) => `<?xml version="1.0"?><rss><channel>${items.map(([t, u, d]) => `<item><title>${t}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=${encodeURIComponent(u)}&amp;c=1</link><description>About ${t}</description><pubDate>${d}</pubDate></item>`).join("")}</channel></rss>`;
const page = (title, body, date) => `<html><head><title>${title}</title>${date ? `<meta property="article:published_time" content="${date}">` : ""}</head><body><article>${body}</article></body></html>`;
const para = (s) => `<p>${s}</p>`;
const ANSWER = "The new battery plant in Reno opened on 12 March 2026 and employs 1500 workers, the company said, with a second line planned for 2027.";
const FILLER = "Welcome to our website where we publish many things about many topics every single day of the year for you.";

function world({ log = [], failBrowser = false } = {}) {
  const http = { bytes: async () => ({}), get: async (url) => {
    log.push(url);
    if (url.endsWith("/robots.txt")) return { status: 404, url, contentType: "", text: "" };
    if (url.includes("bing.com/news")) return { status: 200, url, contentType: "text/xml", text: NEWS([["Battery plant opens in Reno", "https://news.example/reno", "Thu, 12 Mar 2026 10:00:00 GMT"]]) };
    if (url.includes("duckduckgo")) return { status: 200, url, contentType: "text/html", text: `<a class="result__a" href="https://site1.example/plant">Plant overview</a><a class="result__snippet">overview snippet that is long enough to count as text here</a><a class="result__a" href="https://site2.example/jobs">Jobs at the plant</a><a class="result__snippet">jobs snippet text that is also long enough to count here</a>` };
    if (url.includes("wikipedia.org/w/api")) return { status: 200, url, contentType: "application/json", text: JSON.stringify({ query: { search: [] } }) };
    if (url.includes("news.example/reno")) return { status: 200, url, contentType: "text/html", text: page("Battery plant opens in Reno", para(FILLER) + para(ANSWER) + para(FILLER), "2026-03-12T10:00:00Z") };
    if (url.includes("site1.example")) return { status: 200, url, contentType: "text/html", text: page("Plant overview", para(FILLER) + para("Local officials say the plant will employ about 1500 workers when running at full capacity in Reno.") + para(FILLER)) };
    if (url.includes("site2.example")) return { status: 200, url, contentType: "text/html", text: page("Jobs at the plant", para("Hiring for the Reno battery plant continues, with 1500 positions listed across engineering and operations as of March 2026.") + para(FILLER)) };
    if (url.includes("empty.example")) return { status: 200, url, contentType: "text/html", text: "<html><body><div id='root'></div></body></html>" };
    return { status: 200, url, contentType: "text/html", text: page("Other " + url, para(FILLER)) };
  } };
  const renderer = async (url) => {
    log.push("RENDER " + url);
    if (failBrowser) throw new Error("webview failed");
    if (url.includes("bing.com/search")) return { url, html: SERP([["Battery plant opens in Reno - News", "https://news.example/reno", "snippet"], ["Reno plant jobs", "https://site2.example/jobs", "snippet"], ["JS-only page", "https://empty.example/spa", "snippet"]]), requests: [], seenUrls: [] };
    if (url.includes("empty.example")) return { url, html: page("Rendered SPA", para("After JavaScript ran, the page says the Reno battery plant produced its first 1500 cells in March 2026 according to the operator.")), requests: [], seenUrls: [] };
    return { url, html: "", requests: [], seenUrls: [] };
  };
  return { http, renderer };
}
const base = (over = {}) => ({ parse, status: () => {}, useBrowser: false, ...over });

test("Bing redirect links and news RSS are decoded to real URLs", () => {
  const u = "https://www.example.com/a path?x=1&y=é";
  assert.equal(wr.decodeBingUrl(`https://www.bing.com/ck/a?!&&p=1&u=a1${b64u(u)}&ntb=1`), u);
  assert.equal(wr.decodeBingUrl("http://www.bing.com/news/apiclick.aspx?ref=x&url=https%3a%2f%2fn.example%2fp&c=1"), "https://n.example/p");
  assert.equal(wr.decodeBingUrl("https://direct.example/x"), "https://direct.example/x");
  const hits = wr.parseBingSerp(SERP([["T1", "https://a.example/1", "S1"], ["Bing self link", "https://www.bing.com/images", "x"]]), parse);
  assert.deepEqual(hits.map((h) => [h.title, h.url, h.snippet]), [["T1", "https://a.example/1", "S1"]]);
  assert.equal(wr.parseNewsRss(NEWS([["N", "https://n.example/p", "Thu, 12 Mar 2026 10:00:00 GMT"]]))[0].date, "Thu, 12 Mar 2026 10:00:00 GMT");
});

test("rank fusion lifts pages found by several searches and caps each site", () => {
  const h = (u, t = u) => ({ title: t, url: u, snippet: "", source: "web" });
  const fused = wr.fuse([[h("https://a.example/1"), h("https://b.example/1")], [h("https://b.example/1"), h("https://a.example/2"), h("https://a.example/3")]], 2);
  assert.equal(fused[0].url, "https://b.example/1", "found twice, so first");
  assert.equal(fused.filter((x) => x.url.includes("a.example")).length, 2, "at most two per site");
});

test("passage extraction keeps the sentences that answer the question and drops boilerplate", () => {
  const md = [FILLER, ANSWER, "Subscribe to our newsletter and accept cookies from this site to get the latest updates every day.", FILLER].join("\n\n");
  const out = wr.bestPassages(md, new Set(["battery", "plant", "reno", "workers", "opened"]));
  assert.match(out, /1500 workers/);
  assert.ok(!/newsletter|Welcome to our website/.test(out));
});

test("planning: model-written queries are used, with a safe fallback", async () => {
  const q = await wr.planQueries("what's the latest on the Reno battery plant", [], base({ complete: async () => '{"queries":["Reno battery plant opening 2026","Reno battery plant jobs"]}' }));
  assert.deepEqual(q.slice(0, 2), ["Reno battery plant opening 2026", "Reno battery plant jobs"]);
  const fb = await wr.planQueries("what's the latest on the Reno battery plant", [], base({ complete: async () => "garbage", now: () => new Date("2026-11-19") }));
  assert.ok(fb.length >= 2 && fb.some((x) => x.includes("2026")));
  assert.ok((await wr.planQueries("x y z", [], base())).length >= 1);
});

test("research reads many pages across queries and returns dated, answer-bearing notes", async () => {
  const log = []; const { http, renderer } = world({ log });
  const out = await wr.webResearch("what's the latest on the Reno battery plant", [], base({ http, renderer, useBrowser: true, complete: async (m) => (/plan web searches/.test(m[0].content) ? '{"queries":["Reno battery plant 2026","Reno battery plant jobs"]}' : '{"enough":true,"queries":[]}') }));
  assert.ok(out.usedBrowser, "search results came through the browser engine");
  assert.ok(out.notes.length >= 4, `notes ${out.notes.length}`);
  assert.ok(out.notes.some((n) => /1500 workers/.test(n.passages)));
  assert.ok(out.notes.find((n) => n.host === "news.example").date.startsWith("2026-03-12"), "page dates are carried through");
  assert.ok(log.some((l) => l.includes("bing.com/news")), "time-sensitive questions also use the news feed");
  const spa = out.notes.find((n) => n.host === "empty.example");
  assert.match(spa?.passages ?? "", /first 1500 cells/, "script-built pages are rendered, not skipped");
});

test("when the first round is not enough, it searches again for what is missing", async () => {
  const log = []; const { http } = world({ log });
  let judged = 0;
  const complete = async (m) => { if (/plan web searches/.test(m[0].content)) return '{"queries":["zzz unrelated"]}'; judged++; return '{"enough":false,"queries":["Reno battery plant jobs 2026"]}'; };
  const out = await wr.webResearch("zzz unrelated question about Reno", [], base({ http, complete }));
  assert.equal(judged, 1); assert.equal(out.rounds, 2);
  assert.ok(out.queries.includes("Reno battery plant jobs 2026"));
});

test("without browser permission only plain HTTP is used; a failing browser degrades gracefully", async () => {
  const a = []; const w1 = world({ log: a });
  const noBrowser = await wr.webResearch("latest Reno battery plant news", [], base({ http: w1.http, renderer: w1.renderer, useBrowser: false }));
  assert.ok(!a.some((l) => l.startsWith("RENDER")), "renderer untouched without consent");
  assert.ok(noBrowser.notes.length >= 2);
  const w2 = world({ failBrowser: true });
  const degraded = await wr.webResearch("latest Reno battery plant news", [], base({ http: w2.http, renderer: w2.renderer, useBrowser: true }));
  assert.ok(degraded.notes.length >= 2, "falls back to the other engines");
});

test("chat: the first search asks for browser permission once, then remembers", async () => {
  let access = "unset"; let asked = 0; const { http, renderer } = world();
  const deps = () => ({ http, parse, renderer, complete: async () => '{"enough":true,"queries":[]}', approve: async () => "deny", status: () => {}, webEnabled: true, browserAccess: () => access, askBrowserAccess: async () => { asked++; access = "allowed"; return true; } });
  const r1 = await ct.gatherToolContext("what's the latest news on the Reno battery plant", [], deps());
  assert.equal(asked, 1); assert.equal(r1.usedWeb, true);
  assert.match(r1.context, /through the phone's browser engine/);
  await ct.gatherToolContext("latest news on the Reno battery plant jobs", [], deps());
  assert.equal(asked, 1, "never asked again");
  access = "denied"; const log2 = [];
  const w = world({ log: log2 });
  await ct.gatherToolContext("latest news on the Reno battery plant", [], { ...deps(), http: w.http, renderer: w.renderer });
  assert.ok(!log2.some((l) => l.startsWith("RENDER")), "a 'no' is respected");
  assert.equal(asked, 1);
});

test("Ultron is told what he can do, knows which apps are connected, and answers status questions directly", () => {
  const state = { status: "connected", tools: [1, 2, 3], groups: [{ id: "GMAIL", label: "Gmail", count: 2 }, { id: "COMPOSIO", label: "Composio", count: 4 }], connections: { text: JSON.stringify([{ toolkit: "slack", status: "ACTIVE" }, { toolkit: "notion", status: "INITIATED" }]), at: 1, ok: true }, syncedAt: 1700000000000, error: "" };
  const settings = { enabled: true, askBefore: true, allowedTools: [], webInChat: true };
  const prompt = aw.buildToolAwareness({ state, settings, browserAccess: "allowed", products: true });
  assert.match(prompt, /Connected apps \(via Composio\): ONLINE with 3 tools/);
  assert.match(prompt, /Apps the owner connected: (gmail, slack|slack, gmail)/); assert.doesNotMatch(prompt, /notion/, "apps that are not active are not claimed");
  assert.match(prompt, /never say you cannot browse/); assert.match(prompt, /phone's browser engine/);
  assert.match(aw.buildToolAwareness({ state: { ...state, status: "no-key" }, settings, browserAccess: "none", products: true }), /not connected/);
  for (const q of ["what apps do you have connected", "which connectors can you access", "what can you access", "is my gmail connected?"]) assert.equal(aw.asksAboutConnections(q), true, q);
  for (const q of ["write me a poem", "what is the capital of France"]) assert.equal(aw.asksAboutConnections(q), false, q);
  assert.match(aw.connectionsStatusContext(state, settings), /Connected apps: (gmail, slack|slack, gmail)/);
  const loop = null; void loop;
});
