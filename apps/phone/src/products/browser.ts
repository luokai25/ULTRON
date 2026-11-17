/**
 * Ultron's browser: public web search, page reading and market research for the products generator.
 * It is transport-agnostic (the phone uses native HTTP, which has no CORS limits; tests inject a fake) and only reads
 * public pages. Nothing is logged in to, no cookies are sent, and private network addresses are refused.
 */

export type HttpResult = { status: number; url: string; text: string; contentType: string };
export type HttpBytes = { status: number; mime: string; base64: string };
export type Http = {
  get(url: string, options?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<HttpResult>;
  bytes(url: string, options?: { timeoutMs?: number }): Promise<HttpBytes>;
};

export type SearchHit = { title: string; url: string; snippet: string; source: "web" | "wikipedia" | "books" };
export type PageText = { url: string; title: string; description: string; text: string; headings: string[]; links: Array<{ text: string; url: string }> };

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|metadata\.google\.internal)$/i;

/** Only public http(s) pages. Blocks loopback, link-local and private ranges so a page cannot be used to probe the device's network. */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || PRIVATE_HOST.test(host)) return false;
  if (host.includes(":")) return !/^(::1?|fc|fd|fe80|::ffff:)/i.test(host);
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Regex-based reader: dependency-free so it behaves the same in the WebView and in tests. */
export function htmlToReadable(html: string, baseUrl: string): PageText {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = decodeEntities(html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i)?.[1] ?? "").trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<article[\s\S]*?<\/article>/i) ?? body.match(/<main[\s\S]*?<\/main>/i);
  if (main && stripTags(main[0]).length > 400) body = main[0];
  else body = body.replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ");
  const links: Array<{ text: string; url: string }> = [];
  for (const m of body.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2] ?? "");
    let url = "";
    try { url = new URL(decodeEntities(m[1] as string), baseUrl).toString(); } catch { continue; }
    if (text.length > 2 && isPublicHttpUrl(url) && links.length < 60) links.push({ text: text.slice(0, 120), url });
  }
  const headings = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1] ?? "")).filter((h) => h.length > 2).slice(0, 24);
  const text = decodeEntities(body.replace(/<\/(p|div|section|li|h[1-6]|tr|br|blockquote|pre)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1).join("\n");
  return { url: baseUrl, title, description, text, headings, links };
}

export async function fetchPage(http: Http, url: string, maxChars = 12000): Promise<PageText> {
  if (!isPublicHttpUrl(url)) throw new Error("Ultron only opens public web pages.");
  const res = await http.get(url, { timeoutMs: 20000, headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" } });
  if (res.status >= 400) throw new Error(`The page answered HTTP ${res.status}.`);
  if (!isPublicHttpUrl(res.url || url)) throw new Error("The page redirected to a private address.");
  if (/json|text\/plain/i.test(res.contentType) && !/<html/i.test(res.text.slice(0, 500))) return { url: res.url || url, title: url, description: "", text: res.text.slice(0, maxChars), headings: [], links: [] };
  const page = htmlToReadable(res.text, res.url || url);
  return { ...page, text: page.text.slice(0, maxChars) };
}

// ---------- Keyless search providers ----------

const enc = encodeURIComponent;

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  for (const m of html.matchAll(re)) {
    let url = decodeEntities(m[1] as string);
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) { try { url = decodeURIComponent(wrapped[1] as string); } catch { continue; } }
    if (url.startsWith("//")) url = "https:" + url;
    if (!isPublicHttpUrl(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = stripTags((m[3] ?? "").match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1] ?? "");
    hits.push({ title: stripTags(m[2] ?? ""), url, snippet, source: "web" });
  }
  return hits;
}

export async function searchWeb(http: Http, query: string, limit = 6): Promise<SearchHit[]> {
  const res = await http.get(`https://html.duckduckgo.com/html/?q=${enc(query)}`, { timeoutMs: 15000, headers: { Accept: "text/html" } });
  if (res.status >= 400) throw new Error(`Web search answered HTTP ${res.status}.`);
  return parseDuckDuckGo(res.text).slice(0, limit);
}

export async function searchWikipedia(http: Http, query: string, limit = 4): Promise<SearchHit[]> {
  const res = await http.get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(query)}&format=json&origin=*&srlimit=${limit}`, { timeoutMs: 12000 });
  if (res.status >= 400) return [];
  const data = JSON.parse(res.text) as { query?: { search?: Array<{ title: string; snippet: string }> } };
  return (data.query?.search ?? []).map((r) => ({ title: r.title, url: `https://en.wikipedia.org/wiki/${enc(r.title.replace(/ /g, "_"))}`, snippet: stripTags(r.snippet), source: "wikipedia" as const }));
}

