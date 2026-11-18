import { searchWeb, searchWikipedia, type Http, type SearchHit } from "./browser";
import { Crawler, normalizeUrl, type CrawlResult } from "../web/crawl";
import type { Parse } from "../web/page";

/**
 * Deep research: expand a topic into many searches, discover far more pages than we need, read them politely in parallel,
 * boil each page down to its most relevant sentences, and hand the model compact, numbered notes it can ground a book in.
 * Everything cited was actually fetched and read.
 */

export type SourceDigest = { n: number; title: string; url: string; digest: string; score: number };
export type DeepResearch = { query: string; notes: string; digests: SourceDigest[]; attempted: number; read: number; deep: true };

const STOP = new Set("the a an and or of to in on for with is are was were be been it its as at by from that this these those you your how what why when who which can will not no yes do does did have has had but if then than so such into about more most some any all new best top".split(" "));

export const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));

export function expandQueries(topic: string, extra: string[] = []): string[] {
  const t = topic.trim().replace(/\s+/g, " ").slice(0, 100);
  const base = [t, `${t} guide`, `${t} for beginners`, `${t} common mistakes`, `${t} expert tips`, `${t} step by step`, `${t} checklist`, `${t} examples`, `${t} case study`,
    `${t} research`, `${t} statistics`, `${t} common problems`, `${t} myths`, `${t} how to start`, `${t} routine`, `${t} tools`, `${t} cost`, `${t} FAQ`, `best way to ${t}`, `${t} mistakes to avoid`, `${t} what works`, `${t} before and after`];
  return [...new Set([...extra.map((q) => q.trim()).filter(Boolean), ...base])];
}

