import type { Http } from "../products/browser";
import { McpClient, McpError, type McpTool } from "./mcp-client";

/**
 * Composio connection manager. The consumer API key lives in the device's secure storage (never in source code or logs).
 * The tool list is re-read on app start, on resume, on a timer and before chat turns, so apps connected or removed in
 * Composio show up without re-entering anything.
 */

export const COMPOSIO_URL = "https://connect.composio.dev/mcp";

export type ComposioStatus = "no-key" | "connecting" | "connected" | "error";
export type ToolGroup = { id: string; label: string; count: number };
export type ComposioState = {
  status: ComposioStatus; error: string; tools: McpTool[]; toolHash: string; groups: ToolGroup[]; syncedAt: number;
  serverName: string; connections: { text: string; at: number; ok: boolean } | null; keyHint: string;
  /** Where the key in use comes from: one the owner pasted, the one built into this app, or none. */
  keySource: "own" | "built-in" | "none";
  /** App slugs the owner has connected in Composio, read from the tool list. */
  connectedApps: string[];
  /** Per-app status and accounts, from COMPOSIO_MANAGE_CONNECTIONS (action list). */
  apps: Record<string, AppConnection>;
};
export type ComposioAccount = { id: string; label: string; status: string; isDefault: boolean };
export type AppConnection = { slug: string; status: string; accounts: ComposioAccount[] };

/** Toolkits probed for connection status on every refresh, in addition to any named in Composio's own tool description. */
export const COMMON_TOOLKITS = ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets", "googleslides", "googletasks", "googlemeet", "googlesuper", "github", "notion", "slack", "linear", "outlook", "microsoft_word", "excel", "microsoft_teams", "onedrive", "dropbox", "canva", "figma", "cloudflare", "sentry", "zoom", "youtube", "instagram", "reddit", "twitter", "linkedin", "facebook", "discord", "telegram", "whatsapp", "trello", "asana", "jira", "clickup", "todoist", "hubspot", "salesforce", "stripe", "shopify", "airtable", "calendly", "mailchimp", "zendesk", "gumroad", "amazon", "brave_search", "google_analytics", "google_search_console", "shotstack", "higgsfield_mcp", "github_mcp", "agent_mail", "financial_datasets_ai_mcp", "wispr_flow_mcp", "openai", "perplexityai", "firecrawl", "exa", "tavily", "elevenlabs", "heygen", "replicate"];

export type ComposioSettings = { enabled: boolean; askBefore: boolean; allowedTools: string[]; webInChat: boolean };

export const DEFAULT_SETTINGS: ComposioSettings = { enabled: true, askBefore: true, allowedTools: [], webInChat: true };

export type SecretStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
export type KeyValue = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

const KEY_NAME = "ultron.composio.consumer-key.v1";
const CACHE = "ultron.composio.cache.v1";
const SETTINGS = "ultron.composio.settings.v1";
const BUILT_IN_OFF = "ultron.composio.built-in-off.v1";

/**
 * Composio lists the owner's connected apps inside the COMPOSIO_SEARCH_TOOLS description ("User has manually connected the apps: a, b, c").
 * Reading it from every tools/list refresh is how the app learns about added or removed connections with no extra calls.
 */
export function parseConnectedApps(tools: Array<{ name: string; description: string }>): string[] {
  for (const t of tools) {
    const m = t.description.match(/connected\s+the\s+apps:\s*([^\n]*?)(?:\.\s|\.?\n|\.?$)/i) ?? t.description.match(/connected apps?:\s*([^\n]*?)(?:\.\s|\.?\n|\.?$)/i);
    if (m?.[1]) return [...new Set(m[1].split(/[,;]/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9_]{2,40}$/.test(x)))].slice(0, 120);
  }
  return [];
}

export const validKey = (k: string): boolean => /^ck_[A-Za-z0-9_-]{8,}$/.test(k.trim());
export const maskKey = (k: string): string => (k.length > 8 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "ck_…");

