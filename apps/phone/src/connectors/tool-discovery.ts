import { deepFind, str, type Json } from "./composio-json";
import { prettyAppName } from "./intent-router";

/**
 * Finding the right tool among thousands. One search is not enough: a request can need several tools, and the best tool is often
 * named nothing like the request. So the agent searches with several phrasings at once, reads every query's results (not just the
 * first), keeps only tools from apps the owner has connected, and sets deprecated tools last. If nothing fits, the model is asked
 * what else in the owner's connected apps could do the job, and the search is widened with its phrases.
 */

export type Candidate = { slug: string; toolkit: string; need: string; primary: boolean; deprecated: boolean };
export type Discovery = {
  candidates: Candidate[];
  /** Toolkits with an active connection, when the search said so. Empty means "unknown", not "none". */
  connected: Set<string>;
  notConnected: string[];
  plan: string[];
  pitfalls: string[];
  sessionId: string;
  schemas: Record<string, unknown>;
};

export type SearchQuery = { use_case: string; known_fields: string };

/** Search phrasings: the request itself, then the same request aimed at each app the router pointed at or thought likely. */
export function buildQueries(request: string, apps: { pointed?: string[]; likely?: string[] } = {}): SearchQuery[] {
  const clean = request.replace(/\[The owner pointed at:[^\]]*\]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const out: SearchQuery[] = [{ use_case: clean, known_fields: "" }];
  const lower = clean.toLowerCase();
  for (const app of [...(apps.pointed ?? []), ...(apps.likely ?? [])]) {
    const name = prettyAppName(app);
    if (lower.includes(name.toLowerCase()) || lower.includes(app.replace(/_/g, " "))) continue;
    out.push({ use_case: `${clean} (in ${name})`.slice(0, 320), known_fields: "" });
    if (out.length >= 3) break;
  }
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const prefixToolkit = (slug: string): string => (slug.split("_")[0] ?? "").toLowerCase();

export function parseDiscovery(data: Json | null): Discovery {
  const d: Discovery = { candidates: [], connected: new Set(), notConnected: [], plan: [], pitfalls: [], sessionId: "", schemas: {} };
  if (!data) return d;
  d.sessionId = str(deepFind(data, "session_id") ?? (deepFind(data, "session") as Json | undefined)?.id);
  d.schemas = ((deepFind(data, "tool_schemas") ?? {}) as Record<string, unknown>);
  const statuses = (deepFind(data, "toolkit_connection_statuses") ?? []) as unknown;
  for (const s of Array.isArray(statuses) ? (statuses as Json[]) : []) {
    if (!s || typeof s !== "object") continue;
    const tk = str(s.toolkit).toLowerCase();
    if (!tk) continue;
    if (s.has_active_connection === false) d.notConnected.push(tk); else d.connected.add(tk);
  }
  const results = deepFind(data, "results");
  // A multi-query search returns one entry per query. Older or simpler replies put the slugs at the top level.
  const entries: Json[] = Array.isArray(results) && results.some((r) => r && typeof r === "object" && ("primary_tool_slugs" in (r as Json) || "related_tool_slugs" in (r as Json))) ? (results as Json[]) : [data];
  const seen = new Set<string>();
  const planSeen = new Set<string>(); const pitSeen = new Set<string>();
  for (const e of entries) {
    const need = str(e.use_case);
    const add = (slug: string, primary: boolean): void => {
      if (!slug || seen.has(slug)) return; seen.add(slug);
      const sc = d.schemas[slug] as Json | undefined;
      const toolkit = (str(sc?.toolkit) || prefixToolkit(slug)).toLowerCase();
      d.candidates.push({ slug, toolkit, need, primary, deprecated: /^\s*deprecated\b/i.test(str(sc?.description)) });
    };
    for (const s of list(e.primary_tool_slugs ?? deepFind(e, "primary_tool_slugs"))) add(s, true);
    for (const s of list(e.related_tool_slugs ?? deepFind(e, "related_tool_slugs"))) add(s, false);
    for (const p of list(e.recommended_plan_steps)) if (!planSeen.has(p)) { planSeen.add(p); d.plan.push(p); }
    for (const p of list(e.known_pitfalls)) if (!pitSeen.has(p)) { pitSeen.add(p); d.pitfalls.push(p); }
  }
  return d;
}

/**
 * The tools shown to the model. Tools from apps that are not connected are dropped when connected alternatives exist, deprecated
 * tools go last, an app the owner pointed at comes first, and the rest interleave across the different needs so one need cannot
 * crowd out another.
 */
export function pickCandidates(d: Discovery, opts: { limit?: number; pointed?: string[] } = {}): Candidate[] {
  const limit = opts.limit ?? 8;
  const pointed = new Set((opts.pointed ?? []).map((a) => a.replace(/_/g, "").toLowerCase()));
  const pool = d.candidates.filter((c) => !d.notConnected.includes(c.toolkit));
  const weight = (c: Candidate): number => (c.deprecated ? 100 : 0) + (pointed.has(c.toolkit.replace(/_/g, "")) ? 0 : pointed.size ? 10 : 0) + (c.primary ? 0 : 1);
  const byNeed = new Map<string, Candidate[]>();
  for (const c of pool) byNeed.set(c.need, [...(byNeed.get(c.need) ?? []), c]);
  for (const arr of byNeed.values()) arr.sort((a, b) => weight(a) - weight(b));
  const queues = [...byNeed.values()];
  const out: Candidate[] = [];
  for (let i = 0; out.length < limit && queues.some((q) => i < q.length); i++) for (const q of queues) { const c = q[i]; if (c && out.length < limit && !out.includes(c)) out.push(c); }
  const offTarget = (c: Candidate): number => (pointed.size && !pointed.has(c.toolkit.replace(/_/g, "")) ? 1 : 0);
  return out.sort((a, b) => Number(a.deprecated) - Number(b.deprecated) || offTarget(a) - offTarget(b));
}

/** Slugs the search found but could not be used because their app is not connected, in order of relevance. */
export function unconnectedToolkits(d: Discovery): string[] {
  return [...new Set([...d.notConnected, ...d.candidates.map((c) => c.toolkit).filter((t) => d.notConnected.includes(t))])];
}

export function widenPrompt(request: string, connectedApps: readonly string[], already: readonly string[]): string {
  const apps = connectedApps.length ? connectedApps.map((a) => `${a} (${prettyAppName(a)})`).join(", ") : "unknown";
  return [
    `The owner asked: ${JSON.stringify(request.slice(0, 400))}`,
    `Searching the tool catalogue for that did not give a tool that fits.${already.length ? ` Phrases already tried: ${already.map((q) => JSON.stringify(q)).join(", ")}.` : ""}`,
    `Connected apps: ${apps}.`,
    "Think about what the owner really needs done and which connected app could do it, even if the app is not named in the request or does it by another route (for example a message can be an email, a chat message or a comment).",
    'Reply with ONLY JSON: {"try":["short search phrase naming the app and the action", ...up to 3], "why":"one short line"}. If no connected app can do this, reply {"try":[],"why":"..."}.',
  ].join("\n");
}

/** Combines two searches (the original and a widened one) into one. A toolkit connected in either counts as connected. */
export function mergeDiscovery(a: Discovery, b: Discovery): Discovery {
  const seen = new Set(a.candidates.map((c) => c.slug));
  const connected = new Set([...a.connected, ...b.connected]);
  return {
    candidates: [...a.candidates, ...b.candidates.filter((c) => !seen.has(c.slug))],
    connected,
    notConnected: [...new Set([...a.notConnected, ...b.notConnected])].filter((t) => !connected.has(t)),
    plan: [...new Set([...a.plan, ...b.plan])], pitfalls: [...new Set([...a.pitfalls, ...b.pitfalls])],
    sessionId: a.sessionId || b.sessionId, schemas: { ...a.schemas, ...b.schemas },
  };
}
