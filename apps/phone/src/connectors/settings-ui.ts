import { COMPOSIO_URL, parseConnectionChips, type ComposioManager, type ComposioState } from "./composio";

type H = HTMLElementTagNameMap;
function el<K extends keyof H>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {}, ...kids: Array<Node | string | null | false>): H[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v); else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) node.setAttribute(k, ""); else node.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}

const ago = (t: number): string => { if (!t) return "never"; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };

export type ConnectorSettingsHost = {
  /** Runs the tool loop with the chat model to list connected apps. Resolves with Ultron's findings. */
  checkWithUltron: () => Promise<string>;
  openProducts: () => void;
};

/** Settings section: Composio key, live status, what is connected, and the switches that control how chat may use it. */
export function mountConnectorSettings(root: HTMLElement, manager: ComposioManager, host: ConnectorSettingsHost): void {
  let showKeyField = false; let busyMsg = "";
  const paint = (s: ComposioState): void => {
    root.replaceChildren();
    const settings = manager.getSettings();
    const statusText = s.status === "no-key" ? "Not connected. Paste your Composio API key to connect." : s.status === "connecting" ? "Connecting to Composio…" : s.status === "connected" ? `Connected${s.serverName ? " to " + s.serverName : ""} · ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · synced ${ago(s.syncedAt)}${s.keyHint ? " · key " + s.keyHint : ""}` : `Problem: ${s.error}`;
    const dot = el("i", { class: `status-dot ${s.status === "connected" ? "ok" : s.status === "error" ? "bad" : "warn"}`, "aria-hidden": "true" });
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:${s.status === "connected" ? "#55d6a0" : s.status === "error" ? "#ff6873" : "#f5b44a"}`;
    root.append(
      el("span", { id: "composio-heading", text: "Connected apps (Composio)" }),
      el("small", { text: "Ultron can see the apps you connected in Composio and use them when you ask, like reading your email, checking your calendar or posting a message. Apps you add or remove in Composio appear here automatically." }),
      el("p", { class: "native-model-status", role: "status", "aria-live": "polite" }, dot, statusText),
    );
    if (s.status !== "connected" && s.error && s.status !== "error") root.append(el("p", { class: "native-model-status", text: s.error }));
    if (s.status === "connected" && s.error) root.append(el("p", { class: "native-model-status", text: `Last refresh failed (${s.error}). Showing what was last known.` }));
    if (s.status === "no-key" || showKeyField) {
      const input = el("input", { type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "ck_…", "aria-label": "Composio API key" }) as HTMLInputElement;
      root.append(el("label", { class: "field" }, el("span", { text: "Composio API key" }), input, el("small", { text: `Stored in this device's secure storage and sent only to ${COMPOSIO_URL}. Find it in the Composio dashboard under Install.` })),
        el("div", { class: "sheet-actions" }, el("button", { class: "solid", type: "button", text: "Connect", onclick: async () => { busyMsg = "Connecting…"; const r = await manager.saveKey(input.value); busyMsg = r.ok ? "" : r.error ?? ""; showKeyField = !r.ok; input.value = ""; paint(manager.getState()); } })));
    } else {
      root.append(el("div", { class: "sheet-actions" },
        el("button", { class: "ghost", type: "button", text: "Refresh now", onclick: async () => { busyMsg = "Refreshing…"; paint(manager.getState()); await manager.sync("manual"); await manager.probeConnections(); busyMsg = ""; paint(manager.getState()); } }),
        el("button", { class: "ghost", type: "button", text: "Check apps with Ultron", onclick: async (e) => { const b = e.target as HTMLButtonElement; b.disabled = true; busyMsg = "Ultron is checking your connected apps…"; paint(manager.getState()); try { const text = await host.checkWithUltron(); if (text.trim()) manager.setConnectionsSnapshot(text); busyMsg = text.trim() ? "" : "Ultron could not read your connections."; } catch (err) { busyMsg = err instanceof Error ? err.message : "Check failed."; } paint(manager.getState()); } }),
        el("button", { class: "ghost", type: "button", text: "Change key", onclick: () => { showKeyField = true; paint(manager.getState()); } }),
        el("button", { class: "ghost danger", type: "button", text: "Disconnect", onclick: async () => { await manager.removeKey(); showKeyField = false; paint(manager.getState()); } })));
      const chips = s.connections ? parseConnectionChips(s.connections.text) : [];
      if (chips.length) root.append(el("div", { class: "pb-chips", "aria-label": "Connected apps", style: "display:flex;flex-wrap:wrap;gap:6px" }, ...chips.map((c) => { const chip = el("span", { class: "model-library-badge", text: `${c.name} · ${c.status}` }); return chip; })));
      if (s.connections) root.append(el("details", {}, el("summary", { text: `Connections as of ${ago(s.connections.at)}` }), el("pre", { class: "native-model-status", style: "white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto;font-size:11px", text: s.connections.text.slice(0, 2500) })));
      else root.append(el("small", { text: "Tap “Check apps with Ultron” to list which apps are connected right now." }));
      if (s.groups.length) root.append(el("details", {}, el("summary", { text: `Tools Ultron can use (${s.tools.length})` }), el("small", { text: s.groups.map((g) => `${g.label} ${g.count}`).join(" · ") })));
    }
    if (busyMsg) root.append(el("p", { class: "native-model-status", role: "status", text: busyMsg }));
    const toggle = (label: string, hint: string, checked: boolean, on: (v: boolean) => void): HTMLElement => el("label", { class: "field" }, el("span", { class: "toggle-label" }, el("input", { type: "checkbox", checked, onchange: (e: Event) => on((e.target as HTMLInputElement).checked) }) as unknown as Node, " " + label), el("small", { text: hint }));
    root.append(
      toggle("Let Ultron use my connected apps in chat", "When your message is about email, calendar, files, tasks or another connected app, Ultron looks up and uses the right tool.", settings.enabled, (v) => manager.updateSettings({ enabled: v })),
      toggle("Ask before actions that change things", "Reading is automatic. Sending, posting, creating or deleting always asks first unless you tap “Always allow this”.", settings.askBefore, (v) => manager.updateSettings({ askBefore: v })),
      toggle("Web search and links in chat", "Ultron reads links you paste and searches the web when a question needs current information, and lists its sources.", settings.webInChat, (v) => manager.updateSettings({ webInChat: v })),
    );
    if (settings.allowedTools.length) root.append(el("div", { class: "sheet-actions" }, el("button", { class: "ghost", type: "button", text: `Reset ${settings.allowedTools.length} always-allowed action${settings.allowedTools.length === 1 ? "" : "s"}`, onclick: () => { manager.updateSettings({ allowedTools: [] }); paint(manager.getState()); } })));
  };
  manager.subscribe((s) => paint(s));
  paint(manager.getState());

  // AI Digital Products entry, so the tab can be opened from Settings as well as the menu.
  const products = document.getElementById("products-settings");
  if (products) {
    products.replaceChildren(
      el("span", { text: "AI Digital Products" }),
      el("small", { text: "Turn an idea into a finished eBook with research, outline, writing, branding and PDF or EPUB export. Everything saves on this device." }),
      el("div", { class: "sheet-actions" }, el("button", { class: "solid", type: "button", text: "Open AI Digital Products", onclick: host.openProducts })),
    );
  }
}
