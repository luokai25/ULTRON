import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { Http } from "./browser";

/**
 * The phone's public-web transport. On Android the request goes through Capacitor's native HTTP client, which has no CORS
 * restrictions, so Ultron can read real pages. In a desktop browser it falls back to fetch (subject to each site's CORS policy).
 */
function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

export function createHttp(): Http {
  const native = Capacitor.getPlatform() === "android";
  const browserHeaders = { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 Ultron/3", "Accept-Language": "en-US,en;q=0.8" };
  return {
    async get(url, options) {
      const headers = { ...browserHeaders, ...(options?.headers ?? {}) };
      const timeout = options?.timeoutMs ?? 20000;
      if (native) {
        const res = await CapacitorHttp.get({ url, headers, responseType: "text", connectTimeout: timeout, readTimeout: timeout });
        const ct = String(res.headers?.["Content-Type"] ?? res.headers?.["content-type"] ?? "");
        return { status: res.status, url: res.url || url, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? ""), contentType: ct };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: options?.headers, credentials: "omit", redirect: "follow" });
        return { status: res.status, url: res.url || url, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
      } finally { clearTimeout(timer); }
    },
    async request(method, url, options) {
      const headers = { ...browserHeaders, ...(options?.headers ?? {}) };
      const timeout = options?.timeoutMs ?? 20000;
      if (native) {
        const res = await CapacitorHttp.request({ url, method: method.toUpperCase(), headers, data: options?.body, responseType: "text", connectTimeout: timeout, readTimeout: timeout });
        const ct = String(res.headers?.["Content-Type"] ?? res.headers?.["content-type"] ?? "");
        return { status: res.status, url: res.url || url, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? ""), contentType: ct, headers: lowerHeaders(res.headers) };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { method: method.toUpperCase(), signal: controller.signal, headers: options?.headers, body: options?.body, credentials: "omit", redirect: "follow" });
        const outHeaders: Record<string, string> = {}; res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });
        return { status: res.status, url: res.url || url, text: await res.text(), contentType: res.headers.get("content-type") ?? "", headers: outHeaders };
      } finally { clearTimeout(timer); }
    },
    async bytes(url, options) {
      const timeout = options?.timeoutMs ?? 45000;
      if (native) {
        const res = await CapacitorHttp.get({ url, headers: browserHeaders, responseType: "blob", connectTimeout: timeout, readTimeout: timeout });
        const mime = String(res.headers?.["Content-Type"] ?? res.headers?.["content-type"] ?? "application/octet-stream").split(";")[0] ?? "";
        return { status: res.status, mime, base64: typeof res.data === "string" ? res.data : "" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { status: res.status, mime: (res.headers.get("content-type") ?? "").split(";")[0] ?? "", base64: btoa(bin) };
      } finally { clearTimeout(timer); }
    },
  };
}
