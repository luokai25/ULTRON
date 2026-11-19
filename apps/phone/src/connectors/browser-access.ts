/**
 * One-time permission for Ultron to browse with this phone's browser engine (the Android System WebView, the same engine Chrome
 * is built on). It runs hidden inside the app with its own cookies; it cannot see Chrome's tabs, history, passwords or logins.
 * The answer is remembered, so Ultron uses it every time the app opens until the owner changes it in Settings.
 */
export type BrowserAccess = "allowed" | "denied" | "unset";
const KEY = "ultron.browser.access.v1";

export const browserAccess = (): BrowserAccess => { try { const v = localStorage.getItem(KEY); return v === "allowed" || v === "denied" ? v : "unset"; } catch { return "unset"; } };
export const setBrowserAccess = (v: BrowserAccess): void => { try { if (v === "unset") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };

export function askBrowserAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div"); wrap.className = "sheet-wrap"; wrap.style.zIndex = "190";
    const sheet = document.createElement("div"); sheet.className = "sheet"; sheet.setAttribute("role", "alertdialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Allow browsing");
    const h = document.createElement("h2"); h.textContent = "Let Ultron use this phone's browser?";
    const p = document.createElement("p"); p.className = "native-model-status"; p.textContent = "To search properly, Ultron opens search results and web pages in a hidden browser built into the app, the same engine Chrome uses, so it sees pages the way you do. It cannot see your Chrome tabs, history, passwords or logins. You are asked only once; you can change it in Settings.";
    const row = document.createElement("div"); row.className = "sheet-actions";
    const done = (v: boolean): void => { wrap.remove(); setBrowserAccess(v ? "allowed" : "denied"); resolve(v); };
    const allow = document.createElement("button"); allow.type = "button"; allow.className = "solid"; allow.textContent = "Allow"; allow.addEventListener("click", () => done(true));
    const no = document.createElement("button"); no.type = "button"; no.className = "ghost"; no.textContent = "Not now"; no.addEventListener("click", () => done(false));
    row.append(allow, no); sheet.append(h, p, row); wrap.append(sheet); document.body.append(wrap); allow.focus();
  });
}