/** Existing books are the clearest public signal that people already pay to learn something. */
export async function searchBooks(http: Http, query: string, limit = 8): Promise<SearchHit[]> {
  const res = await http.get(`https://openlibrary.org/search.json?q=${enc(query)}&limit=${limit}&fields=title,author_name,first_publish_year,key`, { timeoutMs: 12000 });
  if (res.status >= 400) return [];
  const data = JSON.parse(res.text) as { docs?: Array<{ title?: string; author_name?: string[]; first_publish_year?: number; key?: string }> };
  return (data.docs ?? []).filter((d) => d.title).map((d) => ({
    title: d.title as string, url: d.key ? `https://openlibrary.org${d.key}` : "https://openlibrary.org", snippet: `${(d.author_name ?? ["unknown author"]).slice(0, 2).join(", ")}${d.first_publish_year ? `, ${d.first_publish_year}` : ""}`, source: "books" as const,
  }));
}

export type Research = { query: string; notes: string; sources: Array<{ title: string; url: string; snippet: string }> };

/** Search several public sources, read the top pages and condense everything into notes the model can ground itself in. */
export async function research(http: Http, topic: string, options: { pages?: number; signal?: AbortSignal } = {}): Promise<Research> {
  const query = topic.trim().slice(0, 120);
  const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
  const [web, wiki, books] = await Promise.all([
    settle(searchWeb(http, `${query} guide for beginners`), [] as SearchHit[]),
    settle(searchWikipedia(http, query), [] as SearchHit[]),
    settle(searchBooks(http, query), [] as SearchHit[]),
  ]);
  const excerpts: string[] = [];
  for (const hit of web.slice(0, options.pages ?? 3)) {
    if (options.signal?.aborted) break;
    try {
      const page = await fetchPage(http, hit.url, 6000);
      const lead = (page.description || page.text.split("\n").find((l) => l.length > 120) || "").slice(0, 320);
      if (lead) excerpts.push(`${page.title || hit.title}: ${lead}`);
    } catch { /* an unreadable page is simply skipped */ }
  }
  const notes = [
    books.length ? `Existing books on this topic (Open Library): ${books.slice(0, 6).map((b) => `"${b.title}" (${b.snippet})`).join("; ")}.` : "",
    web.length ? `Top web results: ${web.slice(0, 4).map((w) => `${w.title}${w.snippet ? ` — ${w.snippet.slice(0, 120)}` : ""}`).join(" | ")}.` : "",
    wiki.length ? `Background (Wikipedia): ${wiki.slice(0, 2).map((w) => `${w.title}: ${w.snippet.slice(0, 140)}`).join(" | ")}.` : "",
    excerpts.length ? `Page excerpts: ${excerpts.join(" || ")}` : "",
  ].filter(Boolean).join("\n");
  return { query, notes, sources: [...web, ...wiki, ...books].slice(0, 12).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })) };
}

export async function trendingHeadlines(http: Http): Promise<string[]> {
  const out: string[] = [];
  try {
    const rss = await http.get("https://trends.google.com/trending/rss?geo=US", { timeoutMs: 12000 });
    if (rss.status < 400) for (const m of rss.text.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/gi)) out.push(stripTags(m[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, ""));
  } catch { /* fall through to the next public source */ }
  if (out.length < 5) {
    try {
      const day = new Date(Date.now() - 2 * 86400000);
      const path = `${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, "0")}/${String(day.getUTCDate()).padStart(2, "0")}`;
      const top = await http.get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${path}`, { timeoutMs: 12000 });
      if (top.status < 400) {
        const data = JSON.parse(top.text) as { items?: Array<{ articles?: Array<{ article: string }> }> };
        for (const a of data.items?.[0]?.articles ?? []) if (!/^(Main_Page|Special:|Wikipedia:|Portal:|-)/.test(a.article)) out.push(a.article.replace(/_/g, " "));
      }
    } catch { /* offline: callers use built-in ideas */ }
  }
  return out.slice(0, 40);
}

/** Free keyless illustration service. The caller embeds the bytes, so exports work offline afterwards. */
export async function generateIllustration(http: Http, prompt: string, mood: string, signal?: AbortSignal): Promise<{ mime: string; data: string } | null> {
  if (signal?.aborted) return null;
  const styled = `Flat editorial illustration, soft shapes, ${mood || "calm"} colours, no text, no letters, no logos: ${prompt}`.slice(0, 380);
  const res = await http.bytes(`https://image.pollinations.ai/prompt/${enc(styled)}?width=768&height=512&nologo=true&seed=${Math.abs(hash(prompt)) % 100000}`, { timeoutMs: 60000 });
  if (res.status >= 400 || !/^image\/(png|jpe?g|webp)/i.test(res.mime) || res.base64.length < 2000 || res.base64.length > 2_600_000) return null;
  return { mime: res.mime.toLowerCase().replace("jpg", "jpeg"), data: res.base64 };
}

function hash(s: string): number { let h = 5381; for (const c of s) h = (h * 33 + c.charCodeAt(0)) | 0; return h; }
