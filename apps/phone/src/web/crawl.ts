import type { Http } from "../products/browser";
import { isPublicHttpUrl } from "../products/browser";
import { Page, type Parse } from "./page";

/**
 * Polite crawler (Scrapling's Spider, rebuilt for a phone): bounded concurrency, per-site delay, robots.txt respected,
 * de-duplication, pause/resume state, and optional link following. It reads public pages only and does not try to defeat
 * bot protection: a site that says no gets skipped.
 */

export type Robots = { allow(path: string): boolean; crawlDelayMs: number };

export function parseRobots(text: string, agent = "ultron"): Robots {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; delay: number }> = [];
  let current: (typeof groups)[number] | null = null; let collecting = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase(); const value = (m[2] as string).trim();
    if (key === "user-agent") { if (!collecting || !current) { current = { agents: [], rules: [], delay: 0 }; groups.push(current); } current.agents.push(value.toLowerCase()); collecting = true; continue; }
    collecting = false;
    if (!current) continue;
    if (key === "disallow") current.rules.push({ allow: false, path: value });
    else if (key === "allow") current.rules.push({ allow: true, path: value });
    else if (key === "crawl-delay") current.delay = Math.min(30, Number(value) || 0) * 1000;
  }
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  const rules = group?.rules ?? [];
  const toRe = (p: string): RegExp => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  return {
    crawlDelayMs: group?.delay ?? 0,
    allow(path: string): boolean {
      let best: { len: number; allow: boolean } | null = null;
      for (const r of rules) {
        if (!r.path) continue;
        if (toRe(r.path).test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { len: r.path.length, allow: r.allow };
      }
      return best ? best.allow : true;
    },
  };
}

export type CrawlResult = { url: string; finalUrl: string; status: number; ok: boolean; error?: string; title: string; markdown: string; text: string; links: Array<{ text: string; url: string }>; fetchedAt: number; published?: string };

export type CrawlOptions = {
  maxPages: number; concurrency: number; perDomainDelayMs: number; respectRobots: boolean; sameSiteOnly: boolean; follow: boolean;
  maxPerDomain: number; targetOk?: number; timeoutMs: number; maxChars: number; allow?: RegExp; deny?: RegExp; signal?: AbortSignal;
  onResult?: (r: CrawlResult, stats: { done: number; failed: number; queued: number }) => void;
};

export const CRAWL_DEFAULTS: CrawlOptions = { maxPages: 30, concurrency: 6, perDomainDelayMs: 800, respectRobots: true, sameSiteOnly: true, follow: false, maxPerDomain: 4, timeoutMs: 15000, maxChars: 24000 };

export type CrawlState = { queue: string[]; seen: string[]; done: number; failed: number; perDomain: Record<string, number> };

export type CrawlDeps = { http: Http; parse: Parse; now?: () => number; sleep?: (ms: number) => Promise<void> };

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw); u.hash = "";
    for (const k of Array.from(u.searchParams.keys())) if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    let s = u.toString(); if (s.endsWith("/") && u.pathname === "/" && !u.search) s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