/** The sentences of a page most likely to carry facts about the topic: keyword overlap plus a bonus for numbers and specifics. */
export function digestPage(markdown: string, topicTokens: Set<string>, maxChars = 420): { digest: string; score: number } {
  const sentences = markdown.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`|-]{1,}\s*/g, " ").split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 50 && s.length <= 320);
  const scored = sentences.map((s, i) => {
    const toks = tokens(s); let hit = 0; for (const t of toks) if (topicTokens.has(t)) hit++;
    const specifics = (s.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).length;
    const advice = /\b(should|must|avoid|try|start|use|need|because|mistake|tip|step|rule|means|helps|causes|reduce|increase)\b/i.test(s) ? 1 : 0;
    const junk = /(cookie|subscribe|newsletter|privacy policy|all rights reserved|sign up|log in|advertis|click here|terms of)/i.test(s) ? 5 : 0;
    return { s, i, score: hit * 3 + Math.min(specifics, 3) + advice - junk };
  }).filter((x) => x.score >= 4).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.i - b.i);
  let digest = ""; for (const x of scored) { if ((digest + " " + x.s).length > maxChars) break; digest = (digest + " " + x.s).trim(); }
  return { digest, score: scored.reduce((n, x) => n + x.score, 0) };
}

export type DeepOptions = {
  target?: number; concurrency?: number; extraQueries?: string[]; signal?: AbortSignal;
  /** Optional model step that condenses a batch of numbered digests. Receives text, returns bullets. */
  condense?: (batch: string, topic: string) => Promise<string>;
  onProgress?: (p: { phase: "search" | "read" | "condense"; done: number; total: number; label: string }) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function deepResearch(http: Http, parse: Parse, topic: string, options: DeepOptions = {}): Promise<DeepResearch> {
  const target = options.target ?? 150;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const topicTokens = new Set(tokens(topic));
  const queries = expandQueries(topic, options.extraQueries);
  const pool = new Map<string, SearchHit>(); const perDomain = new Map<string, number>();
  const add = (h: SearchHit): void => {
    const url = normalizeUrl(h.url); if (!url) return;
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (pool.has(url) || (perDomain.get(host) ?? 0) >= 2) return;
    pool.set(url, { ...h, url }); perDomain.set(host, (perDomain.get(host) ?? 0) + 1);
  };

  // 1. Discover. Searches are spaced out so search engines do not rate-limit the phone.
  let qDone = 0;
  for (const q of queries) {
    if (options.signal?.aborted || pool.size >= target * 2) break;
    const [web, wiki] = await Promise.all([searchWeb(http, q, 14).catch(() => [] as SearchHit[]), qDone < 6 ? searchWikipedia(http, q, 4).catch(() => [] as SearchHit[]) : Promise.resolve([] as SearchHit[])]);
    for (const h of [...web, ...wiki]) add(h);
    qDone++;
    options.onProgress?.({ phase: "search", done: qDone, total: queries.length, label: `${pool.size} pages found from ${qDone} searches` });
    await sleep(350);
  }

  // 2. Read. A polite crawler with a per-site cap; stop once enough relevant pages have been read.
  const digests: SourceDigest[] = []; let read = 0; let relevant = 0;
  const hits = [...pool.values()];
  const byUrl = new Map(hits.map((h) => [h.url, h]));
  // Stop reading as soon as the target of useful pages is reached.
  const stop = new AbortController(); options.signal?.addEventListener("abort", () => stop.abort());
  const crawler = new Crawler({ http, parse, sleep }, {
    maxPages: Math.min(hits.length, Math.ceil(target * 1.8)), concurrency: options.concurrency ?? 8, perDomainDelayMs: 600, maxPerDomain: 2, follow: false, timeoutMs: 15000, maxChars: 30000, signal: stop.signal,
    onResult: (r: CrawlResult) => {
      read++;
      if (r.ok) {
        const { digest, score } = digestPage(r.markdown, topicTokens);
        if (digest) { relevant++; const hit = byUrl.get(r.url); digests.push({ n: 0, title: (r.title || hit?.title || r.url).slice(0, 140), url: r.finalUrl || r.url, digest, score }); if (relevant >= target) stop.abort(); }
      }
      options.onProgress?.({ phase: "read", done: Math.min(relevant, target), total: target, label: `Read ${read} pages, ${relevant} useful` });
    },
  });
  crawler.seed(hits.map((h) => h.url));
  await crawler.run();

  digests.sort((a, b) => b.score - a.score);
  const kept = digests.slice(0, target).map((d, i) => ({ ...d, n: i + 1 }));

  // 3. Condense. Batches keep each model call small enough for free-tier context windows.
  let notes = "";
  if (options.condense && kept.length) {
    const parts: string[] = []; const size = 25; const batches = Math.ceil(kept.length / size);
    for (let b = 0; b < batches; b++) {
      if (options.signal?.aborted) break;
      const slice = kept.slice(b * size, (b + 1) * size);
      options.onProgress?.({ phase: "condense", done: b, total: batches, label: `Condensing sources ${b * size + 1}–${b * size + slice.length}` });
      try { const text = await options.condense(slice.map((d) => `[${d.n}] ${d.digest}`).join("\n"), topic); if (text.trim()) parts.push(text.trim()); } catch { /* a failed batch only loses its own summary */ }
    }
    notes = parts.join("\n").slice(0, 6000);
  }
  if (!notes) notes = kept.slice(0, 14).map((d) => `[${d.n}] ${d.digest}`).join("\n").slice(0, 4000);
  return { query: topic, notes, digests: kept, attempted: hits.length, read, deep: true };
}

/** The digests most relevant to one chapter, so each chapter is grounded in its own sources instead of one global blob. */
export function digestsForSection(digests: SourceDigest[], title: string, purpose: string, limit = 6): SourceDigest[] {
  const want = new Set(tokens(`${title} ${title} ${purpose}`));
  return digests.map((d) => { const overlap = tokens(d.digest + " " + d.title).reduce((n, t) => n + (want.has(t) ? 1 : 0), 0); return { d, overlap, s: overlap + d.score / 40 }; }).filter((x) => x.overlap > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.d);
}
