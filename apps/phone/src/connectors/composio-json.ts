/** Helpers for reading Composio's loosely-shaped JSON replies without depending on one exact layout. */

export type Json = Record<string, unknown>;

export function deepFind(value: unknown, key: string, depth = 0): unknown {
  if (depth > 7 || value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in (value as Json)) return (value as Json)[key];
  for (const v of Array.isArray(value) ? value : Object.values(value as Json)) { const f = deepFind(v, key, depth + 1); if (f !== undefined) return f; }
  return undefined;
}

/** First array (breadth first) whose items are objects containing at least one of `keys`. */
export function findObjectArray(value: unknown, keys: string[], maxDepth = 8): Json[] {
  const queue: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (queue.length) {
    const { v, d } = queue.shift() as { v: unknown; d: number };
    if (Array.isArray(v)) {
      const objs = v.filter((x): x is Json => !!x && typeof x === "object" && !Array.isArray(x));
      if (objs.length && objs.some((o) => keys.some((k) => k in o))) return objs;
      if (d < maxDepth) for (const x of v) queue.push({ v: x, d: d + 1 });
    } else if (v && typeof v === "object" && d < maxDepth) for (const x of Object.values(v as Json)) queue.push({ v: x, d: d + 1 });
  }
  return [];
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The data of each executed tool in a COMPOSIO_MULTI_EXECUTE_TOOL reply, in order. */
export function executionResults(json: Json | null): Array<{ slug: string; ok: boolean; data: unknown; error: string }> {
  if (!json) return [];
  const results = deepFind(json, "results");
  const list = Array.isArray(results) ? results : [];
  return list.map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Json;
    const resp = (o.response && typeof o.response === "object" ? o.response : o) as Json;
    const ok = resp.successful !== false && !resp.error && o.error === undefined;
    return { slug: str(o.tool_slug ?? o.slug), ok, data: resp.data ?? resp, error: str(resp.error ?? o.error) };
  });
}

export function compact(value: unknown, max = 5500): string {
  let text: string;
  try { text = JSON.stringify(value, (k, v) => (typeof v === "string" && v.length > 600 ? v.slice(0, 600) + "…" : v)) ?? ""; } catch { text = String(value); }
  return text.length > max ? text.slice(0, max) + "…[truncated]" : text;
}
