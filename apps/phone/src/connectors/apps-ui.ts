import { COMMON_TOOLKITS, type AppConnection, type ComposioManager } from "./composio";

/** The owner's real connected apps, as a grid with logos, account counts and a way to connect more. */

const NAMES: Record<string, string> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive", googledocs: "Google Docs", googlesheets: "Google Sheets", googleslides: "Google Slides",
  googletasks: "Google Tasks", googlemeet: "Google Meet", googlesuper: "Google Super", github: "GitHub", github_mcp: "GitHub MCP", notion: "Notion", slack: "Slack", linear: "Linear",
  outlook: "Outlook", microsoft_word: "Word", excel: "Excel", microsoft_teams: "Teams", onedrive: "OneDrive", dropbox: "Dropbox", canva: "Canva", figma: "Figma",
  cloudflare: "Cloudflare", sentry: "Sentry", zoom: "Zoom", youtube: "YouTube", instagram: "Instagram", reddit: "Reddit", twitter: "X (Twitter)", linkedin: "LinkedIn",
  higgsfield_mcp: "Higgsfield", shotstack: "Shotstack", brave_search: "Brave Search", google_analytics: "Google Analytics", google_search_console: "Search Console", agent_mail: "AgentMail",
  financial_datasets_ai_mcp: "Financial Datasets", wispr_flow_mcp: "Wispr Flow", gumroad: "Gumroad", amazon: "Amazon", openai: "OpenAI", perplexityai: "Perplexity", elevenlabs: "ElevenLabs",
};
export const appName = (slug: string): string => NAMES[slug] ?? slug.replace(/_mcp$/, "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const TILE = ["#e8505b", "#4a8fe7", "#3fb67a", "#e0a43a", "#8b6fe0", "#3bb7c4", "#d96aa7"];
const tileColor = (slug: string): string => TILE[[...slug].reduce((n, c) => n + c.charCodeAt(0), 0) % TILE.length] as string;

function icon(slug: string): HTMLElement {
  const wrap = document.createElement("span"); wrap.className = "app-icon"; wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText = `display:inline-grid;place-items:center;width:42px;height:42px;border-radius:12px;background:${tileColor(slug)}22;border:1px solid ${tileColor(slug)}55;overflow:hidden;flex:0 0 42px;font:700 16px system-ui,sans-serif;color:${tileColor(slug)}`;
  const letter = appName(slug).charAt(0).toUpperCase();
  wrap.textContent = letter;
  const img = document.createElement("img"); img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.src = `https://logos.composio.dev/api/${encodeURIComponent(slug.replace(/_mcp$/, ""))}`;
  img.style.cssText = "width:26px;height:26px;object-fit:contain;position:absolute;opacity:0;transition:opacity .2s";
  wrap.style.position = "relative";
  img.addEventListener("load", () => { img.style.opacity = "1"; wrap.firstChild && wrap.firstChild.nodeType === 3 && (wrap.firstChild.textContent = ""); });
  img.addEventListener("error", () => img.remove());
  wrap.append(img);
  return wrap;
}

export type AppsHost = { openUrl: (url: string) => void; askUltron: (prompt: string) => void };

export function mountAppsGrid(root: HTMLElement, manager: ComposioManager, host: AppsHost): void {
  let expanded = ""; let note = ""; let busy = false;
  const paint = (): void => {
    const state = manager.getState();
    root.replaceChildren();
    if (state.status === "no-key" && !Object.keys(state.apps).length) return;
    const active = Object.values(state.apps).filter((a) => a.accounts.some((x) => /active/.test(x.status))).sort((a, b) => appName(a.slug).localeCompare(appName(b.slug)));
    const pending = Object.values(state.apps).filter((a) => !a.accounts.some((x) => /active/.test(x.status)) && /initiat|pending|expired|fail/.test(a.status));
    const descOnly = state.connectedApps.filter((s) => !state.apps[s]).map((slug): AppConnection => ({ slug, status: "active", accounts: [] }));
    const shown = [...active, ...descOnly];
    const title = document.createElement("div"); title.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;margin:6px 0 8px";
    const h = document.createElement("strong"); h.textContent = `Your connected apps (${shown.length})`;
    const sub = document.createElement("small"); sub.textContent = state.status === "connecting" ? "Loading…" : "via Composio";
    title.append(h, sub); root.append(title);
    if (!shown.length && state.status === "connected") { const p = document.createElement("p"); p.className = "native-model-status"; p.textContent = "No connected apps found yet. Add one below, or tap Refresh now."; root.append(p); }

    const grid = document.createElement("div"); grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px";
    for (const app of shown) {
      const card = document.createElement("button"); card.type = "button"; card.className = "plug-card"; card.setAttribute("aria-expanded", String(expanded === app.slug));
      card.style.cssText = "display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;padding:11px;min-height:96px;border-radius:14px";
      const top = document.createElement("span"); top.style.cssText = "display:flex;gap:9px;align-items:center;width:100%";
      const name = document.createElement("strong"); name.textContent = appName(app.slug); name.style.cssText = "font-size:13px;overflow-wrap:anywhere";
      top.append(icon(app.slug), name);
      const meta = document.createElement("small"); meta.style.cssText = "color:#98a2b1;font-size:11px;line-height:1.4";
      const dot = document.createElement("i"); dot.style.cssText = "display:inline-block;width:7px;height:7px;border-radius:50%;background:#55d6a0;margin-right:6px";
      meta.append(dot, app.accounts.length ? `${app.accounts.length} account${app.accounts.length > 1 ? "s" : ""}` : "Connected");
      card.append(top, meta);
      if (expanded === app.slug) {
        const detail = document.createElement("span"); detail.style.cssText = "display:grid;gap:4px;width:100%;font-size:11px;color:#c2cbd7";
        for (const a of app.accounts) { const row = document.createElement("span"); row.textContent = `${a.label}${a.isDefault ? " · default" : ""}`; row.style.overflowWrap = "anywhere"; detail.append(row); }
        const ask = document.createElement("span"); ask.textContent = `Ask Ultron about ${appName(app.slug)} →`; ask.style.cssText = "color:var(--accent-bright,#ff7b86);font-weight:650;margin-top:2px";
        ask.addEventListener("click", (e) => { e.stopPropagation(); host.askUltron(`Using my ${appName(app.slug)}, `); });
        detail.append(ask); card.append(detail);
      }
      card.addEventListener("click", () => { expanded = expanded === app.slug ? "" : app.slug; paint(); });
      grid.append(card);
    }
    root.append(grid);

    if (pending.length) { const p = document.createElement("p"); p.className = "native-model-status"; p.textContent = `Waiting for sign-in: ${pending.map((a) => appName(a.slug)).join(", ")}. Finish signing in, then tap Refresh now.`; root.append(p); }

    // Connect another app: choose or type an app; Composio returns a sign-in link.
    const add = document.createElement("div"); add.style.cssText = "display:flex;gap:8px;margin-top:12px;align-items:stretch";
    const input = document.createElement("input"); input.type = "text"; input.placeholder = "Connect another app (for example slack)"; input.setAttribute("aria-label", "App to connect"); input.setAttribute("list", "composio-app-options"); input.autocapitalize = "off"; input.style.cssText = "flex:1;min-height:44px;padding:0 12px;border-radius:12px;border:1px solid var(--hairline,#333);background:#151a22;color:inherit";
    const list = document.createElement("datalist"); list.id = "composio-app-options";
    for (const slug of COMMON_TOOLKITS.filter((s) => !shown.some((a) => a.slug === s))) { const o = document.createElement("option"); o.value = slug; o.label = appName(slug); list.append(o); }
    const go = document.createElement("button"); go.type = "button"; go.className = "solid"; go.textContent = busy ? "…" : "Connect"; go.disabled = busy;
    go.addEventListener("click", async () => {
      const slug = input.value.trim().toLowerCase().replace(/\s+/g, "_"); if (!slug) { input.focus(); return; }
      busy = true; note = `Asking Composio to connect ${appName(slug)}…`; paint();
      const r = await manager.connectApp(slug); busy = false;
      if (r.ok && r.url) { note = `Opening the ${appName(slug)} sign-in. Finish there, come back, then tap Refresh now.`; host.openUrl(r.url); } else note = r.error || "Composio could not start that connection.";
      paint();
    });
    add.append(input, go); root.append(add, list);
    if (note) { const p = document.createElement("p"); p.className = "native-model-status"; p.setAttribute("role", "status"); p.textContent = note; root.append(p); }
  };
  manager.subscribe(() => paint());
  paint();
}
