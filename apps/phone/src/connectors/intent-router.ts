import { extractJson } from "../products/json";

/**
 * Decides whether a chat message needs the owner's connected apps, and which ones, without relying on trigger words.
 *
 * Three stages, cheapest first:
 *  1. @mentions: the owner pointed at an app (`@gmail what's new`). Always honoured, no guessing.
 *  2. Rules: a scored lexicon per app (nouns, verbs, phrases like "am I free" or "on main") plus cues that the request is
 *     about the owner's own things (my, a day, an action) versus a general knowledge question ("explain", "what is").
 *  3. Model: only for the middle band the rules cannot settle. A tiny JSON classifier call, never a tool loop.
 * Nothing here executes a tool. It only chooses; approval for anything that changes data stays in agent-loop/composio-agent.
 */

export type RouteMode = "mention" | "rules" | "defer" | "none";
export type RouteDecision = {
  use: boolean;
  mode: RouteMode;
  /** Connected app slugs that look relevant, best first. */
  apps: string[];
  /** Apps the owner explicitly @mentioned. */
  mentions: string[];
  confidence: number;
  /** The message with @mentions removed, ready to hand to a tool loop. */
  task: string;
  reason: string;
};

export const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const BRAND: Record<string, string> = {
  googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs", googlesheets: "Google Sheets", googleslides: "Google Slides",
  googlemeet: "Google Meet", googletasks: "Google Tasks", googlesuper: "Google", google_analytics: "Google Analytics", google_search_console: "Search Console",
  github_mcp: "GitHub MCP", hugging_face: "Hugging Face", microsoft_word: "Word", agent_mail: "AgentMail", brave_search: "Brave Search", youtube: "YouTube",
  gmail: "Gmail", github: "GitHub", linear: "Linear", notion: "Notion", outlook: "Outlook", sentry: "Sentry",
};
export function prettyAppName(slug: string): string {
  if (BRAND[slug]) return BRAND[slug] as string;
  return slug.split(/[_-]+/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

/* ---------- @mentions ---------- */

export type MentionSuggestion = { slug: string; label: string };
export type ActiveMention = { start: number; end: number; query: string };

/** The `@token` being typed right before the cursor, or null. A mention must start the text or follow whitespace. */
export function activeMention(text: string, cursor: number = text.length): ActiveMention | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)@([A-Za-z0-9_]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: cursor - query.length - 1, end: cursor, query };
}

/**
 * Connected apps that match what has been typed after "@". Order: name starts with it, then a word of the name starts with it
 * ("analytics" finds Google Analytics), then it appears anywhere. Typing more letters narrows the list.
 */
export function suggestMentions(query: string, apps: readonly string[], limit = 8): MentionSuggestion[] {
  const q = flat(query);
  const rows = [...new Set(apps)].map((slug) => {
    const f = flat(slug); const label = prettyAppName(slug);
    const words = [...slug.split(/[_-]+/), ...label.split(/\s+/)].map(flat).filter(Boolean);
    const rank = !q ? 0 : f.startsWith(q) || flat(label).startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : q.length >= 3 && f.includes(q) ? 2 : -1;
    return { slug, label, rank };
  }).filter((r) => r.rank >= 0);
  rows.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return rows.slice(0, limit).map(({ slug, label }) => ({ slug, label }));
}

/** Replaces the `@token` at the cursor with `@slug ` and returns the new text and cursor. */
export function applyMention(text: string, active: ActiveMention, slug: string): { text: string; cursor: number } {
  const rest = text.slice(active.end);
  const insert = `@${slug}${/^\s/.test(rest) ? "" : " "}`;
  const out = text.slice(0, active.start) + insert + rest;
  // Land after the space (the one we added or the one already there) so the owner can keep typing the request.
  return { text: out, cursor: active.start + insert.length + (/^\s/.test(rest) ? 1 : 0) };
}

/** Resolves a typed token to a connected app: exact match first, then a unique prefix. */
export function resolveMention(token: string, apps: readonly string[]): string | null {
  const t = flat(token);
  if (!t) return null;
  const exact = apps.find((a) => flat(a) === t);
  if (exact) return exact;
  const prefix = apps.filter((a) => flat(a).startsWith(t));
  return prefix.length === 1 ? (prefix[0] as string) : null;
}

