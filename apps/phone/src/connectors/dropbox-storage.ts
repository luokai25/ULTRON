import { deepFind, executionResults, str, type Json } from "./composio-json";
import { parseDiscovery } from "./tool-discovery";

/**
 * Dropbox as Ultron's own storage, reached through the owner's Composio connection (no extra sign-in, no keys in the app).
 *
 *   /Ultron/Music  /Videos  /Images  /Documents  /Files      the folders Ultron keeps things in
 *
 * What it gives the app:
 *   - tempLink(path): an expiring direct link (about four hours) that plays in an <audio>/<video> box and downloads to the phone;
 *   - list / search: find what is stored;
 *   - saveUrl(url): Dropbox fetches a public link itself (the way generated images and videos are saved: no phone bandwidth);
 *   - uploadBytes(bytes): files that exist only on the phone go up through Composio's workbench, for files up to a few MB.
 * Saving a file changes the owner's Dropbox, so anything the model starts goes through the normal approval; the Save button the
 * owner taps is their own approval.
 */

export const ULTRON_HOME = "/Ultron";
export type FileKind = "audio" | "video" | "image" | "document" | "other";
export const HOME_FOLDERS: Record<FileKind, string> = { audio: "Music", video: "Videos", image: "Images", document: "Documents", other: "Files" };

const TYPES: Record<string, [FileKind, string]> = {
  mp3: ["audio", "audio/mpeg"], m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"], wav: ["audio", "audio/wav"], flac: ["audio", "audio/flac"], ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"], opus: ["audio", "audio/ogg"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"], mov: ["video", "video/quicktime"], "3gp": ["video", "video/3gpp"],
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], gif: ["image", "image/gif"], webp: ["image", "image/webp"],
  pdf: ["document", "application/pdf"], txt: ["document", "text/plain"], md: ["document", "text/markdown"], epub: ["document", "application/epub+zip"], docx: ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], csv: ["document", "text/csv"], json: ["document", "application/json"],
};

export const extOf = (name: string): string => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim()); return m ? (m[1] as string).toLowerCase() : ""; };
export const kindOfName = (name: string): FileKind => TYPES[extOf(name)]?.[0] ?? "other";
export const mimeOfName = (name: string): string => TYPES[extOf(name)]?.[1] ?? "application/octet-stream";

/** A name that is safe as a Dropbox file name: no folders, quotes or control characters, never empty, extension kept. */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f<>:"|?*'`\\]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!base) return "file";
  if (base.length <= 120) return base;
  const ext = extOf(base); return base.slice(0, 120 - (ext ? ext.length + 1 : 0)).trimEnd() + (ext ? `.${ext}` : "");
}

/** Where a new file belongs: /Ultron/<Music|Videos|Images|Documents|Files>/<name>. */
export function homePath(name: string, kind: FileKind = kindOfName(name)): string { return `${ULTRON_HOME}/${HOME_FOLDERS[kind]}/${safeFileName(name)}`; }

export function normalizePath(p: string): string { const t = p.trim().replace(/\/+/g, "/").replace(/\/$/, ""); return t ? (t.startsWith("/") || t.startsWith("id:") ? t : `/${t}`) : ""; }

export const isUnderHome = (p: string): boolean => { const n = normalizePath(p).toLowerCase(); return n === ULTRON_HOME.toLowerCase() || n.startsWith(`${ULTRON_HOME.toLowerCase()}/`); };

/* ---------- media cards from tool results ---------- */

export type DropboxMedia = { id: string; kind: "audio" | "video" | "image"; title: string; mime: string; remote: { provider: "dropbox"; path: string; size?: number } };

const titleOf = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ").trim() || name;

/**
 * Turns the results of DROPBOX_GET_TEMPORARY_LINK into playable media. Only the path is kept: the link itself expires, so the
 * chat asks for a fresh one every time the card is shown.
 */
export function mediaFromResults(results: ReadonlyArray<{ slug: string; data: unknown }>): DropboxMedia[] {
  const out: DropboxMedia[] = []; const seen = new Set<string>();
  for (const r of results) {
    if (r.slug !== "DROPBOX_GET_TEMPORARY_LINK" || !r.data || typeof r.data !== "object") continue;
    const d = r.data as Json; const meta = (d.metadata && typeof d.metadata === "object" ? d.metadata : {}) as Json;
    const name = str(meta.name); const path = str(meta.path_display ?? meta.path_lower);
    const kind = kindOfName(name || path);
    if (!path || (kind !== "audio" && kind !== "video" && kind !== "image")) continue;
    if (seen.has(path.toLowerCase())) continue; seen.add(path.toLowerCase());
    out.push({ id: `dropbox:${str(meta.id) || path}`, kind, title: titleOf(name || path.split("/").pop() || "file"), mime: mimeOfName(name || path), remote: { provider: "dropbox", path, ...(typeof meta.size === "number" ? { size: meta.size } : {}) } });
  }
  return out;
}

