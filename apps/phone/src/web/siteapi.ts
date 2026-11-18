import type { Http } from "../products/browser";
import { isPublicHttpUrl } from "../products/browser";
import { Page, type Parse } from "./page";
import type { CapturedRequest, Renderer } from "./render";

/**
 * "Teach a site once": api-anything's approach, rebuilt for the phone. Watch a page make its own request for two different inputs,
 * diff the two requests to see which parts are the inputs, keep a template, then replay it as a plain HTTP call. When the plain
 * call stops working it falls back to rendering the page in the hidden WebView. Credentials and cookies are never written into
 * specs; replays use whatever cookies the device already holds for that site.
 */

export type OpSpec = {
  id: string; site: string; name: string; kind: "http" | "html";
  trigger: string; params: string[]; examples: Array<Record<string, string>>;
  request?: { method: string; url: string; headers: Record<string, string>; body?: string };
  records?: string; // dotted path to the array of records inside a JSON response
  html?: { items: string; fields: Record<string, string> };
  createdAt: number; lastOkAt?: number; failures: number;
};

export type CallResult =
  | { ok: true; tier: 1 | 2; data: unknown; ms: number }
  | { ok: false; class: "no-op" | "params" | "network" | "blocked" | "auth" | "changed" | "empty"; reason: string; next: string; ms: number };

const KEEP_HEADERS = new Set(["accept", "accept-language", "content-type", "x-requested-with", "x-csrf-token", "x-api-version"]);

const variants = (value: string): string[] => [...new Set([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, "+"), value.replace(/ /g, "+"), value.replace(/ /g, "%20")])].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);

/** Replaces each example value (in any common encoding) with {param}. Returns null when nothing was parameterised. */
function templatise(text: string, example: Record<string, string>): { template: string; used: string[] } {
  let out = text; const used: string[] = [];
  for (const [name, value] of Object.entries(example)) {
    let hit = false;
    for (const v of variants(value)) if (out.includes(v)) { out = out.split(v).join(`{${name}}`); hit = true; }
    if (hit) used.push(name);
  }
  return { template: out, used };
}

export function fillTemplate(template: string, params: Record<string, string>, mode: "url" | "json" | "raw"): string {
  return template.replace(/\{([A-Za-z_][\w]*)\}/g, (all, name: string) => {
    if (!(name in params)) return all;
    const v = String(params[name]);
    return mode === "url" ? encodeURIComponent(v) : mode === "json" ? JSON.stringify(v).slice(1, -1) : v;
  });
}

const looksJson = (c: CapturedRequest): boolean => /json/i.test(c.contentType ?? "") || /^\s*[[{]/.test(c.response ?? "");

/** Finds the first array of objects in a JSON value (breadth first, shallow) and returns its dotted path. */
export function findRecordsPath(value: unknown, maxDepth = 4): string | null {
  const queue: Array<{ v: unknown; path: string; d: number }> = [{ v: value, path: "", d: 0 }];
  while (queue.length) {
    const { v, path, d } = queue.shift() as { v: unknown; path: string; d: number };
    if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) return path;
    if (d < maxDepth && v && typeof v === "object" && !Array.isArray(v)) for (const [k, child] of Object.entries(v as Record<string, unknown>)) queue.push({ v: child, path: path ? `${path}.${k}` : k, d: d + 1 });
  }
  return null;
}
export function pick(value: unknown, path: string): unknown { return path ? path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), value) : value; }

export type LearnInput = { site: string; name: string; trigger: string; examples: [Record<string, string>, Record<string, string>]; first: CapturedRequest[]; second: CapturedRequest[] };