export class Crawler {
  private queue: string[] = []; private seen = new Set<string>(); private done = 0; private failed = 0; private skipped = 0; private started = 0; private perDomain = new Map<string, number>();
  private robots = new Map<string, Promise<Robots>>(); private nextAt = new Map<string, number>(); private seedHosts = new Set<string>();
  private readonly opts: CrawlOptions; private readonly now: () => number; private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CrawlDeps, options: Partial<CrawlOptions> = {}) {
    this.opts = { ...CRAWL_DEFAULTS, ...options };
    this.now = deps.now ?? Date.now; this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  seed(urls: string[]): void {
    for (const raw of urls) {
      const url = normalizeUrl(raw);
      if (!url || !isPublicHttpUrl(url) || this.seen.has(url)) continue;
      this.seen.add(url); this.queue.push(url); this.seedHosts.add(new URL(url).hostname.replace(/^www\./, ""));
    }
  }

  state(): CrawlState { return { queue: [...this.queue], seen: [...this.seen], done: this.done, failed: this.failed, perDomain: Object.fromEntries(this.perDomain) }; }
  restore(s: CrawlState): void { this.started = 0; this.queue = [...s.queue]; this.seen = new Set(s.seen); this.done = s.done; this.failed = s.failed; this.perDomain = new Map(Object.entries(s.perDomain)); for (const u of s.seen) this.seedHosts.add(new URL(u).hostname.replace(/^www\./, "")); }

  private robotsFor(origin: string): Promise<Robots> {
    let p = this.robots.get(origin);
    if (!p) {
      p = this.deps.http.get(`${origin}/robots.txt`, { timeoutMs: 8000 }).then((r) => (r.status >= 200 && r.status < 300 && !/<html/i.test(r.text.slice(0, 300)) ? parseRobots(r.text) : { allow: () => true, crawlDelayMs: 0 })).catch(() => ({ allow: () => true, crawlDelayMs: 0 }));
      this.robots.set(origin, p);
    }
    return p;
  }

  private async fetchOne(url: string): Promise<CrawlResult> {
    const base: CrawlResult = { url, finalUrl: url, status: 0, ok: false, title: "", markdown: "", text: "", links: [], fetchedAt: this.now() };
    try {
      const res = await this.deps.http.get(url, { timeoutMs: this.opts.timeoutMs, headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" } });
      base.status = res.status; base.finalUrl = res.url || url;
      if (res.status >= 400) return { ...base, error: `HTTP ${res.status}` };
      if (!isPublicHttpUrl(base.finalUrl)) return { ...base, error: "redirected to a private address" };
      if (/application\/pdf|image\/|video\/|audio\/|zip/i.test(res.contentType)) return { ...base, error: `not a page (${res.contentType})` };
      if (/json|text\/plain/i.test(res.contentType) && !/<html/i.test(res.text.slice(0, 400))) return { ...base, ok: true, title: url, markdown: res.text.slice(0, this.opts.maxChars), text: res.text.slice(0, this.opts.maxChars) };
      const page = new Page(res.text, base.finalUrl, this.deps.parse);
      const markdown = page.markdown(this.opts.maxChars);
      return { ...base, ok: markdown.length > 0, title: page.title(), markdown, text: page.text().slice(0, this.opts.maxChars), links: page.links().slice(0, 150), published: page.published(), error: markdown ? undefined : "no readable text" };
    } catch (error) { return { ...base, error: error instanceof Error ? error.message : "fetch failed" }; }
  }

  async run(): Promise<CrawlResult[]> {
    const results: CrawlResult[] = [];
    let active = 0;
    const aborted = (): boolean => this.opts.signal?.aborted === true;
    /** Claims the next eligible URL. The claim itself is synchronous, so two workers can never take the same page or overshoot the budget. */
    const takeNext = async (): Promise<string | "none" | "later"> => {
      for (let guard = 0; guard < 10000; guard++) {
        if (this.started >= this.opts.maxPages || (this.opts.targetOk !== undefined && this.done >= this.opts.targetOk)) return "none";
        let candidate: string | null = null; let blockedByWait = false;
        for (let i = 0; i < this.queue.length; i++) {
          const url = this.queue[i] as string; const host = new URL(url).hostname;
          if ((this.perDomain.get(host) ?? 0) >= this.opts.maxPerDomain) { this.queue.splice(i--, 1); continue; }
          if ((this.nextAt.get(host) ?? 0) > this.now()) { blockedByWait = true; continue; }
          candidate = url; break;
        }
        if (!candidate) return blockedByWait ? "later" : "none";
        const u = new URL(candidate);
        if (this.opts.respectRobots) {
          const robots = await this.robotsFor(u.origin);
          const at = this.queue.indexOf(candidate);
          if (at < 0) continue;
          if (!robots.allow(u.pathname + u.search)) { this.queue.splice(at, 1); this.skipped++; continue; }
          if (robots.crawlDelayMs > (this.nextAt.get(`${u.hostname}:delay`) ?? 0)) this.nextAt.set(`${u.hostname}:delay`, robots.crawlDelayMs);
          if ((this.nextAt.get(u.hostname) ?? 0) > this.now()) return "later";
        }
        const at = this.queue.indexOf(candidate);
        if (at < 0 || this.started >= this.opts.maxPages) continue;
        this.queue.splice(at, 1);
        this.started++;
        this.perDomain.set(u.hostname, (this.perDomain.get(u.hostname) ?? 0) + 1);
        this.nextAt.set(u.hostname, this.now() + Math.max(this.opts.perDomainDelayMs, this.nextAt.get(`${u.hostname}:delay`) ?? 0));
        return candidate;
      }
      return "none";
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted()) return;
        const next = await takeNext();
        if (next === "none") { if (active === 0) return; await this.sleep(25); if (this.started >= this.opts.maxPages || this.queue.length === 0) { if (active === 0) return; } continue; }
        if (next === "later") { await this.sleep(50); continue; }
        active++;
        try {
          const r = await this.fetchOne(next);
          results.push(r);
          if (r.ok) this.done++; else this.failed++;
          if (r.ok && this.opts.follow) this.enqueueLinks(r);
          this.opts.onResult?.(r, { done: this.done, failed: this.failed, queued: this.queue.length });
        } finally { active--; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency) }, worker));
    return results;
  }

  private enqueueLinks(r: CrawlResult): void {
    const origin = new URL(r.finalUrl).hostname.replace(/^www\./, "");
    for (const l of r.links) {
      const url = normalizeUrl(l.url);
      if (!url || this.seen.has(url) || !isPublicHttpUrl(url)) continue;
      if (this.opts.sameSiteOnly && new URL(url).hostname.replace(/^www\./, "") !== origin) continue;
      if (this.opts.allow && !this.opts.allow.test(url)) continue;
      if (this.opts.deny?.test(url)) continue;
      this.seen.add(url); this.queue.push(url);
    }
  }
}