/* ---------- client ---------- */

export type CallJson = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; json: Json | null; text: string }>;
export type Entry = { name: string; path: string; type: "file" | "folder"; kind: FileKind; size?: number; modified?: string };
export class StorageError extends Error { constructor(message: string) { super(message); this.name = "StorageError"; } }

/** The most a single phone-to-Dropbox upload carries; bigger files should be saved from a link instead. */
export const MAX_UPLOAD_BYTES = 3_500_000;
const UPLOAD_MARKER = "ULTRON_UPLOAD_RESULT:";

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The Python run in Composio's workbench: stage the bytes, then upload them with the owner's Dropbox connection. */
export function buildUploadCode(p: { path: string; name: string; mime: string; b64: string }): string {
  const payload = JSON.stringify({ path: p.path, name: p.name, mime: p.mime, b64: p.b64 });
  return [
    "import base64, json",
    `payload = json.loads(r'''${payload}''')`,
    'local = "/tmp/ultron_upload.bin"',
    'open(local, "wb").write(base64.b64decode(payload["b64"]))',
    "staged, err = upload_local_file(local)",
    'out = {"staged_ok": bool(staged and staged.get("s3key")), "stage_err": err}',
    'if out["staged_ok"]:',
    '    res, err2 = run_composio_tool("DROPBOX_UPLOAD_FILE", {"path": payload["path"], "mode": "overwrite", "content": {"name": payload["name"], "mimetype": payload["mime"], "s3key": staged["s3key"]}})',
    '    out["upload_err"] = err2',
    '    out["upload_res"] = res',
    `print("${UPLOAD_MARKER}" + json.dumps(out)[:2000])`,
  ].join("\n");
}

export function parseUploadOutput(stdout: string): { ok: boolean; path?: string; size?: number; error?: string } {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith(UPLOAD_MARKER));
  if (!line) return { ok: false, error: "The upload did not report back." };
  try {
    const o = JSON.parse(line.slice(UPLOAD_MARKER.length)) as Json;
    if (!o.staged_ok) return { ok: false, error: str(o.stage_err) || "The file could not be staged for upload." };
    if (o.upload_err) return { ok: false, error: str(o.upload_err).slice(0, 200) };
    const res = (o.upload_res && typeof o.upload_res === "object" ? o.upload_res : {}) as Json;
    const data = (res.data && typeof res.data === "object" ? res.data : {}) as Json;
    const path = str(data.path_display);
    if (!path) return { ok: false, error: str(res.error) || "Dropbox did not confirm the upload." };
    return { ok: true, path, ...(typeof data.size === "number" ? { size: data.size } : {}) };
  } catch { return { ok: false, error: "The upload result could not be read." }; }
}

const entryOf = (e: Json, nameKey = "name"): Entry | null => {
  const name = str(e[nameKey]); const path = str(e.path_display ?? e.path_lower);
  if (!name || !path) return null;
  const folder = e[".tag"] === "folder";
  return { name, path, type: folder ? "folder" : "file", kind: folder ? "other" : kindOfName(name), ...(typeof e.size === "number" ? { size: e.size } : {}), ...(str(e.server_modified) ? { modified: str(e.server_modified) } : {}) };
};

export class DropboxStorage {
  private sid = "";
  private home = false;
  constructor(private readonly call: CallJson) {}