/** Diffs the page's requests for example A against example B and builds the best replayable template. */
export function learnOperation(input: LearnInput, now = Date.now()): OpSpec | null {
  const [exA, exB] = input.examples;
  const params = Object.keys(exA);
  if (!params.length || params.some((p) => !(p in exB) || exA[p] === exB[p])) return null;
  type Cand = { spec: OpSpec; score: number };
  const cands: Cand[] = [];
  for (const a of input.first) {
    if (!isPublicHttpUrl(a.url)) continue;
    const { template: urlT, used: urlUsed } = templatise(a.url, exA);
    const bodyT = a.body ? templatise(a.body, exA) : { template: "", used: [] as string[] };
    const used = [...new Set([...urlUsed, ...bodyT.used])];
    if (!used.length) continue;
    const mode = /json/i.test(a.contentType ?? "") || /^\s*[{[]/.test(a.body ?? "") ? "json" : "raw";
    // The same template, filled with example B, must reproduce a request the page really made for B.
    const expectUrl = fillTemplate(urlT, exB, "raw"); const expectBody = a.body ? fillTemplate(bodyT.template, exB, mode === "json" ? "raw" : "raw") : "";
    const match = input.second.find((b) => b.method === a.method && (sameUrl(b.url, expectUrl) || sameUrl(b.url, fillUrlEncoded(urlT, exB))) && (!a.body || normBody(b.body) === normBody(expectBody) || normBody(b.body) === normBody(fillBodyEncoded(bodyT.template, exB, mode))));
    if (!match) continue;
    let records: string | undefined; let size = 0;
    if (looksJson(a) && a.response) { try { const parsed = JSON.parse(a.response); records = findRecordsPath(parsed) ?? undefined; size = a.response.length; } catch { /* not JSON after all */ } }
    const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
    const spec: OpSpec = {
      id: `${input.site}:${input.name}`, site: input.site, name: input.name, kind: "http", trigger: input.trigger, params, examples: [exA, exB],
      request: { method: a.method, url: fillTemplate(urlT, {}, "raw"), headers, body: a.body ? bodyT.template : undefined }, records, createdAt: now, failures: 0,
    };
    cands.push({ spec, score: used.length * 1000 + (records ? 500 : 0) + (looksJson(a) ? 300 : 0) + Math.min(size, 100000) / 1000 });
  }
  cands.sort((x, y) => y.score - x.score);
  return cands[0]?.spec ?? null;
}

const sameUrl = (a: string, b: string): boolean => { try { const x = new URL(a); const y = new URL(b); x.searchParams.sort(); y.searchParams.sort(); return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search; } catch { return a === b; } };
const fillUrlEncoded = (t: string, p: Record<string, string>): string => fillTemplate(t, p, "url");
const fillBodyEncoded = (t: string, p: Record<string, string>, mode: "json" | "raw"): string => (mode === "json" ? fillTemplate(t, p, "json") : fillTemplate(t, p, "url"));
const normBody = (b: string | undefined): string => { if (!b) return ""; try { return JSON.stringify(JSON.parse(b)); } catch { return b; } };

export function htmlOperation(input: { site: string; name: string; trigger: string; params: string[]; examples: Array<Record<string, string>>; items: string; fields: Record<string, string> }, now = Date.now()): OpSpec {
  return { id: `${input.site}:${input.name}`, site: input.site, name: input.name, kind: "html", trigger: input.trigger, params: input.params, examples: input.examples, html: { items: input.items, fields: input.fields }, createdAt: now, failures: 0 };
}

export type CallContext = { http: Http; parse: Parse; render?: Renderer; now?: () => number };

const fail = (ms: number, cls: Extract<CallResult, { ok: false }>["class"], reason: string, next: string): CallResult => ({ ok: false, class: cls, reason, next, ms });

export async function callOperation(spec: OpSpec, params: Record<string, string>, ctx: CallContext): Promise<CallResult> {
  const t0 = (ctx.now ?? Date.now)();
  const elapsed = (): number => (ctx.now ?? Date.now)() - t0;
  const missing = spec.params.filter((p) => !(p in params) || params[p] === "");
  if (missing.length) return fail(0, "params", `Missing: ${missing.join(", ")}`, `Pass ${spec.params.map((p) => `${p}=...`).join(" ")}.`);
  try {
    if (spec.kind === "html" && spec.html) {
      const url = fillTemplate(spec.trigger, params, "url");
      if (!isPublicHttpUrl(url)) return fail(elapsed(), "params", "That address is not a public web page.", "Use a public https address.");
      const res = await ctx.http.get(url, { timeoutMs: 20000 });
      let html = res.text; let tier: 1 | 2 = 1;
      if (res.status >= 400 || !html) { if (!ctx.render) return classify(res.status, elapsed()); html = (await ctx.render(url)).html; tier = 2; }
      let rows = new Page(html, res.url || url, ctx.parse).records(spec.html.items, spec.html.fields);
      if (!rows.length && tier === 1 && ctx.render) { html = (await ctx.render(url)).html; tier = 2; rows = new Page(html, url, ctx.parse).records(spec.html.items, spec.html.fields); }
      return rows.length ? { ok: true, tier, data: rows, ms: elapsed() } : fail(elapsed(), "empty", "The page loaded but the selectors matched nothing.", "The site may have changed; learn this operation again.");
    }
    const r = spec.request;
    if (!r) return fail(0, "no-op", "This operation has no request template.", "Learn it again.");
    const url = fillTemplate(r.url, params, "url");
    if (!isPublicHttpUrl(url)) return fail(elapsed(), "params", "That address is not a public web page.", "Use a public https address.");
    const jsonBody = r.body && /^\s*[{[]/.test(r.body);
    const body = r.body ? fillTemplate(r.body, params, jsonBody ? "json" : "url") : undefined;
    const res = r.method.toUpperCase() === "GET" || !ctx.http.request ? await ctx.http.get(url, { headers: r.headers, timeoutMs: 20000 }) : await ctx.http.request(r.method, url, { headers: r.headers, body, timeoutMs: 20000 });
    if (res.status >= 200 && res.status < 300) {
      try {
        const json = JSON.parse(res.text);
        const data = spec.records ? pick(json, spec.records) : json;
        if (data !== undefined && !(Array.isArray(data) && !data.length)) return { ok: true, tier: 1, data: Array.isArray(data) ? data.slice(0, 100) : data, ms: elapsed() };
      } catch { /* HTML or text instead of JSON: treat as a failure of the template */ }
    }
    if (ctx.render) {
      const page = await ctx.render(fillTemplate(spec.trigger, params, "url"));
      const want = fillTemplate(r.url, params, "url");
      const hit = page.requests.find((c) => c.method === r.method.toUpperCase() && sameUrl(c.url, want) && c.response && looksJson(c)) ?? page.requests.find((c) => c.response && looksJson(c) && spec.records && (() => { try { return findRecordsPath(JSON.parse(c.response as string)) === spec.records; } catch { return false; } })());
      if (hit?.response) { try { const json = JSON.parse(hit.response); const data = spec.records ? pick(json, spec.records) : json; if (data !== undefined) return { ok: true, tier: 2, data: Array.isArray(data) ? data.slice(0, 100) : data, ms: elapsed() }; } catch { /* fall through */ } }
    }
    return classify(res.status, elapsed());
  } catch (error) {
    return fail(elapsed(), "network", error instanceof Error ? error.message : "Request failed", "Check the connection and try again.");
  }
}

function classify(status: number, ms: number): CallResult {
  if (status === 401 || status === 403) return fail(ms, "auth", `The site refused the request (HTTP ${status}).`, "It may need you to be signed in, or it blocks automated access. Ultron will not try to bypass that.");
  if (status === 429) return fail(ms, "blocked", "The site is rate limiting requests.", "Wait a few minutes and try again.");
  if (status >= 500) return fail(ms, "network", `The site had a server error (HTTP ${status}).`, "Try again later.");
  return fail(ms, "changed", `The learned request no longer returns data (HTTP ${status || "none"}).`, "The site probably changed. Learn this operation again.");
}
