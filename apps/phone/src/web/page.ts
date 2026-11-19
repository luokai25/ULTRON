import { bestMatch, fingerprint, memoryStore, score, type AdaptiveStore, type ElementLike, type Fingerprint } from "./adaptive";
import { toMarkdown } from "./markdown";

/**
 * Scrapling's selection model for the phone: CSS, XPath, text and regex search, similar-element matching and adaptive
 * relocation, over a standard DOM. Parsing is injected so the same code runs in the WebView (DOMParser) and in tests.
 */

export type Parse = (html: string) => Document;
export const browserParse: Parse = (html) => new DOMParser().parseFromString(html, "text/html");

export type FieldSpec = Record<string, string>;
export type Table = { headers: string[]; rows: string[][] };
export type Structured = {
  title: string; description: string; canonical: string; lang: string;
  jsonLd: unknown[]; openGraph: Record<string, string>; state: Record<string, unknown>;
  tables: Table[]; headings: string[];
};

const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

export class Page {
  readonly doc: Document;
  constructor(readonly html: string, readonly url: string, parse: Parse = browserParse, private readonly store: AdaptiveStore = memoryStore()) { this.doc = parse(html); }

  /** Selects like Scrapling: `sel`, `sel::text` and `sel@attr` are all valid. Returns elements for plain selectors. */
  css(selector: string): Element[] {
    const { css } = splitSelector(selector);
    try { return Array.from(this.doc.querySelectorAll(css)); } catch { return []; }
  }
  first(selector: string): Element | null { return this.css(selector)[0] ?? null; }
  /** Values for `sel::text`, `sel@href`, or the elements' text when no accessor is given. */
  values(selector: string): string[] {
    const { css, attr, text } = splitSelector(selector);
    return this.css(css).map((el) => (attr ? el.getAttribute(attr) ?? "" : text || !attr ? norm(el.textContent) : "")).filter(Boolean).map((v) => (attr === "href" || attr === "src" ? this.resolve(v) : v));
  }
  resolve(href: string): string { try { return new URL(href, this.url).toString(); } catch { return href; } }