export function groupTools(tools: McpTool[]): ToolGroup[] {
  const counts = new Map<string, number>();
  for (const t of tools) { const id = (t.name.split("_")[0] ?? t.name).toUpperCase(); counts.set(id, (counts.get(id) ?? 0) + 1); }
  return [...counts].map(([id, count]) => ({ id, label: id.charAt(0) + id.slice(1).toLowerCase(), count })).sort((a, b) => (a.id === "COMPOSIO" ? 1 : b.id === "COMPOSIO" ? -1 : b.count - a.count));
}

const hashTools = (tools: McpTool[]): string => { let h = 5381; for (const t of tools.map((x) => `${x.name}|${x.description.length}`).sort()) for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return `${tools.length}:${h.toString(36)}`; };

/** Builds arguments for a "list connections" style tool from its schema, using only safe defaults. */
export function guessListArgs(tool: McpTool): Array<Record<string, unknown>> {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown; items?: unknown }>; required?: string[] };
  const attempts: Array<Record<string, unknown>> = [{}];
  const filled: Record<string, unknown> = {};
  for (const k of schema.required ?? []) {
    const p = schema.properties?.[k]; if (!p) continue;
    filled[k] = p.default !== undefined ? p.default : Array.isArray(p.enum) && p.enum.length ? p.enum[0] : p.type === "array" ? [] : p.type === "boolean" ? false : p.type === "number" || p.type === "integer" ? 0 : "";
  }
  if (Object.keys(filled).length) attempts.push(filled);
  return attempts;
}

export class ComposioManager {
  private state: ComposioState = { status: "no-key", error: "", tools: [], toolHash: "", groups: [], syncedAt: 0, serverName: "", connections: null, keyHint: "", keySource: "none", connectedApps: [], apps: {} };
  private listeners = new Set<(s: ComposioState, change: "status" | "tools" | "connections") => void>();
  private client: McpClient | null = null; private timer: ReturnType<typeof setInterval> | null = null; private syncing: Promise<void> | null = null; private settings: ComposioSettings = { ...DEFAULT_SETTINGS };

  constructor(private readonly deps: { http: Http; secrets: SecretStore; kv: KeyValue; now?: () => number; url?: string; builtInKey?: string }) {}

  /** The key to use: the owner's own if they pasted one, otherwise the one built into this app (unless they turned it off). */
  private async resolveKey(): Promise<{ key: string; source: "own" | "built-in" } | null> {
    const own = await this.deps.secrets.get(KEY_NAME).catch(() => null);
    if (own) return { key: own, source: "own" };
    const built = (this.deps.builtInKey ?? "").trim();
    if (built && validKey(built) && this.deps.kv.getItem(BUILT_IN_OFF) !== "1") return { key: built, source: "built-in" };
    return null;
  }
  hasBuiltIn(): boolean { return validKey((this.deps.builtInKey ?? "").trim()); }
  builtInEnabled(): boolean { return this.hasBuiltIn() && this.deps.kv.getItem(BUILT_IN_OFF) !== "1"; }
  private now(): number { return (this.deps.now ?? Date.now)(); }