export function parseMentions(text: string, apps: readonly string[]): { mentions: string[]; unknown: string[]; task: string } {
  const mentions: string[] = []; const unknown: string[] = [];
  const task = text.replace(/(^|\s)@([A-Za-z0-9_]+)/g, (all, lead: string, tok: string) => {
    const slug = resolveMention(tok, apps);
    if (slug) { if (!mentions.includes(slug)) mentions.push(slug); return lead; }
    unknown.push(tok); return all;
  }).replace(/\s+/g, " ").trim();
  return { mentions, unknown, task };
}

/* ---------- rules ---------- */

type Cue = [RegExp, number];
type AppProfile = { aliases: string[]; cues: Cue[] };

const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const TIME_WORD = new RegExp(`\\b(?:today|tomorrow|tonight|yesterday|overnight|this (?:morning|afternoon|evening|week)|last (?:night|week)|next week|since yesterday|${DAY})\\b`, "i");

/** What each app is for, in the words people use. Weights: 3 decisive, 2 strong, 1.5 suggestive. */
const PROFILES: Record<string, AppProfile> = {
  gmail: { aliases: ["gmail", "google mail", "email", "e-mail", "emails", "inbox"], cues: [
    [/\b(?:mail|e-?mail(?:ed|s|ing)?|inbox|unread|attachment|email thread|thread from)\b/i, 3], [/\b(?:said|say|says|wrote|writes|sent|texted|messaged) (?:to )?(?:me|us)\b/i, 2.5], [/\bsent me\b/i, 2.5],
    [/\banything from\b|\b(?:did i get|got any|get any) /i, 2], [/\bwrite back\b|\b(?:reply|respond|answer) (?:to|back)\b|\btell (?:him|her|them)\b/i, 2],
    [/\b(?:reply|respond) to\b/i, 2], [/\bthread\b/i, 2], [/\btell \w+ (?:i'?m|i am|i'll|that|we)\b/i, 1.5], [/\binvoice\b/i, 1] ] },
  outlook: { aliases: ["outlook"], cues: [] },
  agent_mail: { aliases: ["agentmail", "agent mail"], cues: [] },
  googlecalendar: { aliases: ["google calendar", "gcal", "calendar"], cues: [
    [/\b(?:am i|are we) (?:free|busy|available)\b/i, 3], [/\bdo i have (?:anything|something|plans)\b/i, 2.5], [/\banything on (?:my )?(?:calendar|agenda|schedule|[a-z]+day)\b/i, 2.5],
    [/\b(?:agenda|appointments?|availability)\b/i, 2.5], [/\bmeetings?\b/i, 1.5], [/\bmy next (?:call|meeting|appointment|event|flight)\b|\b(?:stand-?up|1:1|one-on-one|dentist|doctor'?s?) ?(?:appointment)?\b/i, 2.5], [/\b(?:my|move|reschedule|cancel|push) .{0,12}\b\d{1,2}(?::\d\d)? ?(?:am|pm)\b/i, 2.5],
    [/\bbook\b.{0,30}\b(?:minutes?|hour|slot|meeting|call)\b/i, 2.5], [/\binvited me\b|\binvite\b/i, 2], [/\bschedule (?:a|an|the|my|me)\b/i, 2], [/\bevents?\b/i, 1.5],
    [/\b(?:did|do|have) i (?:miss|missed|have)\b/i, 1] ] },
  github: { aliases: ["github", "git hub"], cues: [
    [/\b(?:repo|repos|repository|repositories)\b/i, 2.5], [/\b[\w.-]+\/[\w.-]+\b(?=.*\b(?:repo|issue|pr|commit|branch)\b)/i, 3], [/\b(?:commits?|branch(?:es)?|pull requests?|prs?|merge[sd]?|fork)\b/i, 2.5],
    [/\b(?:on|to|into|from) main\b|\bmain branch\b/i, 2.5], [/\bissues?\b/i, 2], [/\b(?:build|ci|checks?|workflow run)\b.{0,20}\b(?:passed|failed|green|red|ok)\b/i, 2.5], [/\bpush (?:this|that|the|my|these)\b/i, 2], [/\bstar\b.{0,20}\brepo\b/i, 1] ] },
  sentry: { aliases: ["sentry"], cues: [[/\b(?:errors?|exceptions?|crash(?:es)?|stack ?traces?)\b.{0,30}\b(?:came in|overnight|last night|today|yesterday|in prod\w*|this week)\b/i, 3], [/\bnew (?:errors?|crashes)\b/i, 2.5]] },
  google_analytics: { aliases: ["google analytics", "ga4", "analytics"], cues: [[/\b(?:visitors?|visited|traffic|page ?views?|unique users|bounce rate)\b/i, 2.5], [/\bhow many (?:people|users)\b.{0,40}\b(?:site|page|app|website)\b/i, 2.5]] },
  google_search_console: { aliases: ["search console", "gsc"], cues: [[/\b(?:search queries|impressions|click-?through|indexed|indexing|search ranking)\b/i, 3]] },
  linear: { aliases: ["linear"], cues: [[/\b(?:tickets?|sprint|backlog|assigned to me|cycle)\b/i, 2.5], [/\bassign(?:ed)?\b.{0,30}\b(?:to me|bug|issue|task)\b/i, 2.5]] },
  reddit: { aliases: ["reddit", "subreddit"], cues: [[/\br\/\w+/i, 3], [/\b(?:upvotes?|subreddits?)\b/i, 2.5]] },
  youtube: { aliases: ["youtube", "yt"], cues: [[/\b(?:my|latest|last|new) (?:videos?|channel)\b/i, 2.5], [/\b(?:subscribers?|subs)\b/i, 2], [/\b(?:views|watch time) on my\b/i, 2.5], [/\bcomments? on (?:my|the) (?:last |latest )?(?:video|short)\b/i, 3]] },
  instagram: { aliases: ["instagram", "insta", "ig"], cues: [[/\bmy (?:posts?|reels?|stories|followers?|captions?)\b/i, 2.5], [/\b(?:reel|caption)s?\b/i, 1.5]] },
  notion: { aliases: ["notion"], cues: [[/\b(?:my )?(?:notes|wiki|roadmap)\b/i, 2]] },
  googledrive: { aliases: ["google drive", "gdrive", "drive"], cues: [
    [/\bmy (?:storage|files?|folders?|documents?)\b/i, 2.5], [/\bupload (?:this|that|it|the|these)\b/i, 2.5], [/\bshare (?:the|this|my|that) (?:\w+ )?(?:report|file|doc|document|deck|folder|sheet|contract|pdf)\b/i, 2.5], [/\b(?:contract|pdf|pitch deck)\b/i, 1.5] ] },
  dropbox: { aliases: ["dropbox"], cues: [[/\b(?:play|put on|queue up)\b.{0,50}\b(?:song|music|track|album|playlist|mp3)\b/i, 2.5], [/\b(?:save|store|keep|upload|put)\b.{0,40}\b(?:in|to|on) (?:your |ultron'?s? |my )?(?:storage|cloud|dropbox)\b/i, 3], [/\bultron'?s? (?:storage|files|folder|music)\b/i, 3]] },
  googledocs: { aliases: ["google docs", "gdoc", "gdocs"], cues: [[/\b(?:create|make|start|open|new|write) (?:me )?(?:a |an |the )?(?:new )?(?:google )?(?:doc|document)\b/i, 2.5]] },
  googlesheets: { aliases: ["google sheets", "gsheet", "gsheets", "spreadsheet"], cues: [[/\b(?:spreadsheet|sheet(?! music)|rows?|cells?)\b/i, 2], [/\b(?:budget|numbers|figures)\b/i, 1]] },
  excel: { aliases: ["excel", "xlsx"], cues: [] },
  googleslides: { aliases: ["google slides", "slides", "deck"], cues: [[/\b(?:slides?|slide deck)\b/i, 2]] },
  microsoft_word: { aliases: ["word doc", "microsoft word"], cues: [] },
  googletasks: { aliases: ["google tasks", "todo", "to-do"], cues: [[/\bremind me\b/i, 3], [/\bwhat'?s due\b|\bdue (?:today|tomorrow|this week)\b|\boverdue\b/i, 2.5], [/\b(?:on my plate|my (?:tasks?|todos?|to-?do list))\b/i, 3]] },
  zoom: { aliases: ["zoom"], cues: [] },
  googlemeet: { aliases: ["google meet", "meet link"], cues: [] },
  gumroad: { aliases: ["gumroad"], cues: [[/\bwhat sold\b|\bmy (?:latest |recent |new )?(?:orders?|sales|customers?|products?)\b|\b(?:latest|recent|new) (?:orders|sales)\b/i, 2.5]] },
  amazon: { aliases: ["amazon"], cues: [[/\bmy (?:latest |recent )?(?:orders?|purchases?|cart)\b/i, 2]] },
  canva: { aliases: ["canva"], cues: [] },
  figma: { aliases: ["figma"], cues: [] },
  shotstack: { aliases: ["shotstack"], cues: [] },
  hugging_face: { aliases: ["hugging face", "huggingface", "hf"], cues: [[/\bmy (?:models?|spaces?|datasets?)\b/i, 2]] },
  kaggle: { aliases: ["kaggle"], cues: [] },
  brave_search: { aliases: ["brave search"], cues: [] },
};

/**
 * Connected apps the lexicon has no profile for still get found by what the request does: shipping a build, or asking about
 * "my database". Their own names are matched dynamically from the connected list, so nothing here names a specific product.
 */
const FALLBACK_CUES: Cue[] = [
  [/\bdeploy(?:s|ed|ment|ments|ing)?\b/i, 2.5], [/\bis (?:the|my) (?:site|app|website|build)\b/i, 2], [/\bpreview (?:url|link|build)\b/i, 2],
  [/\bmy (?:database|tables?|db)\b/i, 2.5],
];

/** General knowledge or writing requests that only mention an app by name. */
const KNOWLEDGE: RegExp[] = [
  /^\s*(?:explain|describe|define|compare|summari[sz]e the plot|translate|write (?:me )?(?:a|an|some) (?:short |quick |funny |long )?(?:poem|story|essay|joke|song|haiku|speech|script|paragraph)|tell me a joke|fix this|debug this)\b/i,
  /\b(?:what is|what are|what's an?|what does (?:an?|the) .{1,40} do|what's the difference|difference between|which is better|pros and cons)\b/i,
  /\bhow (?:do|does|did|to|can|should|would) (?:i |you |we |people |a |an |the )?(?!my\b)/i,
  /\bwhy (?:do|does|is|are|did)\b/i,
  /\b(?:regex|regexp|regular expression|code snippet|sql query|function that|give me (?:a|an) (?:function|script|class|snippet))\b/i,
  /\b(?:vs\.?|versus)\b/i,
  /\b(?:template|ideas? for|tips? (?:for|on)|good (?:schedule|way|name)|what's a good|name my|what should i name)\b/i,
];

const PERSONAL = /\b(?:my|our|mine)\b|@/i;
const WEAK_PERSONAL = /\b(?:me|i|i'm|i'll|i've)\b/i;
const ACTION_START = /^\s*(?:please |hey |ultron[, ]*)?(?:send|check|show|find|open|close|create|make|post|push|share|schedule|move|book|upload|deploy|reply|forward|remind|tell|add|delete|commit|star|pull up|read|list|search|look|summari[sz]e my)\b/i;
const BRIEFING = /\b(?:anything (?:urgent|new|important)|what did i miss|catch me up|brief me|what should i know|what's new|any news for me|what's going on)\b/i;

export type Scored = { app: string; score: number };

/** Scores every connected app (or every known app when none are listed) against the message. */
export function scoreApps(text: string, connected: readonly string[]): Scored[] {
  const pool = connected.length ? [...connected] : Object.keys(PROFILES);
  const lower = text.toLowerCase();
  const out: Scored[] = [];
  for (const app of pool) {
    const profile = PROFILES[app];
    let score = 0;
    const names = new Set<string>([app.replace(/[_-]+/g, " "), ...(profile?.aliases ?? [])]);
    for (const n of names) {
      if (n.length < 3) continue;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(lower)) { score = Math.max(score, ["drive", "calendar", "slides", "meet link", "analytics", "sheet", "todo", "yt", "ig"].includes(n) ? 1.5 : 3); }
    }
    for (const [re, w] of profile ? profile.cues : FALLBACK_CUES) if (re.test(text)) score += w;
    if (score > 0) out.push({ app, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The rules stage. Pure and synchronous; call it as often as you like. */
export function routeIntent(text: string, connected: readonly string[] = []): RouteDecision {
  const { mentions, task } = parseMentions(text, connected);
  const base = { mentions, task: task || text.trim() };
  if (mentions.length) return { ...base, use: true, mode: "mention", apps: mentions, confidence: 1, reason: `You pointed at ${mentions.map(prettyAppName).join(", ")}.` };

  const personal = PERSONAL.test(text);
  if (KNOWLEDGE.some((k) => k.test(text)) && !personal) return { ...base, use: false, mode: "none", apps: [], confidence: 0.9, reason: "A general question, not about your apps." };

  const scored = scoreApps(text, connected);
  const top = scored[0]?.score ?? 0;
  let score = top;
  if (top > 0) {
    if (personal) score += 1; else if (WEAK_PERSONAL.test(text)) score += 0.5;
    if (TIME_WORD.test(text)) score += 0.5;
    if (ACTION_START.test(text)) score += 0.5;
  }
  const apps = scored.filter((s) => s.score >= Math.max(1, top - 1)).slice(0, 3).map((s) => s.app);
  if (score >= 2.5) return { ...base, use: true, mode: "rules", apps, confidence: Math.min(0.95, 0.5 + score / 8), reason: `Looks like a request for ${apps.map(prettyAppName).join(" / ")}.` };
  const wordy = text.trim().split(/\s+/).length >= 3;
  const aboutOwner = PERSONAL.test(text) || WEAK_PERSONAL.test(text) || TIME_WORD.test(text) || ACTION_START.test(text);
  // No app word matched, but the message is about the owner or asks for an action: let the model decide instead of guessing.
  if (score >= 1.2 || BRIEFING.test(text) || (wordy && aboutOwner)) return { ...base, use: false, mode: "defer", apps, confidence: 0.4, reason: "Could be about your apps; needs a closer look." };
  return { ...base, use: false, mode: "none", apps: [], confidence: 0.85, reason: "Nothing here needs your connected apps." };
}

/* ---------- model stage ---------- */

export type Complete = (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, maxTokens: number, signal?: AbortSignal, effort?: "light" | "deep") => Promise<string>;

export function classifierPrompt(text: string, connected: readonly string[]): string {
  const list = connected.length ? connected.map((a) => `${a} (${prettyAppName(a)})`).join(", ") : "none listed";
  return [
    "You route messages for a personal assistant. Decide if the message needs the owner's connected apps (read, search, draft, send, create, change or run something in them) or can simply be answered in conversation.",
    `Connected apps: ${list}.`,
    'Reply with ONLY JSON: {"tools": true|false, "apps": ["slug", ...], "why": "<six words>"}. Use the slugs exactly as listed; apps may be empty when tools is false.',
    "General knowledge, writing, coding help and chit-chat need no tools. Anything about the owner's own mail, calendar, files, code repos, sites, tasks, posts or accounts does.",
    `Message: ${JSON.stringify(text.slice(0, 600))}`,
  ].join("\n");
}

export function parseClassifier(reply: string, connected: readonly string[]): { use: boolean; apps: string[] } | null {
  try {
    const v = extractJson<{ tools?: unknown; apps?: unknown }>(reply);
    if (typeof v.tools !== "boolean") return null;
    const apps = Array.isArray(v.apps) ? v.apps.filter((a): a is string => typeof a === "string").map((a) => resolveMention(a, connected) ?? "").filter(Boolean) : [];
    return { use: v.tools, apps: [...new Set(apps)] };
  } catch { return null; }
}

/** Rules first; the model only settles the middle band. If the model fails, lean on whether the message is about "my" things. */
export async function routeWithModel(text: string, connected: readonly string[], complete: Complete, signal?: AbortSignal): Promise<RouteDecision> {
  const rules = routeIntent(text, connected);
  if (rules.mode !== "defer") return rules;
  try {
    const reply = await complete([{ role: "system", content: "You output only JSON." }, { role: "user", content: classifierPrompt(rules.task, connected) }], 120, signal, "light");
    const verdict = parseClassifier(reply, connected);
    if (verdict) return { ...rules, use: verdict.use, mode: "rules", apps: verdict.apps.length ? verdict.apps : rules.apps, confidence: 0.7, reason: verdict.use ? "Checked with the model: needs your apps." : "Checked with the model: answer directly." };
  } catch (e) { if (e instanceof DOMException && e.name === "AbortError") throw e; }
  const lean = PERSONAL.test(text) || BRIEFING.test(text);
  return { ...rules, use: lean, mode: "rules", confidence: 0.4, reason: lean ? "Leaning toward your apps." : "Leaning toward a direct answer." };
}
