import { parseConnectionChips, type ComposioSettings, type ComposioState } from "./composio";

/** Names of the apps the owner has connected, as best as can be told from Composio's connections reply and tool names. */
export function connectedAppNames(state: Pick<ComposioState, "connections" | "groups" | "status">): string[] {
  const out = new Set<string>();
  if (state.connections) for (const c of parseConnectionChips(state.connections.text)) if (/active|connected|enabled|success/i.test(c.status)) out.add(c.name);
  for (const g of state.groups) if (g.id !== "COMPOSIO") out.add(g.id.toLowerCase());
  return [...out].slice(0, 40);
}

export type AwarenessInput = { state: ComposioState; settings: ComposioSettings; browserAccess: "allowed" | "denied" | "unset" | "none"; products: boolean };

/**
 * Standing knowledge for Ultron's system prompt: what this app can really do for him, so he never claims he cannot read the
 * owner's email, search the web or open a link, and knows how those abilities are triggered.
 */
export function buildToolAwareness(input: AwarenessInput): string {
  const { state, settings } = input;
  const apps = connectedAppNames(state);
  const lines: string[] = ["REAL ABILITIES OF THIS APP (use them; never say you cannot do these when they are available):"];
  if (settings.enabled && state.status === "connected") {
    lines.push(`- Connected apps (via Composio): ONLINE with ${state.tools.length} tools${apps.length ? `. Apps the owner connected: ${apps.join(", ")}` : ""}. When the owner asks about email, calendar, documents, files, messages, tasks, code repos, spreadsheets, CRM, payments, social posts or any connected app, the app automatically runs the right tool BEFORE you answer and places the outcome in the message under "[Connected apps: ...]". Answer from that outcome. If it says the owner declined an action, do not retry or pressure them. Reading is automatic; sending, posting, creating or deleting always asks the owner for approval first.`);
    lines.push("- If the owner asks which apps are connected or what you can access, answer from the list above. They can add or remove apps in Composio; the list refreshes automatically (Settings → Connected apps, or the Tools tab).");
  } else if (state.status === "connecting") lines.push("- Connected apps (Composio): connecting right now. Tell the owner to try again in a moment if they ask about their apps.");
  else if (state.status === "error") lines.push(`- Connected apps (Composio): currently unreachable (${state.error || "network problem"}). Say so plainly if the owner asks about their apps.`);
  else lines.push("- Connected apps (Composio): not connected. If the owner asks for something that needs their apps, tell them to open Settings → Connected apps (or the Tools tab) to connect.");
  if (settings.webInChat) lines.push(`- Web: links the owner pastes are read, and questions that need current facts trigger a live multi-source web search${input.browserAccess === "allowed" ? " using the phone's browser engine" : ""} before you answer. The results arrive under "[Live web research ...]" with numbered notes. Answer the question DIRECTLY in your own words first, with specific names, numbers and dates, then add short caveats if sources disagree. Cite as [1], [2]. Never reply with just a list of links, and never say you cannot browse.`);
  if (input.products) lines.push("- AI Digital Products: the app can research, outline, write (up to 50+ pages from 150 sources), brand and export an eBook as PDF or EPUB. When the owner asks for an ebook or digital product, it opens that tab and starts. Finished files are saved to the phone's Downloads folder when the owner exports them.");
  lines.push("- Local models: the owner can import a local GGUF model from the LLM API KEYS screen or Settings.");
  return lines.join("\n");
}

const STATUS_Q = /\b(what|which|list|show|see|tell me)\b[^.?!]{0,50}\b(apps?|connectors?|connections?|integrations?|tools?|plugins?|accounts?)\b[^.?!]{0,40}\b(connected|have|access|use|linked|available|installed|hooked)\b|\bwhat can you (?:access|connect|do with my|see)\b|\bam i connected\b|\bis (?:my )?(?:composio|gmail|slack|notion|github|calendar|drive)\b[^.?!]{0,30}\b(connected|linked|working)\b/i;
export const asksAboutConnections = (text: string): boolean => STATUS_Q.test(text);

export function connectionsStatusContext(state: ComposioState, settings: ComposioSettings): string {
  const apps = connectedAppNames(state);
  const body = state.status === "connected"
    ? `Composio is connected (${state.tools.length} tools, last synced ${state.syncedAt ? new Date(state.syncedAt).toISOString() : "unknown"}). Connected apps: ${apps.length ? apps.join(", ") : "none could be listed yet"}.${state.connections ? `\nLatest connections report:\n${state.connections.text.slice(0, 1800)}` : ""}${settings.enabled ? "" : "\nThe owner has switched off using connected apps in chat."}`
    : state.status === "no-key" ? "Composio is not connected. The owner can connect it in Settings → Connected apps." : state.status === "connecting" ? "Composio is connecting right now." : `Composio could not be reached: ${state.error}.`;
  return `\n\n[Connected apps status (read from the app just now; trustworthy)]\n${body}`;
}
