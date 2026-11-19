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
};
export type ComposioSettings = { enabled: boolean; askBefore: boolean; allowedTools: string[]; webInChat: boolean };

export const DEFAULT_SETTINGS: ComposioSettings = { enabled: true, askBefore: true, allowedTools: [], webInChat: true };

export type SecretStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
export type KeyValue = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

const KEY_NAME = "ultron.composio.consumer-key.v1";
const CACHE = "ultron.composio.cache.v1";
const SETTINGS = "ultron.composio.settings.v1";
const BUILT_IN_OFF = "ultron.composio.built-in-off.v1";

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
  private state: ComposioState = { status: "no-key", error: "", tools: [], toolHash: "", groups: [], syncedAt: 0, serverName: "", connections: null, keyHint: "", keySource: "none" };
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
    try { const c = JSON.parse(this.deps.kv.getItem(CACHE) ?? "null") as { tools: McpTool[]; at: number; serverName?: string; connections?: ComposioState["connections"] } | null; if (c?.tools?.length) this.state = { ...this.state, tools: c.tools, toolHash: hashTools(c.tools), groups: groupTools(c.tools), syncedAt: c.at, serverName: c.serverName ?? "", connections: c.connections ?? null }; } catch { /* no cache */ }
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
    this.state = { status: "no-key", error: "", tools: [], toolHash: "", groups: [], syncedAt: 0, serverName: "", connections: null, keyHint: "", keySource: "none" }; this.emit("status");
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
        const hash = hashTools(tools);
        const changed = hash !== this.state.toolHash;
        this.state = { ...this.state, status: "connected", error: "", tools, toolHash: hash, groups: groupTools(tools), syncedAt: this.now(), serverName: client.serverInfo.name ?? this.state.serverName };
        try { this.deps.kv.setItem(CACHE, JSON.stringify({ tools, at: this.state.syncedAt, serverName: this.state.serverName, connections: this.state.connections })); } catch { /* cache is optional */ }
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

  async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const client = await this.getClient();
    if (!client) return { ok: false, text: "Composio is not connected. Add the API key in Settings." };
    try { const r = await client.callTool(name, args); return { ok: !r.isError, text: r.text || (r.isError ? "The tool returned an error." : "Done.") }; }
    catch (e) { return { ok: false, text: e instanceof Error ? e.message : "The tool call failed." }; }
  }

  /**
   * Asks Composio which apps are connected by calling its connections tool directly with schema-derived arguments.
   * Tool names and arguments come from Composio at runtime; if the call does not fit, the snapshot stays empty and the
   * settings panel offers to ask Ultron to check instead.
   */
  async probeConnections(): Promise<void> {
    const tool = this.state.tools.find((t) => /MANAGE_CONNECTIONS|LIST_CONNECTIONS|CONNECTED_ACCOUNTS|CHECK_CONNECTIONS/i.test(t.name));
    if (!tool) return;
    for (const args of guessListArgs(tool)) {
      const r = await this.call(tool.name, args);
      if (r.ok && r.text.trim()) { this.set({ connections: { text: r.text.slice(0, 6000), at: this.now(), ok: true } }, "connections"); try { this.deps.kv.setItem(CACHE, JSON.stringify({ tools: this.state.tools, at: this.state.syncedAt, serverName: this.state.serverName, connections: this.state.connections })); } catch { /* ignore */ } return; }
    }
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
