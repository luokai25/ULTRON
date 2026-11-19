/** Pure save logic for device-files.ts, with every platform dependency injected so it can be tested. */

export type DownloadsPlugin = {
  begin(options: { name: string; mimeType: string }): Promise<{ id: string }>;
  append(options: { id: string; data: string }): Promise<void>;
  finish(options: { id: string }): Promise<{ name: string; bytes: number; location: string }>;
  abort(options: { id: string }): Promise<void>;
};

export type SaveOutcome = { ok: boolean; where: "downloads" | "browser" | "share" | "declined" | "error"; message: string; name?: string };
export type Consent = "allowed" | "denied" | "";

export const CHUNK = 768 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export type SaveDeps = {
  isAndroid: boolean;
  getConsent: () => Consent;
  setConsent: (v: Consent) => void;
  ask: () => Promise<boolean>;
  plugin: () => DownloadsPlugin;
  browserDownload: (blob: Blob, filename: string) => Promise<SaveOutcome>;
};

export async function saveWith(deps: SaveDeps, blob: Blob, filename: string): Promise<SaveOutcome> {
  const name = filename.trim() || "ultron-file";
  if (!deps.isAndroid) return deps.browserDownload(blob, name);
  let consent = deps.getConsent();
  if (consent === "") { consent = (await deps.ask()) ? "allowed" : "denied"; deps.setConsent(consent); }
  if (consent === "denied") {
    const r = await deps.browserDownload(blob, name);
    return r.ok ? { ...r, message: r.message + " (Turn on \u201cSave downloads to this phone\u2019s Downloads folder\u201d in Settings to save to Downloads.)" } : r;
  }
  const native = deps.plugin();
  let id = "";
  try {
    id = (await native.begin({ name, mimeType: blob.type || "application/octet-stream" })).id;
    for (let offset = 0; offset < blob.size; offset += CHUNK) await native.append({ id, data: toBase64(new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer())) });
    const done = await native.finish({ id });
    return { ok: true, where: "downloads", message: `Saved to Downloads: ${done.name}`, name: done.name };
  } catch (error) {
    if (id) await native.abort({ id }).catch(() => undefined);
    const text = error instanceof Error ? error.message : "";
    const denied = /permission/i.test(text);
    if (denied) deps.setConsent("denied");
    const fallback = await deps.browserDownload(blob, name);
    return { ...fallback, message: `${denied ? "Android did not allow saving to Downloads." : "Could not save to Downloads."} ${fallback.message}` };
  }
}
