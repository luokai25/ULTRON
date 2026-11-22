import type { Http } from "./products/browser";

/**
 * Keyless picture generation for chat. Two free, no-account services are tried in order (anonymous tiers are rate limited and can be
 * slow or temporarily unavailable, so each failure falls through to the next). Nothing here needs an API key.
 *  1. Pollinations: image.pollinations.ai/prompt/<text>
 *  2. AI Horde: community Stable Diffusion network, anonymous key "0000000000" (queue based, can take a minute or two)
 */

export type MediaIntent = { kind: "image" | "video"; prompt: string };
export type GeneratedImage = { bytes: Uint8Array; mime: string; engine: "pollinations" | "horde"; ms: number };

const IMAGE_NOUN = String.raw`(?:images?|pictures?|photos?|photographs?|illustrations?|logos?|posters?|wallpapers?|artworks?|drawings?|paintings?|portraits?|icons?|banners?|thumbnails?|avatars?|sketch(?:es)?|renders?|mockups?|cartoons?|memes?|stickers?)`;
const IMAGE_VERB = String.raw`(?:generate|create|make|draw|paint|design|render|illustrate|produce|sketch|imagine|show me)`;
const VIDEO_NOUN = String.raw`(?:videos?|clips?|animations?|reels?|shorts?|movies?|trailers?|slideshows?)`;
const VIDEO_VERB = String.raw`(?:generate|create|make|produce|render|animate|build)`;
const IMG_RE = new RegExp(String.raw`\b${IMAGE_VERB}\b(?<gap>[^.?!\n]{0,40}?)\b${IMAGE_NOUN}\b(?:\s+(?:of|showing|about|with|that|depicting|featuring|for)\s+(?<p>[^.?!\n]{3,300}))?`, "i");
// "draw me a dragon" / "paint a sunset": the bare verbs only count with a concrete subject (not "draw conclusions" or "draw a line").
const DRAW_RE = /\b(?:(?:draw|sketch)\s+me|(?:paint|sketch|illustrate)(?:\s+me)?|draw\s+(?=an?\s))\s+(?:an?\s+|the\s+)?(?<p>[^.?!\n]{4,300})/i;
const DRAW_NOT = /\b(?:conclusions?|attention|comparisons?|parallels?|inferences?|lines?|blanks?|breath|blood|water|salary|funds?|money|data|a crowd)\b/i;
const VID_RE = new RegExp(String.raw`\b${VIDEO_VERB}\b[^.?!\n]{0,40}?\b${VIDEO_NOUN}\b(?:\s+(?:of|showing|about|with|that|depicting|featuring|for|on)\s+(?<p>[^.?!\n]{3,300}))?`, "i");
const QUESTION = /^\s*(?:how|what|why|can you explain|should i|is it|does|do you)\b/i;
const NOT_MEDIA = /\b(ebook|e-book|book|pdf|epub|document|essay|code|script|function|app|website|spreadsheet|presentation|slides?)\b/i;

export function detectMediaIntent(message: string): MediaIntent | null {
  const text = message.trim();
  if (text.length < 8 || text.length > 700 || QUESTION.test(text)) return null;
  const video = VID_RE.exec(text);
  if (video && !/\bhow to\b/i.test(text)) return { kind: "video", prompt: clean(video.groups?.p ?? "", text) };
  const img = IMG_RE.exec(text);
  if (img && !NOT_MEDIA.test(img.groups?.gap ?? "")) return { kind: "image", prompt: clean(img.groups?.p ?? "", text) };
  const draw = DRAW_RE.exec(text);
  if (draw && !NOT_MEDIA.test(text) && !DRAW_NOT.test((draw.groups?.p ?? "").slice(0, 30))) return { kind: "image", prompt: clean(draw.groups?.p ?? "", text) };
  return null;
}

function clean(captured: string, full: string): string {
  const p = (captured || full).replace(/^(?:of|a|an|the|me)\s+/i, "").replace(/\b(?:please|thanks|thank you)\b\.?/gi, "").replace(/\s+/g, " ").trim();
  return p.slice(0, 320) || full.slice(0, 320);
}

const enc = encodeURIComponent;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const b64ToBytes = (b64: string): Uint8Array => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const okImage = (mime: string, b64: string): boolean => /^image\/(png|jpe?g|webp)/i.test(mime) && b64.length > 6000;