  /** Meta tools need a session; one cheap search provides it. */
  private async session(): Promise<string> {
    if (this.sid) return this.sid;
    const res = await this.call("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "manage files in Dropbox", known_fields: "" }], session: { generate_id: true } });
    this.sid = parseDiscovery(res.json).sessionId;
    return this.sid;
  }

  private async run(slug: string, args: Record<string, unknown>, thought: string): Promise<{ ok: boolean; data: Json; error: string }> {
    const sid = await this.session();
    const res = await this.call("COMPOSIO_MULTI_EXECUTE_TOOL", { sync_response_to_workbench: false, thought, tools: [{ tool_slug: slug, arguments: args }], ...(sid ? { session_id: sid } : {}) });
    const first = executionResults(res.json)[0];
    if (!first) return { ok: false, data: {}, error: res.text.slice(0, 200) || "No answer from Dropbox." };
    return { ok: first.ok, data: (first.data && typeof first.data === "object" ? first.data : {}) as Json, error: first.error };
  }

  /** Makes sure /Ultron and its folders exist. A folder that already exists is fine. */
  async ensureHome(): Promise<void> {
    if (this.home) return;
    for (const path of [ULTRON_HOME, ...Object.values(HOME_FOLDERS).map((f) => `${ULTRON_HOME}/${f}`)]) {
      const r = await this.run("DROPBOX_CREATE_FOLDER", { path, autorename: false }, "Prepare Ultron's Dropbox folders");
      if (!r.ok && !/path\/conflict|path_conflict|"conflict"/i.test(r.error)) throw new StorageError(`Could not prepare ${path} in Dropbox: ${r.error.slice(0, 160)}`);
    }
    this.home = true;
  }

  /** A fresh expiring link for playing or downloading. Links last about four hours, so ask again rather than store one. */
  async tempLink(path: string): Promise<{ url: string; name: string; size?: number; path: string }> {
    const r = await this.run("DROPBOX_GET_TEMPORARY_LINK", { path: normalizePath(path) }, "Get a link to play or download a file");
    const url = str(r.data.link);
    if (!r.ok || !/^https:\/\//i.test(url)) throw new StorageError(/not_found/.test(r.error) ? `I could not find ${path} in Dropbox.` : `Dropbox would not give a link for ${path}.`);
    const meta = (r.data.metadata && typeof r.data.metadata === "object" ? r.data.metadata : {}) as Json;
    return { url, name: str(meta.name) || path.split("/").pop() || "file", path: str(meta.path_display) || path, ...(typeof meta.size === "number" ? { size: meta.size } : {}) };
  }

  async list(path: string = ULTRON_HOME, limit = 100): Promise<Entry[]> {
    const r = await this.run("DROPBOX_LIST_FILES_IN_FOLDER", { path: normalizePath(path), limit: Math.min(Math.max(1, limit), 2000), recursive: false }, "List files in Dropbox");
    if (!r.ok) throw new StorageError(/not_found/.test(r.error) ? `There is no folder ${path} in Dropbox.` : `Could not list ${path}: ${r.error.slice(0, 120)}`);
    return (Array.isArray(r.data.entries) ? (r.data.entries as Json[]) : []).map((e) => entryOf(e)).filter((e): e is Entry => Boolean(e));
  }

  async search(query: string, opts: { path?: string; categories?: Array<"audio" | "video" | "image" | "document" | "pdf" | "folder"> } = {}): Promise<Entry[]> {
    const options: Record<string, unknown> = { max_results: 25, ...(opts.path ? { path: normalizePath(opts.path) } : {}), ...(opts.categories?.length ? { file_categories: opts.categories } : {}) };
    const r = await this.run("DROPBOX_SEARCH_FILE_OR_FOLDER", { query: query.trim(), options }, "Search Dropbox");
    if (!r.ok) throw new StorageError(`Dropbox search failed: ${r.error.slice(0, 120)}`);
    const matches = (Array.isArray(r.data.matches) ? (r.data.matches as Json[]) : []);
    return matches.map((m) => { const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : m) as Json; const inner = (meta.metadata && typeof meta.metadata === "object" ? meta.metadata : meta) as Json; return entryOf(inner); }).filter((e): e is Entry => Boolean(e));
  }

  /** Dropbox fetches a public link itself and stores it under /Ultron. */
  async saveUrl(url: string, name: string, kind: FileKind = kindOfName(name)): Promise<{ path: string }> {
    if (!/^https:\/\//i.test(url)) throw new StorageError("Only https links can be saved to Dropbox.");
    await this.ensureHome();
    const path = homePath(name, kind);
    const r = await this.run("DROPBOX_SAVE_URL", { path, url, wait: true, timeout_seconds: 90 }, "Save a link to Dropbox");
    if (!r.ok || str(r.data.status).toLowerCase() === "failed") throw new StorageError(`Dropbox could not save that link: ${(r.error || str(r.data.error) || "the link may not be public").slice(0, 140)}`);
    return { path };
  }

  /** Files that exist only on the phone. Goes through Composio's workbench, so it is limited to a few MB. */
  async uploadBytes(bytes: Uint8Array, name: string, mime: string = mimeOfName(name)): Promise<{ path: string; size?: number }> {
    if (!bytes.length) throw new StorageError("That file is empty.");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new StorageError(`That file is ${(bytes.length / 1e6).toFixed(1)} MB, more than the ${(MAX_UPLOAD_BYTES / 1e6).toFixed(1)} MB a phone upload can carry. Save it from a link instead.`);
    await this.ensureHome();
    const path = homePath(name);
    const sid = await this.session();
    const res = await this.call("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: buildUploadCode({ path, name: safeFileName(name), mime, b64: bytesToBase64(bytes) }), current_step: "UPLOAD_TO_DROPBOX", thought: "Save a file to the owner's Dropbox", ...(sid ? { session_id: sid } : {}) });
    const stdout = str(deepFind(res.json, "stdout")) || res.text;
    const done = parseUploadOutput(stdout);
    if (!done.ok) throw new StorageError(`Dropbox upload failed: ${done.error}`);
    return { path: done.path as string, ...(done.size !== undefined ? { size: done.size } : {}) };
  }
}
