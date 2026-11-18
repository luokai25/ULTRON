import type { Http, HttpResult } from "../products/browser";

/**
 * Minimal MCP client for Streamable HTTP servers (JSON-RPC over POST, replies as JSON or a server-sent-event stream).
 * Handles the session id, protocol version header, paginated tool listing, one automatic re-initialise when a session
 * expires, and clear errors for bad keys. Server output is treated as untrusted data by every caller.
 */

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } };
export type McpContent = { type: string; text?: string; [k: string]: unknown };
export type McpCallResult = { isError: boolean; text: string; raw: unknown };

export class McpError extends Error {
  constructor(message: string, readonly kind: "auth" | "network" | "protocol" | "server" | "timeout", readonly status = 0) { super(message); this.name = "McpError"; }
}

export type McpConfig = { url: string; headers: Record<string, string>; http: Http; clientName?: string; clientVersion?: string; timeoutMs?: number };

const PROTOCOL = "2025-06-18";

/** Pulls the JSON-RPC message with `id` out of a JSON body or an SSE stream. */
export function parseRpcBody(text: string, contentType: string, id: number): { result?: unknown; error?: { code: number; message: string } } | null {
  const tryJson = (raw: string): { result?: unknown; error?: { code: number; message: string }; id?: number }[] => {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [v]; } catch { return []; }
  };
  let messages: Array<{ id?: number; result?: unknown; error?: { code: number; message: string } }> = [];
  if (/event-stream/i.test(contentType) || /^\s*(event|data|id|:)/.test(text)) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) messages.push(...tryJson(data));
    }
  } else messages = tryJson(text);
  return messages.find((m) => m.id === id) ?? null;
}

export class McpClient {
  private sessionId = ""; private nextId = 1; private ready = false; private readonly timeout: number;
  serverInfo: { name?: string; version?: string } = {};
  constructor(private readonly cfg: McpConfig) { this.timeout = cfg.timeoutMs ?? 30000; }

  private baseHeaders(): Record<string, string> {
    return { ...this.cfg.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}) };
  }

  private async post(body: unknown): Promise<HttpResult> {
    if (!this.cfg.http.request) throw new McpError("This device's HTTP transport cannot send POST requests.", "protocol");
    try { return await this.cfg.http.request("POST", this.cfg.url, { headers: this.baseHeaders(), body: JSON.stringify(body), timeoutMs: this.timeout }); }
    catch (e) { throw new McpError(e instanceof Error ? e.message : "Network error", /abort|timeout/i.test(String(e)) ? "timeout" : "network"); }
  }

  private check(res: HttpResult): void {
    if (res.status === 401 || res.status === 403) throw new McpError("The connector service rejected the API key. Check it, or generate a new one in the Composio dashboard.", "auth", res.status);
    if (res.status === 429) throw new McpError("The connector service is rate limiting requests. Try again in a minute.", "server", 429);
    if (res.status >= 500) throw new McpError(`The connector service had an error (HTTP ${res.status}).`, "server", res.status);
  }

  async initialize(): Promise<void> {
    this.sessionId = ""; this.ready = false;
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: this.cfg.clientName ?? "ultron", version: this.cfg.clientVersion ?? "3" } } });
    this.check(res);
    if (res.status >= 400) throw new McpError(`The connector service answered HTTP ${res.status}.`, "protocol", res.status);
    const msg = parseRpcBody(res.text, res.contentType, id);
    if (!msg) throw new McpError("The connector service did not answer the handshake.", "protocol");
    if (msg.error) throw new McpError(msg.error.message, "protocol");
    this.sessionId = res.headers?.["mcp-session-id"] ?? "";
    const info = (msg.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo; if (info) this.serverInfo = info;
    this.ready = true;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>, retry = true): Promise<T> {
    if (!this.ready) await this.initialize();
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (res.status === 404 && retry && this.sessionId) { this.ready = false; return this.rpc<T>(method, params, false); } // session expired
    this.check(res);
    if (res.status >= 400) throw new McpError(`The connector service answered HTTP ${res.status}.`, "protocol", res.status);
    const msg = parseRpcBody(res.text, res.contentType, id);
    if (!msg) throw new McpError("The connector service sent an unreadable reply.", "protocol");
    if (msg.error) {
      if (retry && /session|initializ/i.test(msg.error.message)) { this.ready = false; return this.rpc<T>(method, params, false); }
      throw new McpError(msg.error.message, "protocol");
    }
    return msg.result as T;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.rpc<{ tools?: Array<Partial<McpTool>>; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      for (const t of r.tools ?? []) if (t.name) tools.push({ name: t.name, description: t.description ?? "", inputSchema: (t.inputSchema as Record<string, unknown>) ?? {}, annotations: t.annotations });
      if (!r.nextCursor) break; cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = await this.rpc<{ content?: McpContent[]; isError?: boolean; structuredContent?: unknown }>("tools/call", { name, arguments: args });
    const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content omitted]`)).join("\n").trim();
    return { isError: Boolean(r.isError), text: text || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : ""), raw: r };
  }
}