  xpath(expression: string): Element[] {
    const doc = this.doc as Document & { evaluate?: Document["evaluate"] };
    if (typeof doc.evaluate !== "function") return [];
    try {
      const snap = doc.evaluate(expression, this.doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      const out: Element[] = [];
      for (let i = 0; i < snap.snapshotLength; i++) { const n = snap.snapshotItem(i); if (n && n.nodeType === 1) out.push(n as Element); }
      return out;
    } catch { return []; }
  }

  findByText(text: string, options: { exact?: boolean; tag?: string; caseSensitive?: boolean } = {}): Element[] {
    const needle = options.caseSensitive ? norm(text) : norm(text).toLowerCase();
    const all = Array.from(this.doc.querySelectorAll(options.tag ?? "body *"));
    const hits = all.filter((el) => {
      const own = norm(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
      const hay = options.caseSensitive ? own : own.toLowerCase();
      return options.exact ? hay === needle : hay.includes(needle);
    });
    return hits;
  }

  findByRegex(pattern: RegExp, tag?: string): Element[] {
    return Array.from(this.doc.querySelectorAll(tag ?? "body *")).filter((el) => pattern.test(norm(Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "))));
  }

  /** Elements that look like `el`: same tag, similar class list and depth, similar neighbourhood. */
  findSimilar(el: Element, options: { threshold?: number; limit?: number } = {}): Element[] {
    const base = fingerprint(el as unknown as ElementLike);
    const out: Array<{ el: Element; s: number }> = [];
    for (const cand of Array.from(this.doc.getElementsByTagName(el.tagName))) {
      if (cand === el) continue;
      const fp = fingerprint(cand as unknown as ElementLike);
      if (fp.depth !== base.depth) continue;
      const s = score({ ...base, text: "" }, { ...fp, text: "" });
      if (s >= (options.threshold ?? 55)) out.push({ el: cand, s });
    }
    return out.sort((a, b) => b.s - a.s).slice(0, options.limit ?? 200).map((x) => x.el);
  }

  /**
   * Adaptive selection. With `save`, remembers what the matched element looks like under `key`. With `adaptive`, if the selector
   * finds nothing (the site changed), relocates the element that most resembles the remembered one.
   */
  async select(selector: string, options: { key?: string; save?: boolean; adaptive?: boolean } = {}): Promise<{ elements: Element[]; relocated: boolean; score?: number }> {
    const key = `${new URL(this.url).hostname}::${options.key ?? selector}`;
    const found = this.css(selector);
    if (found.length) {
      if (options.save) await this.store.set(key, fingerprint(found[0] as unknown as ElementLike));
      return { elements: found, relocated: false };
    }
    if (!options.adaptive) return { elements: [], relocated: false };
    const saved = await this.store.get(key);
    if (!saved) return { elements: [], relocated: false };
    const match = bestMatch(saved as Fingerprint, Array.from((this.doc.body ?? this.doc.documentElement).querySelectorAll("*")) as unknown as ElementLike[]);
    return match ? { elements: [match.element as unknown as Element], relocated: true, score: match.score } : { elements: [], relocated: false };
  }

  /** Publication or update date of the page when it declares one (meta tags, <time>, JSON-LD), as an ISO-ish string. */
  published(): string {
    const metas = ["meta[property='article:published_time']", "meta[property='og:article:published_time']", "meta[name='date']", "meta[name='pubdate']", "meta[itemprop='datePublished']", "meta[property='article:modified_time']"];
    for (const sel of metas) { const v = this.doc.querySelector(sel)?.getAttribute("content"); if (v && /\d{4}/.test(v)) return v.trim(); }
    const t = this.doc.querySelector("time[datetime]")?.getAttribute("datetime"); if (t && /\d{4}/.test(t)) return t.trim();
    for (const s of Array.from(this.doc.querySelectorAll("script[type='application/ld+json']"))) {
      const m = (s.textContent ?? "").match(/"date(?:Published|Modified)"\s*:\s*"([^"]+)"/); if (m?.[1]) return m[1];
    }
    return "";
  }

  text(): string { return norm(this.doc.body?.textContent); }
  title(): string { return norm(this.doc.querySelector("title")?.textContent); }
  markdown(maxChars = 40000): string { return toMarkdown(this.mainNode() as never, this.url, maxChars); }

  links(): Array<{ text: string; url: string }> {
    const out: Array<{ text: string; url: string }> = []; const seen = new Set<string>();
    for (const a of Array.from(this.doc.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
      const url = this.resolve(href).split("#")[0] as string;
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url); out.push({ text: norm(a.textContent).slice(0, 140), url });
    }
    return out;
  }

  /** The element holding the article: prefers <article>/<main>, otherwise the block with the most text per tag. */
  mainNode(): Element {
    const body = this.doc.body ?? this.doc.documentElement;
    for (const sel of ["article", "main", "[role=main]", "#content", ".content", ".post", ".entry-content"]) {
      const el = this.doc.querySelector(sel);
      if (el && norm(el.textContent).length > 500) return el;
    }
    let best: Element = body; let bestScore = 0;
    for (const el of Array.from(body.querySelectorAll("div,section,td"))) {
      if (/(nav|menu|footer|header|sidebar|comment|cookie|banner|advert)/i.test(`${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`)) continue;
      const paragraphs = el.querySelectorAll("p").length;
      const len = norm(el.textContent).length;
      const links = norm(Array.from(el.querySelectorAll("a")).map((a) => a.textContent).join(" ")).length;
      const s = paragraphs * 80 + len - links * 2;
      if (paragraphs >= 2 && s > bestScore) { best = el; bestScore = s; }
    }
    return best;
  }

  /** Repeated rows (products, results, stories) as records. `items` is a CSS selector; each field is `sel`, `sel::text` or `sel@attr`. */
  records(items: string, fields: FieldSpec, limit = 500): Array<Record<string, string>> {
    const out: Array<Record<string, string>> = [];
    for (const row of this.css(items).slice(0, limit)) {
      const rec: Record<string, string> = {};
      for (const [name, spec] of Object.entries(fields)) {
        const { css, attr } = splitSelector(spec);
        const target = css && css !== "." ? row.querySelector(css) : row;
        const raw = target ? (attr ? target.getAttribute(attr) ?? "" : norm(target.textContent)) : "";
        rec[name] = attr === "href" || attr === "src" ? (raw ? this.resolve(raw) : "") : raw;
      }
      if (Object.values(rec).some(Boolean)) out.push(rec);
    }
    return out;
  }

  /** Everything machine-readable on the page, without any selectors: JSON-LD, Open Graph, framework state, tables. */
  structured(): Structured {
    const jsonLd: unknown[] = [];
    for (const s of Array.from(this.doc.querySelectorAll("script[type='application/ld+json']"))) { try { const v = JSON.parse(s.textContent ?? ""); jsonLd.push(...(Array.isArray(v) ? v : [v])); } catch { /* ignore malformed blocks */ } }
    const og: Record<string, string> = {};
    for (const m of Array.from(this.doc.querySelectorAll("meta[property^='og:'],meta[name^='twitter:']"))) { const k = m.getAttribute("property") ?? m.getAttribute("name") ?? ""; const v = m.getAttribute("content") ?? ""; if (k && v) og[k] = v; }
    const state: Record<string, unknown> = {};
    const next = this.doc.querySelector("script#__NEXT_DATA__");
    if (next) { try { state.nextData = JSON.parse(next.textContent ?? ""); } catch { /* ignore */ } }
    for (const s of Array.from(this.doc.querySelectorAll("script:not([src])"))) {
      const m = (s.textContent ?? "").match(/window\.(__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__)\s*=\s*({[\s\S]*?});?\s*(?:$|<\/)/);
      if (m) { try { state[m[1] as string] = JSON.parse(m[2] as string); } catch { /* not plain JSON */ } }
    }
    const tables: Table[] = [];
    for (const t of Array.from(this.doc.querySelectorAll("table")).slice(0, 12)) {
      const rows = Array.from(t.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => norm(c.textContent)));
      const filled = rows.filter((r) => r.some(Boolean));
      if (filled.length >= 2) tables.push({ headers: filled[0] as string[], rows: filled.slice(1) });
    }
    return {
      title: this.title(), description: this.doc.querySelector("meta[name='description']")?.getAttribute("content")?.trim() ?? og["og:description"] ?? "",
      canonical: this.doc.querySelector("link[rel='canonical']")?.getAttribute("href") ?? this.url, lang: this.doc.documentElement.getAttribute("lang") ?? "",
      jsonLd, openGraph: og, state, tables, headings: Array.from(this.doc.querySelectorAll("h1,h2,h3")).map((h) => norm(h.textContent)).filter(Boolean).slice(0, 30),
    };
  }
}

export function splitSelector(selector: string): { css: string; attr: string; text: boolean } {
  const s = selector.trim();
  const attrMatch = s.match(/^(.*?)@([a-zA-Z][\w:-]*)$/);
  if (attrMatch) return { css: (attrMatch[1] as string).trim(), attr: attrMatch[2] as string, text: false };
  if (s.endsWith("::text")) return { css: s.slice(0, -6).trim(), attr: "", text: true };
  return { css: s, attr: "", text: false };
}
