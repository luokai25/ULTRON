import { Capacitor, registerPlugin } from "@capacitor/core";
import { saveWith, type Consent, type DownloadsPlugin, type SaveOutcome } from "./device-save";
export type { Consent, SaveOutcome } from "./device-save";

/**
 * One place for putting files on the phone. On Android every explicit download or export goes into the public Downloads folder
 * (Files app → Downloads) through the native UltronDownloads plugin (MediaStore, no storage permission declared). The first time, Ultron asks for the
 * owner's consent. Android 9 and older fall back to the share sheet. Elsewhere (desktop preview) it falls back to a normal
 * browser download. Failure never loses the file: it falls back to the share sheet or a browser download.
 */

const KEY = "ultron.downloads.consent.v1";

export const downloadsConsent = (): Consent => { try { const v = localStorage.getItem(KEY); return v === "allowed" || v === "denied" ? v : ""; } catch { return ""; } };
export const setDownloadsConsent = (v: Consent): void => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export const isNativeAndroid = (): boolean => Capacitor.getPlatform() === "android";

function plugin(): DownloadsPlugin { return registerPlugin<DownloadsPlugin>("UltronDownloads"); }

export function toast(message: string): void {
  const old = document.getElementById("ultron-toast"); old?.remove();
  const node = document.createElement("div");
  node.id = "ultron-toast"; node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); node.textContent = message;
  node.style.cssText = "position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:min(92vw,420px);padding:11px 16px;border-radius:14px;background:#1d242f;color:#f3f6fa;border:1px solid rgba(255,255,255,.14);font:13px/1.45 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:200;text-align:center";
  document.body.append(node);
  setTimeout(() => node.remove(), 4500);
}

/** One-time, plain-language consent before the first save. Resolves true when the owner allows it. */
export function askDownloadsConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div"); wrap.className = "sheet-wrap"; wrap.style.zIndex = "190";
    const sheet = document.createElement("div"); sheet.className = "sheet"; sheet.setAttribute("role", "alertdialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Save files to Downloads");
    const h = document.createElement("h2"); h.textContent = "Save files to your phone?";
    const p = document.createElement("p"); p.className = "native-model-status"; p.textContent = "Allow Ultron to save the files you export (PDF, EPUB, documents and more) into your phone's Downloads folder. You can find them in your Files app, and you can change this later in Settings.";
    const row = document.createElement("div"); row.className = "sheet-actions";
    const done = (v: boolean): void => { wrap.remove(); setDownloadsConsent(v ? "allowed" : "denied"); resolve(v); };
    const allow = document.createElement("button"); allow.type = "button"; allow.className = "solid"; allow.textContent = "Allow"; allow.addEventListener("click", () => done(true));
    const no = document.createElement("button"); no.type = "button"; no.className = "ghost"; no.textContent = "Not now"; no.addEventListener("click", () => done(false));
    row.append(allow, no); sheet.append(h, p, row); wrap.append(sheet); document.body.append(wrap); allow.focus();
  });
}

async function browserDownload(blob: Blob, filename: string): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
  try {
    if (isNativeAndroid() && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) { await navigator.share({ files: [file], title: filename }); return { ok: true, where: "share", message: "Shared. Choose “Save to Files” or Drive to keep it.", name: filename }; }
  } catch (e) { if (e instanceof Error && e.name === "AbortError") return { ok: false, where: "declined", message: "Cancelled." }; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { ok: true, where: "browser", message: `Download started: ${filename}`, name: filename };
}

/** Saves a file to the phone's Downloads folder (Android) or starts a browser download. `ask` replaces the consent dialog in tests. */
export function saveToDevice(blob: Blob, filename: string, ask: () => Promise<boolean> = askDownloadsConsent): Promise<SaveOutcome> {
  return saveWith({ isAndroid: isNativeAndroid(), getConsent: downloadsConsent, setConsent: setDownloadsConsent, ask, plugin, browserDownload }, blob, filename);
}

/** Settings switch for the same consent, so it can be turned back on after “Not now”. */
export function mountDownloadsSettings(root: HTMLElement): void {
  const paint = (): void => {
    root.replaceChildren();
    const title = document.createElement("span"); title.textContent = "Saved files";
    const label = document.createElement("label"); label.className = "field";
    const box = document.createElement("input"); box.type = "checkbox"; box.checked = downloadsConsent() === "allowed";
    box.addEventListener("change", () => { setDownloadsConsent(box.checked ? "allowed" : "denied"); paint(); });
    const text = document.createElement("span"); text.className = "toggle-label"; text.append(box, " Save downloads to this phone's Downloads folder");
    const hint = document.createElement("small"); hint.textContent = isNativeAndroid() ? "Exported PDFs, EPUBs, documents and other files go to Downloads, where your Files app can find them." : "On a phone, exports are saved to the Downloads folder.";
    label.append(text, hint); root.append(title, label);
  };
  paint();
}