export type ImageDeps = { http: Http; signal?: AbortSignal; status?: (s: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number; size?: number };

export async function viaPollinations(prompt: string, deps: ImageDeps, seed = Math.floor(Math.random() * 1_000_000)): Promise<GeneratedImage | null> {
  const size = deps.size ?? 1024; const t0 = (deps.now ?? Date.now)();
  const url = `https://image.pollinations.ai/prompt/${enc(prompt.slice(0, 600))}?width=${size}&height=${size}&nologo=true&enhance=true&seed=${seed}`;
  try {
    const res = await deps.http.bytes(url, { timeoutMs: 90000 });
    if (res.status >= 400 || !okImage(res.mime, res.base64)) return null;
    return { bytes: b64ToBytes(res.base64), mime: res.mime.toLowerCase().replace("jpg", "jpeg"), engine: "pollinations", ms: (deps.now ?? Date.now)() - t0 };
  } catch { return null; }
}

const HORDE = "https://aihorde.net/api/v2";
export async function viaHorde(prompt: string, deps: ImageDeps, maxWaitMs = 150000): Promise<GeneratedImage | null> {
  const wait = deps.sleep ?? sleep; const now = deps.now ?? Date.now; const t0 = now();
  const headers = { apikey: "0000000000", "Client-Agent": "ultron:3:owner", "Content-Type": "application/json" };
  if (!deps.http.request) return null;
  try {
    const start = await deps.http.request("POST", `${HORDE}/generate/async`, { headers, body: JSON.stringify({ prompt: prompt.slice(0, 900), params: { width: 512, height: 512, steps: 25, n: 1, sampler_name: "k_euler_a", cfg_scale: 7 }, nsfw: false, censor_nsfw: true, trusted_workers: false, slow_workers: true, r2: true }), timeoutMs: 20000 });
    if (start.status >= 400) return null;
    const id = (JSON.parse(start.text) as { id?: string }).id; if (!id) return null;
    while (now() - t0 < maxWaitMs) {
      if (deps.signal?.aborted) return null;
      await wait(4000);
      const check = await deps.http.get(`${HORDE}/generate/check/${id}`, { headers: { "Client-Agent": headers["Client-Agent"] }, timeoutMs: 15000 });
      const info = JSON.parse(check.text) as { done?: boolean; faulted?: boolean; queue_position?: number; wait_time?: number };
      if (info.faulted) return null;
      deps.status?.(info.done ? "Finishing the picture" : `In the free queue${info.queue_position ? ` (position ${info.queue_position})` : ""}${info.wait_time ? `, about ${info.wait_time}s` : ""}`);
      if (info.done) {
        const done = await deps.http.get(`${HORDE}/generate/status/${id}`, { headers: { "Client-Agent": headers["Client-Agent"] }, timeoutMs: 20000 });
        const g = (JSON.parse(done.text) as { generations?: Array<{ img?: string; censored?: boolean }> }).generations?.[0];
        if (!g?.img || g.censored) return null;
        if (/^https?:/i.test(g.img)) { const bin = await deps.http.bytes(g.img, { timeoutMs: 30000 }); if (!okImage(bin.mime, bin.base64)) return null; return { bytes: b64ToBytes(bin.base64), mime: bin.mime.toLowerCase().replace("jpg", "jpeg"), engine: "horde", ms: now() - t0 }; }
        return { bytes: b64ToBytes(g.img), mime: "image/webp", engine: "horde", ms: now() - t0 };
      }
    }
  } catch { /* queue unavailable */ }
  return null;
}

/** Tries each free engine in turn. Returns null only when every one failed. */
export async function generateImage(prompt: string, deps: ImageDeps): Promise<GeneratedImage | null> {
  deps.status?.("Painting with Pollinations");
  const first = await viaPollinations(prompt, deps);
  if (first) return first;
  if (deps.signal?.aborted) return null;
  deps.status?.("Trying the community queue (AI Horde)");
  return viaHorde(prompt, deps);
}

export type Scene = { caption: string; imagePrompt: string };

/** Splits a video idea into scenes. The model is used when available; otherwise a simple structure is built from the prompt. */
export function fallbackScenes(prompt: string, count = 4): Scene[] {
  const base = prompt.replace(/\s+/g, " ").trim();
  const beats = ["opening shot", "the main idea", "a close detail", "the finale"].slice(0, count);
  return beats.map((b, i) => ({ caption: i === 0 ? base.slice(0, 60) : b.charAt(0).toUpperCase() + b.slice(1), imagePrompt: `${base}, ${b}, cinematic, detailed, consistent style` }));
}

export function parseScenes(raw: unknown, max = 5): Scene[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { scenes?: unknown }).scenes) ? (raw as { scenes: unknown[] }).scenes : []);
  return list.map((s) => (s && typeof s === "object" ? s as Record<string, unknown> : {})).map((s) => ({ caption: String(s.caption ?? s.title ?? "").trim().slice(0, 80), imagePrompt: String(s.imagePrompt ?? s.image_prompt ?? s.prompt ?? "").trim().slice(0, 320) })).filter((s) => s.imagePrompt.length > 5).slice(0, max);
}