  getState(): ComposioState { return this.state; }
  getSettings(): ComposioSettings { return { ...this.settings, allowedTools: [...this.settings.allowedTools] }; }
  subscribe(fn: (s: ComposioState, change: "status" | "tools" | "connections") => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(change: "status" | "tools" | "connections"): void { for (const l of this.listeners) { try { l(this.state, change); } catch { /* a bad listener must not break syncing */ } } }
  private set(patch: Partial<ComposioState>, change: "status" | "tools" | "connections" = "status"): void { this.state = { ...this.state, ...patch }; this.emit(change); }

  updateSettings(patch: Partial<ComposioSettings>): void { this.settings = { ...this.settings, ...patch }; try { this.deps.kv.setItem(SETTINGS, JSON.stringify(this.settings)); } catch { /* storage full */ } this.emit("status"); }

  /** Loads the saved key and last known tools, then syncs in the background. */
  async init(): Promise<void> {
    try { const s = JSON.parse(this.deps.kv.getItem(SETTINGS) ?? "null") as Partial<ComposioSettings> | null; if (s) this.settings = { ...DEFAULT_SETTINGS, ...s, allowedTools: Array.isArray(s.allowedTools) ? s.allowedTools : [] }; } catch { /* defaults */ }
    const resolved = await this.resolveKey();
    if (!resolved) { this.set({ status: "no-key", keySource: "none" }); return; }
    try { const c = JSON.parse(this.deps.kv.getItem(CACHE) ?? "null") as { tools: McpTool[]; at: number; serverName?: string; connections?: ComposioState["connections"]; apps?: Record<string, AppConnection> } | null; if (c?.tools?.length) this.state = { ...this.state, tools: c.tools, toolHash: hashTools(c.tools) + "|" + parseConnectedApps(c.tools).join(","), groups: groupTools(c.tools), syncedAt: c.at, serverName: c.serverName ?? "", connections: c.connections ?? null, connectedApps: parseConnectedApps(c.tools), apps: c.apps ?? {} }; } catch { /* no cache */ }
    this.state = { ...this.state, status: this.state.tools.length ? "connected" : "connecting", keyHint: resolved.source === "built-in" ? "built in" : maskKey(resolved.key), keySource: resolved.source };
    this.emit("status");
    void this.sync("start");
  }

  async saveKey(raw: string): Promise<{ ok: boolean; error?: string }> {
    const key = raw.trim();
    if (!validKey(key)) return { ok: false, error: "That does not look like a Composio key. It should start with ck_." };
    await this.deps.secrets.set(KEY_NAME, key);
    this.client = null; this.state = { ...this.state, keyHint: maskKey(key), keySource: "own", status: "connecting", error: "" }; this.emit("status");
    await this.sync("key");
    return this.state.status === "connected" ? { ok: true } : { ok: false, error: this.state.error || "Could not connect." };
  }

  /** Removes the owner's own key. If the app has a built-in key it takes over again; otherwise Composio is disconnected. */
  async removeKey(): Promise<void> {
    await this.deps.secrets.remove(KEY_NAME).catch(() => undefined);
    this.client = null;
    if (this.builtInEnabled()) { this.state = { ...this.state, status: "connecting", error: "", keySource: "built-in", keyHint: "built in" }; this.emit("status"); await this.sync("key"); return; }
    await this.clearAll();
  }

  /** Turns the built-in connection off (and removes any cached data). `enableBuiltIn` turns it back on. */
  async disconnect(): Promise<void> {
    await this.deps.secrets.remove(KEY_NAME).catch(() => undefined);
    if (this.hasBuiltIn()) { try { this.deps.kv.setItem(BUILT_IN_OFF, "1"); } catch { /* ignore */ } }
    await this.clearAll();
  }
  async enableBuiltIn(): Promise<void> { try { this.deps.kv.removeItem(BUILT_IN_OFF); } catch { /* ignore */ } await this.init(); }

  private async clearAll(): Promise<void> {
    try { this.deps.kv.removeItem(CACHE); } catch { /* ignore */ }
    this.client = null; this.stopAutoSync();
    this.state = { status: "no-key", error: "", tools: [], toolHash: "", groups: [], syncedAt: 0, serverName: "", connections: null, keyHint: "", keySource: "none", connectedApps: [], apps: {} }; this.emit("status");
  }

  private async getClient(): Promise<McpClient | null> {
    if (this.client) return this.client;
    const resolved = await this.resolveKey();
    if (!resolved) return null;
    this.client = new McpClient({ url: this.deps.url ?? COMPOSIO_URL, headers: { "x-consumer-api-key": resolved.key }, http: this.deps.http, clientName: "ultron" });
    return this.client;
  }

  /** Re-reads the tool list. Concurrent calls share one request. */
  sync(_reason = "manual"): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const client = await this.getClient();
      if (!client) { this.set({ status: "no-key" }); return; }
      if (this.state.status !== "connected") this.set({ status: "connecting", error: "" });
      try {
        const tools = await client.listTools();
        const connectedApps = parseConnectedApps(tools);
        const hash = hashTools(tools) + "|" + connectedApps.join(",");
        const changed = hash !== this.state.toolHash;
        this.state = { ...this.state, status: "connected", error: "", tools, toolHash: hash, groups: groupTools(tools), syncedAt: this.now(), serverName: client.serverInfo.name ?? this.state.serverName, connectedApps };
        try { this.deps.kv.setItem(CACHE, JSON.stringify({ tools, at: this.state.syncedAt, serverName: this.state.serverName, connections: this.state.connections, apps: this.state.apps })); } catch { /* cache is optional */ }
        this.emit(changed ? "tools" : "status");
        void this.probeConnections();
      } catch (e) {
        const msg = e instanceof McpError || e instanceof Error ? e.message : "Could not reach Composio.";
        this.client = null;
        // Keep showing the last known tools when the network is down; only a rejected key clears the connected state.
        const auth = e instanceof McpError && e.kind === "auth";
        this.set({ status: auth || !this.state.tools.length ? "error" : "connected", error: msg });
      } finally { this.syncing = null; }
    })();
    return this.syncing;
  }

  async ensureFresh(maxAgeMs = 120000): Promise<void> { if (this.state.status === "no-key") return; if (this.now() - this.state.syncedAt > maxAgeMs) await this.sync("fresh"); }

  startAutoSync(everyMs = 300000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") void this.ensureFresh(everyMs - 1000); }, everyMs);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
  }
  stopAutoSync(): void { if (this.timer) clearInterval(this.timer); this.timer = null; if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible); if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline); }
  private onVisible = (): void => { if (document.visibilityState === "visible") void this.ensureFresh(60000); };
  private onOnline = (): void => { void this.sync("online"); };

  async call(name: string, args: Record<string, unknown>, retried = false): Promise<{ ok: boolean; text: string }> {
    const client = await this.getClient();
    if (!client) return { ok: false, text: "Composio is not connected. Add the API key in Settings." };
    try {
      const r = await client.callTool(name, args);
      const out = { ok: !r.isError, text: r.text || (r.isError ? "The tool returned an error." : "Done.") };
      // Several accounts for one app: when an action ran without `account`, retry once with the owner's default account.
      if (!retried && /^COMPOSIO_MULTI_EXECUTE_TOOL$/i.test(name) && /account/i.test(out.text) && /(required|multiple|specify|select|ambiguous|provide)/i.test(out.text) && Array.isArray(args.tools)) {
        let changed = false;
        const tools = (args.tools as Array<Record<string, unknown>>).map((t) => {
          if (t.account) return t;
          const def = this.defaultAccount(String(t.tool_slug ?? "").split("_")[0] ?? "");
          if (!def) return t; changed = true; return { ...t, account: def.id };
        });
        if (changed) return this.call(name, { ...args, tools }, true);
      }
      return out;
    } catch (e) { return { ok: false, text: e instanceof Error ? e.message : "The tool call failed." }; }
  }

  /** Calls a tool and parses Composio's usual `{successful, data, error}` envelope. */
  async callJson(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> | null; text: string }> {
    const r = await this.call(name, args);
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(r.text) as Record<string, unknown>; } catch { const m = r.text.match(/\{[\s\S]*\}/); if (m) { try { json = JSON.parse(m[0]) as Record<string, unknown>; } catch { /* not JSON */ } } }
    const successful = json && typeof json.successful === "boolean" ? json.successful : r.ok;
    return { ok: r.ok && successful, json, text: r.text };
  }

  /**
   * Reads which apps are connected and which accounts each has, with no model involved: COMPOSIO_MANAGE_CONNECTIONS (action list)
   * over the common toolkits plus every app named in the tool description. Safe: listing has no side effects.
   */
  async refreshConnections(): Promise<void> {
    if (!this.state.tools.some((t) => /^COMPOSIO_MANAGE_CONNECTIONS$/i.test(t.name))) return;
    const slugs = [...new Set([...this.state.connectedApps, ...COMMON_TOOLKITS])];
    const found: Record<string, AppConnection> = { ...this.state.apps };
    const chunks: string[][] = []; for (let i = 0; i < slugs.length; i += 25) chunks.push(slugs.slice(i, i + 25));
    await Promise.all(chunks.map(async (chunk) => {
      const r = await this.callJson("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: chunk.map((name) => ({ name, action: "list" })) });
      const results = (r.json?.data as { results?: Record<string, unknown> } | undefined)?.results;
      if (!results || typeof results !== "object") return;
      for (const [slug, raw] of Object.entries(results)) {
        const o = (raw && typeof raw === "object" ? raw : {}) as { status?: string; accounts?: Array<Record<string, unknown>> };
        const accounts: ComposioAccount[] = (Array.isArray(o.accounts) ? o.accounts : []).map((a) => {
          const info = (a.user_info && typeof a.user_info === "object" ? a.user_info : {}) as Record<string, unknown>;
          const label = String(a.alias ?? a.label ?? info.email ?? info.name ?? info.login ?? info.username ?? a.id ?? "account");
          return { id: String(a.id ?? ""), label, status: String(a.status ?? "").toLowerCase(), isDefault: a.is_default === true };
        }).filter((a) => a.id);
        found[slug.toLowerCase()] = { slug: slug.toLowerCase(), status: String(o.status ?? (accounts.length ? "active" : "not_connected")).toLowerCase(), accounts };
      }
    }));
    const active = Object.values(found).filter((a) => a.accounts.some((x) => /active/.test(x.status))).map((a) => a.slug);
    const connectedApps = [...new Set([...active, ...this.state.connectedApps.filter((a) => found[a] === undefined)])];
    this.set({ apps: found, connectedApps }, "tools");
    try { this.deps.kv.setItem(CACHE, JSON.stringify({ tools: this.state.tools, at: this.state.syncedAt, serverName: this.state.serverName, connections: this.state.connections, apps: this.state.apps })); } catch { /* ignore */ }
  }

  /** Back-compat name used by older call sites. */
  async probeConnections(): Promise<void> { await this.refreshConnections(); }

  accountsFor(toolkit: string): ComposioAccount[] { return (this.state.apps[toolkit.toLowerCase()]?.accounts ?? []).filter((a) => /active/.test(a.status)); }
  defaultAccount(toolkit: string): ComposioAccount | null { const list = this.accountsFor(toolkit); return list.find((a) => a.isDefault) ?? list[0] ?? null; }

  /** Starts connecting an app. Returns the sign-in link the owner opens to finish; Composio completes the connection. */
  async connectApp(slug: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const r = await this.callJson("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: slug.toLowerCase() }] });
    const text = r.text; const m = text.match(/https?:\/\/[^\s"'\\]+/g)?.find((u) => /composio|connect|auth|oauth/i.test(u));
    return m ? { ok: true, url: m } : { ok: false, error: r.json ? String((r.json.error ?? "Composio did not return a sign-in link.")) : "Composio did not return a sign-in link." };
  }

  setConnectionsSnapshot(text: string): void { this.set({ connections: { text: text.slice(0, 6000), at: this.now(), ok: true } }, "connections"); }
}

/** Reads app names and states out of a connections reply, whatever its shape, so the settings panel can show chips. */
export function parseConnectionChips(text: string): Array<{ name: string; status: string }> {
  const out = new Map<string, string>();
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const name = (["toolkit", "toolkit_slug", "app", "app_name", "slug", "name"] as const).map((k) => o[k]).find((x) => typeof x === "string" || (x && typeof x === "object" && typeof (x as Record<string, unknown>).slug === "string"));
    const status = (["status", "connection_status", "state"] as const).map((k) => o[k]).find((x) => typeof x === "string");
    const label = typeof name === "string" ? name : name && typeof name === "object" ? ((name as Record<string, unknown>).slug as string) : "";
    if (label && status) out.set(label.toLowerCase(), String(status).toLowerCase());
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  try { visit(JSON.parse(text)); } catch {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (m) { try { visit(JSON.parse(m[0])); } catch { /* not JSON */ } }
  }
  return [...out].map(([name, status]) => ({ name, status })).slice(0, 40);
}
