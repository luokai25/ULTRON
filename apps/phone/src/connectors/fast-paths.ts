import type { ComposioAccount } from "./composio";
import { compact, executionResults, findObjectArray, str, type Json } from "./composio-json";

/**
 * Direct handling of the most common app requests (read my Gmail, what is on my calendar, list my GitHub repos). The app
 * already knows these tools, so it calls them itself, covers every connected account, and writes the answer in plain
 * language without depending on a small on-device model to drive a multi-step tool protocol.
 */

export type FastComposio = {
  accountsFor(toolkit: string): ComposioAccount[];
  callJson(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; json: Json | null; text: string }>;
  refreshConnections(): Promise<void>;
};
export type FastDeps = { composio: FastComposio; status: (s: string) => void; now?: () => Date };
export type FastResult = { answer: string; toolkit: string };

const WRITE = /\b(send|reply|forward|draft|compose|write|delete|trash|archive|label|mark|schedule|create|add|book|invite|cancel|remove|update|move|unsubscribe)\b/i;

export type FastIntent = { kind: "gmail" | "calendar" | "github"; detail: { latest?: boolean; unread?: boolean; count?: number; window?: "today" | "tomorrow" | "week" | "upcoming"; query?: string } };

export function detectFastIntent(text: string): FastIntent | null {
  const t = text.trim();
  if (t.length < 6 || t.length > 300 || WRITE.test(t) || /\band\s+(?:e-?mail|reply|message|text|send)\b/i.test(t) || /\b(?:e-?mail|message|text)\s+\w+\s+(?:back|that|about|to)\b/i.test(t)) return null;
  const lower = t.toLowerCase();
  if (/\b(gmail|e-?mails?|inbox|mail)\b/.test(lower) && /\b(check|read|show|open|see|what'?s|what is|tell me|any|new|latest|last|recent|unread|summar|inside|look)\b/.test(lower)) {
    const latest = /\b(last|latest|newest|most recent|recent)\s+(?:e-?mail|message|mail|gmail)\b|\bwhat'?s (?:in|inside) (?:the |my )?(?:last|latest)\b|\binside the last\b/.test(lower);
    const count = Number(lower.match(/\b(?:last|latest|recent|top)\s+(\d{1,2})\b/)?.[1] ?? 0) || undefined;
    return { kind: "gmail", detail: { latest, unread: /\bunread|new\b/.test(lower), count } };
  }
  if (/\b(calendar|schedule|agenda|meetings?|events?|appointments?)\b/.test(lower) && /\b(what|show|check|any|do i have|upcoming|today|tomorrow|this week|next|am i)\b/.test(lower)) {
    return { kind: "calendar", detail: { window: /\btomorrow\b/.test(lower) ? "tomorrow" : /\bthis week|next 7|week\b/.test(lower) ? "week" : /\btoday|tonight\b/.test(lower) ? "today" : "upcoming" } };
  }
  if (/\b(github)\b/.test(lower) && /\b(repos?|repositories)\b/.test(lower) && /\b(list|show|check|what|my|which)\b/.test(lower)) return { kind: "github", detail: {} };
  return null;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** RFC3339 with the device's real UTC offset, as the Calendar tools require. */
export function rfc3339(d: Date): string {
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? "+" : "-"; const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function calendarWindow(kind: "today" | "tomorrow" | "week" | "upcoming", now: Date): { min: string; max: string; label: string } {
  const start = new Date(now); const end = new Date(now);
  if (kind === "tomorrow") { start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1); end.setHours(23, 59, 59, 0); }
  else if (kind === "today") { end.setHours(23, 59, 59, 0); }
  else { end.setDate(end.getDate() + (kind === "week" ? 7 : 14)); }
  return { min: rfc3339(start), max: rfc3339(end), label: kind === "today" ? "today" : kind === "tomorrow" ? "tomorrow" : kind === "week" ? "the next 7 days" : "the next 2 weeks" };
}

const when = (v: unknown): string => { const s = str(v); if (!s) return ""; const d = new Date(/^\d{10,13}$/.test(s) ? Number(s.length === 10 ? s + "000" : s) : s); return Number.isNaN(d.getTime()) ? s.slice(0, 30) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };
const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

type Multi = { toolkit: string; slug: string; args: (a: ComposioAccount) => Record<string, unknown> };

async function runForAccounts(spec: Multi, deps: FastDeps): Promise<Array<{ account: ComposioAccount; ok: boolean; data: unknown; error: string }> | "none"> {
  if (!deps.composio.accountsFor(spec.toolkit).length) await deps.composio.refreshConnections().catch(() => undefined);
  const accounts = deps.composio.accountsFor(spec.toolkit).slice(0, 4);
  if (!accounts.length) return "none";
  deps.status(`Reading ${accounts.length > 1 ? `${accounts.length} ${spec.toolkit} accounts` : spec.toolkit}`);
  const r = await deps.composio.callJson("COMPOSIO_MULTI_EXECUTE_TOOL", { sync_response_to_workbench: false, thought: `Read ${spec.toolkit} for the owner`, tools: accounts.map((a) => ({ tool_slug: spec.slug, arguments: spec.args(a), account: a.id })) });
  const results = executionResults(r.json);
  return accounts.map((account, i) => { const res = results[i]; return { account, ok: res ? res.ok : r.ok && results.length === 0, data: res?.data ?? r.json, error: res?.error || (r.ok ? "" : r.text.slice(0, 200)) }; });
}

export async function runFastPath(intent: FastIntent, deps: FastDeps): Promise<FastResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  if (intent.kind === "gmail") {
    const d = intent.detail; const n = d.latest ? 1 : Math.min(d.count ?? 5, 10);
    const res = await runForAccounts({ toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", args: () => ({ max_results: n, ...(d.unread ? { query: "is:unread" } : {}), verbose: true, include_payload: true }) }, deps);
    if (res === "none") return { toolkit: "gmail", answer: "Gmail is not connected yet. Open Tools & Connectors and connect Gmail through Composio, then ask again." };
    const blocks = res.map((r) => {
      const head = `**${r.account.label}**${r.account.isDefault ? " (default)" : ""}`;
      if (!r.ok) return `${head}\nI could not read this account: ${clip(r.error || "the request failed", 160)}`;
      const msgs = findObjectArray(r.data, ["subject", "messageText", "sender", "snippet", "preview"]).slice(0, n);
      if (!msgs.length) return `${head}\nNo ${d.unread ? "unread " : ""}messages found.`;
      return `${head}\n` + msgs.map((m, i) => {
        const preview = (m.preview && typeof m.preview === "object" ? str((m.preview as Json).body) : "") || str(m.messageText) || str(m.snippet) || str(m.body);
        const body = clip(preview, d.latest ? 1100 : 170);
        return `${i + 1}. **${clip(str(m.subject) || "(no subject)", 90)}**, from ${clip(str(m.sender ?? m.from) || "unknown", 60)}${when(m.messageTimestamp ?? m.date) ? ` · ${when(m.messageTimestamp ?? m.date)}` : ""}${body ? `\n   ${body}` : ""}`;
      }).join("\n");
    });
    return { toolkit: "gmail", answer: `${d.latest ? "Your latest email" : d.unread ? "Your unread email" : "Your recent email"}${res.length > 1 ? `, from each of your ${res.length} Gmail accounts` : ""}:\n\n${blocks.join("\n\n")}` };
  }
  if (intent.kind === "calendar") {
    const w = calendarWindow(intent.detail.window ?? "upcoming", now);
    const res = await runForAccounts({ toolkit: "googlecalendar", slug: "GOOGLECALENDAR_EVENTS_LIST", args: () => ({ calendarId: "primary", timeMin: w.min, timeMax: w.max, singleEvents: true, orderBy: "startTime", maxResults: 15 }) }, deps);
    if (res === "none") return { toolkit: "googlecalendar", answer: "Google Calendar is not connected yet. Open Tools & Connectors and connect it through Composio, then ask again." };
    const blocks = res.map((r) => {
      const head = `**${r.account.label}**`;
      if (!r.ok) return `${head}\nI could not read this calendar: ${clip(r.error || "the request failed", 160)}`;
      const events = findObjectArray(r.data, ["summary", "start"]).slice(0, 12);
      if (!events.length) return `${head}\nNothing scheduled.`;
      return `${head}\n` + events.map((e) => { const s = (e.start && typeof e.start === "object" ? e.start as Json : {}); const startAt = when(s.dateTime ?? s.date); return `- **${clip(str(e.summary) || "(no title)", 80)}**${startAt ? ` · ${startAt}` : ""}${str(e.location) ? ` · ${clip(str(e.location), 50)}` : ""}`; }).join("\n");
    });
    return { toolkit: "googlecalendar", answer: `Your calendar for ${w.label}:\n\n${blocks.join("\n\n")}` };
  }
  const res = await runForAccounts({ toolkit: "github", slug: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", args: () => ({ per_page: 30, sort: "updated" }) }, deps);
  if (res === "none") return { toolkit: "github", answer: "GitHub is not connected yet. Open Tools & Connectors and connect it through Composio, then ask again." };
  const blocks = res.map((r) => {
    const head = `**${r.account.label}**`;
    if (!r.ok) return `${head}\nI could not read this account: ${clip(r.error || "the request failed", 160)}`;
    const repos = findObjectArray(r.data, ["full_name", "name"]).slice(0, 15);
    if (!repos.length) return `${head}\nNo repositories found.`;
    return `${head} (${repos.length}${repos.length === 15 ? "+" : ""})\n` + repos.map((p) => `- **${str(p.full_name ?? p.name)}**${p.private === true ? " (private)" : ""}${str(p.description) ? ` — ${clip(str(p.description), 70)}` : ""}`).join("\n");
  });
  return { toolkit: "github", answer: `Your GitHub repositories, most recently updated first:\n\n${blocks.join("\n\n")}` };
}

export { compact };
