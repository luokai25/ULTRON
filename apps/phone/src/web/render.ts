import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * JavaScript-rendered pages and network capture: Scrapling's DynamicFetcher idea on a phone. A hidden Android WebView loads
 * the page, lets scripts run, and returns the final DOM plus the JSON calls the page made. It is a normal browser with its
 * own cache and cookies; it does not hide that it is automated and does not attempt to defeat bot protection.
 */

export type CapturedRequest = { method: string; url: string; body?: string; status?: number; contentType?: string; response?: string };
export type RenderResult = { url: string; html: string; requests: CapturedRequest[]; seenUrls: string[] };
export type RenderOptions = { timeoutMs?: number; settleMs?: number };
export type Renderer = (url: string, options?: RenderOptions) => Promise<RenderResult>;

type NativePlugin = { render(options: { url: string; timeoutMs: number; settleMs: number }): Promise<{ url: string; payload: string; seen: string[] }> };

export function nativeRenderer(): Renderer | null {
  if (Capacitor.getPlatform() !== "android") return null;
  const plugin = registerPlugin<NativePlugin>("UltronWebRender");
  return async (url, options) => {
    const res = await plugin.render({ url, timeoutMs: options?.timeoutMs ?? 25000, settleMs: options?.settleMs ?? 1500 });
    let parsed: { html?: string; cap?: Array<{ m: string; u: string; b?: string; s?: number; c?: string; r?: string }> } = {};
    try { parsed = JSON.parse(res.payload) as typeof parsed; } catch { /* a page that returned nothing usable */ }
    const requests: CapturedRequest[] = (parsed.cap ?? []).map((c) => ({ method: (c.m || "GET").toUpperCase(), url: absolute(c.u, res.url || url), body: c.b || undefined, status: c.s, contentType: c.c, response: c.r }));
    return { url: res.url || url, html: parsed.html ?? "", requests, seenUrls: res.seen ?? [] };
  };
}

function absolute(u: string, base: string): string { try { return new URL(u, base).toString(); } catch { return u; } }
