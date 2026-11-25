import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadSource } from "./_ts-loader.mjs";

const dbx = await loadSource("connectors/dropbox-storage.ts");

// Replies copied from a real Dropbox account through Composio.
const meta = (o) => ({ client_modified: "2026-11-25T05:29:40Z", content_hash: "3b5a", id: "id:-I0_BqHdrGsAAAAAAAAAiQ", is_downloadable: true, name: "README.txt", path_display: "/Ultron/README.txt", path_lower: "/ultron/readme.txt", rev: "01661131", server_modified: "2026-11-25T05:29:41Z", size: 131, ...o });
const wrap = (slug, data, extra = {}) => ({ json: { successful: true, data: { results: [{ response: { successful: true, data, ...extra }, tool_slug: slug, index: 0 }], session: { id: "mind" } } } });
const LIST = wrap("DROPBOX_LIST_FILES_IN_FOLDER", { cursor: "AAbY", has_more: false, entries: [
  { ".tag": "folder", id: "id:a", name: "Music", path_display: "/Ultron/Music", path_lower: "/ultron/music", property_groups: [] },
  { ".tag": "folder", id: "id:b", name: "Videos", path_display: "/Ultron/Videos", path_lower: "/ultron/videos", property_groups: [] },
  { ".tag": "file", ...meta({}) }] });
const SEARCH = wrap("DROPBOX_SEARCH_FILE_OR_FOLDER", { has_more: false, matches: [
  { highlight_spans: [], match_type: { ".tag": "filename_and_content" }, metadata: { ".tag": "file", ...meta({ name: "storage-check.txt", path_display: "/Ultron/Files/storage-check.txt", size: 65 }) } },
  { highlight_spans: [], match_type: { ".tag": "file_content" }, metadata: { ".tag": "file", ...meta({}) } }] });
const TEMP = (name, path, size = 131) => wrap("DROPBOX_GET_TEMPORARY_LINK", { link: "https://uc8a.dl.dropboxusercontent.com/cd/0/get/abc/file?c_luid=b3d6", metadata: meta({ name, path_display: path, size }) });
const CONFLICT = { json: { successful: false, data: { results: [{ response: { successful: false, data: { http_error: "409 Client Error", message: "{}", status_code: 409 }, error: '{"error":{".tag":"path","path":{".tag":"conflict","conflict":{".tag":"folder"}}},"error_summary":"path/conflict/folder/"}' }, error: "x", tool_slug: "DROPBOX_CREATE_FOLDER", index: 0 }] } } };
const UPLOAD_STDOUT = '📋 Files to upload:\n  • ultron_upload.bin (65B)\n✅ File successfully uploaded\n=== Full Data Output ===\n{"data":{}}\nULTRON_UPLOAD_RESULT:{"staged_ok": true, "stage_err": "", "upload_err": "", "upload_res": {"data": {"id": "id:-I0_BqHdrGsAAAAAAAAAig", "name": "storage-check.txt", "path_display": "/Ultron/Files/storage-check.txt", "size": 65}, "error": null}}\n';

function client(handler) { const calls = []; const call = async (name, args) => { calls.push([name, args]); return handler(name, args, calls); }; return { calls, store: new dbx.DropboxStorage(call) }; }
const sessioned = (fn) => async (name, args, calls) => (name === "COMPOSIO_SEARCH_TOOLS" ? { json: { data: { results: [{ primary_tool_slugs: ["DROPBOX_UPLOAD_FILE"] }], session: { id: "sess9" } } } } : fn(name, args, calls));

test("file types, names and the folders Ultron keeps things in", () => {
  assert.equal(dbx.kindOfName("Song.MP3"), "audio"); assert.equal(dbx.kindOfName("clip.mp4"), "video"); assert.equal(dbx.kindOfName("a.jpeg"), "image");
  assert.equal(dbx.kindOfName("book.epub"), "document"); assert.equal(dbx.kindOfName("data.bin"), "other"); assert.equal(dbx.kindOfName("noext"), "other");
  assert.equal(dbx.mimeOfName("x.m4a"), "audio/mp4"); assert.equal(dbx.mimeOfName("x.xyz"), "application/octet-stream");
  assert.equal(dbx.homePath("My Song.mp3"), "/Ultron/Music/My Song.mp3"); assert.equal(dbx.homePath("trip.mp4"), "/Ultron/Videos/trip.mp4");
  assert.equal(dbx.homePath("pic.png"), "/Ultron/Images/pic.png"); assert.equal(dbx.homePath("book.pdf"), "/Ultron/Documents/book.pdf"); assert.equal(dbx.homePath("stuff.zip"), "/Ultron/Files/stuff.zip");
  assert.equal(dbx.homePath("x.bin", "audio"), "/Ultron/Music/x.bin");
});

test("a file name can never escape the folder or break the path", () => {
  assert.equal(dbx.safeFileName("../../etc/passwd"), "passwd"); assert.equal(dbx.safeFileName("C:\\x\\evil.mp3"), "evil.mp3");
  assert.equal(dbx.safeFileName('a"b\'c`d<e>f|g?.txt'), "abcdefg.txt"); assert.equal(dbx.safeFileName("   "), "file"); assert.equal(dbx.safeFileName(".hidden"), "hidden");
  const long = dbx.safeFileName("x".repeat(300) + ".mp3"); assert.ok(long.length <= 120 && long.endsWith(".mp3"));
  assert.equal(dbx.safeFileName("line\nbreak.txt"), "linebreak.txt");
});

test("paths are normalised and Ultron's home is recognised case-insensitively", () => {
  assert.equal(dbx.normalizePath("Ultron//Music/"), "/Ultron/Music"); assert.equal(dbx.normalizePath("id:abc"), "id:abc"); assert.equal(dbx.normalizePath(""), "");
  assert.equal(dbx.isUnderHome("/ultron/music/a.mp3"), true); assert.equal(dbx.isUnderHome("/Ultron"), true); assert.equal(dbx.isUnderHome("/UltronX/a"), false); assert.equal(dbx.isUnderHome("/Other/Ultron"), false);
});

test("a temporary-link result becomes a playable card, and only the path is kept because the link expires", () => {
  const m = dbx.mediaFromResults([{ slug: "DROPBOX_GET_TEMPORARY_LINK", data: { link: "https://x/y", metadata: meta({ name: "Night_Drive.mp3", path_display: "/Ultron/Music/Night_Drive.mp3", size: 4_200_000 }) } }]);
  assert.deepEqual(m, [{ id: "dropbox:id:-I0_BqHdrGsAAAAAAAAAiQ", kind: "audio", title: "Night Drive", mime: "audio/mpeg", remote: { provider: "dropbox", path: "/Ultron/Music/Night_Drive.mp3", size: 4_200_000 } }]);
  assert.ok(!JSON.stringify(m).includes("https://x/y"), "the expiring link is not stored");
  const v = dbx.mediaFromResults([{ slug: "DROPBOX_GET_TEMPORARY_LINK", data: { link: "https://x", metadata: meta({ name: "trip.mp4", path_display: "/Trips/trip.mp4" }) } }]);
  assert.equal(v[0].kind, "video"); assert.equal(v[0].mime, "video/mp4");
  assert.equal(dbx.mediaFromResults([{ slug: "DROPBOX_GET_TEMPORARY_LINK", data: { link: "https://x", metadata: meta({ name: "notes.txt" }) } }]).length, 0, "documents are not played");
  assert.equal(dbx.mediaFromResults([{ slug: "GMAIL_FETCH_EMAILS", data: { link: "https://x", metadata: meta({ name: "a.mp3" }) } }]).length, 0, "only Dropbox links count");
  const twice = dbx.mediaFromResults([1, 2].map(() => ({ slug: "DROPBOX_GET_TEMPORARY_LINK", data: { link: "https://x", metadata: meta({ name: "a.mp3", path_display: "/A/a.mp3" }) } })));
  assert.equal(twice.length, 1, "the same file is shown once");
  assert.deepEqual(dbx.mediaFromResults([{ slug: "DROPBOX_GET_TEMPORARY_LINK", data: null }, { slug: "DROPBOX_GET_TEMPORARY_LINK", data: { link: "x" } }]), []);
});

test("tempLink asks for a fresh expiring link and returns what a player needs", async () => {
  const { store, calls } = client(sessioned(() => TEMP("README.txt", "/Ultron/README.txt")));
  const l = await store.tempLink("Ultron/README.txt");
  assert.equal(l.url.startsWith("https://"), true); assert.equal(l.name, "README.txt"); assert.equal(l.size, 131); assert.equal(l.path, "/Ultron/README.txt");
  const exec = calls.find((c) => c[0] === "COMPOSIO_MULTI_EXECUTE_TOOL")[1];
  assert.deepEqual(exec.tools, [{ tool_slug: "DROPBOX_GET_TEMPORARY_LINK", arguments: { path: "/Ultron/README.txt" } }]); assert.equal(exec.session_id, "sess9");
  await store.tempLink("/x"); assert.equal(calls.filter((c) => c[0] === "COMPOSIO_SEARCH_TOOLS").length, 1, "the session is created once");
});

test("a missing file gives a plain message, not a raw API error", async () => {
  const gone = { json: { data: { results: [{ response: { successful: false, data: {}, error: '{"error_summary":"path/not_found/.."}' }, tool_slug: "DROPBOX_GET_TEMPORARY_LINK" }] } } };
  const { store } = client(sessioned(() => gone));
  await assert.rejects(() => store.tempLink("/Ultron/Music/nope.mp3"), (e) => e.name === "StorageError" && /could not find \/Ultron\/Music\/nope\.mp3/.test(e.message));
});

test("list and search read Dropbox's real reply shapes", async () => {
  const { store, calls } = client(sessioned((name, args) => (args.tools[0].tool_slug === "DROPBOX_LIST_FILES_IN_FOLDER" ? LIST : SEARCH)));
  const items = await store.list();
  assert.deepEqual(items.map((i) => [i.name, i.type, i.kind]), [["Music", "folder", "other"], ["Videos", "folder", "other"], ["README.txt", "file", "document"]]);
  assert.equal(items[2].size, 131); assert.equal(items[2].modified, "2026-11-25T05:29:41Z");
  assert.deepEqual(calls.find((c) => c[0] === "COMPOSIO_MULTI_EXECUTE_TOOL")[1].tools[0].arguments, { path: "/Ultron", limit: 100, recursive: false });
  const found = await store.search("storage", { path: "/Ultron", categories: ["document"] });
  assert.deepEqual(found.map((f) => f.path), ["/Ultron/Files/storage-check.txt", "/Ultron/README.txt"]);
  assert.deepEqual(calls.at(-1)[1].tools[0].arguments, { query: "storage", options: { max_results: 25, path: "/Ultron", file_categories: ["document"] } });
});

test("ensureHome creates the folders, and a folder that already exists is not an error", async () => {
  const { store, calls } = client(sessioned(() => CONFLICT));
  await store.ensureHome(); await store.ensureHome();
  const made = calls.filter((c) => c[0] === "COMPOSIO_MULTI_EXECUTE_TOOL").map((c) => c[1].tools[0].arguments.path);
  assert.deepEqual(made, ["/Ultron", "/Ultron/Music", "/Ultron/Videos", "/Ultron/Images", "/Ultron/Documents", "/Ultron/Files"], "done once");
  const denied = client(sessioned(() => ({ json: { data: { results: [{ response: { successful: false, data: {}, error: "insufficient_permissions" }, tool_slug: "DROPBOX_CREATE_FOLDER" }] } } })));
  await assert.rejects(() => denied.store.ensureHome(), /Could not prepare \/Ultron/);
});

test("saveUrl lets Dropbox fetch a public link into the right folder, and reports a failed save", async () => {
  const { store, calls } = client(sessioned((name, args) => (args.tools[0].tool_slug === "DROPBOX_CREATE_FOLDER" ? CONFLICT : wrap("DROPBOX_SAVE_URL", { status: "complete" }))));
  const r = await store.saveUrl("https://image.pollinations.ai/prompt/x.png", "sunset.png");
  assert.equal(r.path, "/Ultron/Images/sunset.png");
  const save = calls.filter((c) => c[0] === "COMPOSIO_MULTI_EXECUTE_TOOL").map((c) => c[1].tools[0]).find((t) => t.tool_slug === "DROPBOX_SAVE_URL");
  assert.deepEqual(save.arguments, { path: "/Ultron/Images/sunset.png", url: "https://image.pollinations.ai/prompt/x.png", wait: true, timeout_seconds: 90 });
  await assert.rejects(() => store.saveUrl("http://insecure/x.png", "x.png"), /Only https/);
  const bad = client(sessioned((name, args) => (args.tools[0].tool_slug === "DROPBOX_CREATE_FOLDER" ? CONFLICT : wrap("DROPBOX_SAVE_URL", { status: "failed" }))));
  await assert.rejects(() => bad.store.saveUrl("https://x/y.mp3", "y.mp3"), /could not save that link/);
});

test("the upload parser reads the real workbench output and explains failures", () => {
  assert.deepEqual(dbx.parseUploadOutput(UPLOAD_STDOUT), { ok: true, path: "/Ultron/Files/storage-check.txt", size: 65 });
  assert.equal(dbx.parseUploadOutput("nothing here").ok, false);
  assert.match(dbx.parseUploadOutput('ULTRON_UPLOAD_RESULT:{"staged_ok": false, "stage_err": "no space"}').error, /no space/);
  assert.match(dbx.parseUploadOutput('ULTRON_UPLOAD_RESULT:{"staged_ok": true, "upload_err": "HTTP 409 path/conflict"}').error, /409/);
  assert.equal(dbx.parseUploadOutput("ULTRON_UPLOAD_RESULT:{broken").ok, false);
});

test("the upload program is valid Python and carries the bytes, path and type safely", () => {
  const code = dbx.buildUploadCode({ path: "/Ultron/Music/a b.mp3", name: "a b.mp3", mime: "audio/mpeg", b64: dbx.bytesToBase64(new Uint8Array([1, 2, 3, 250])) });
  assert.match(code, /upload_local_file\(local\)/); assert.match(code, /DROPBOX_UPLOAD_FILE/); assert.match(code, /AQID\+g==/);
  const py = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'upload', 'exec')"], { input: code, encoding: "utf8" });
  if (py.error) return; // python3 is not available here
  assert.equal(py.status, 0, py.stderr);
});

test("uploadBytes sends the bytes through the workbench and returns the saved path", async () => {
  const { store, calls } = client(sessioned((name, args) => (name === "COMPOSIO_REMOTE_WORKBENCH" ? { json: { data: { stdout: UPLOAD_STDOUT, stderr: "" } } } : CONFLICT)));
  const r = await store.uploadBytes(new TextEncoder().encode("Ultron storage check"), "storage-check.txt");
  assert.deepEqual(r, { path: "/Ultron/Files/storage-check.txt", size: 65 });
  const wb = calls.find((c) => c[0] === "COMPOSIO_REMOTE_WORKBENCH")[1];
  assert.equal(wb.session_id, "sess9"); assert.match(wb.code_to_execute, new RegExp(Buffer.from("Ultron storage check").toString("base64")));
});

test("uploadBytes refuses an empty or oversized file before touching the network, and reports a failed upload", async () => {
  const { store, calls } = client(sessioned(() => CONFLICT));
  await assert.rejects(() => store.uploadBytes(new Uint8Array(0), "a.txt"), /empty/);
  await assert.rejects(() => store.uploadBytes(new Uint8Array(dbx.MAX_UPLOAD_BYTES + 1), "big.mp4"), /Save it from a link instead/);
  assert.equal(calls.length, 0);
  const failing = client(sessioned((name) => (name === "COMPOSIO_REMOTE_WORKBENCH" ? { json: { data: { stdout: 'ULTRON_UPLOAD_RESULT:{"staged_ok": true, "upload_err": "HTTP 403"}' } } } : CONFLICT)));
  await assert.rejects(() => failing.store.uploadBytes(new Uint8Array([1]), "a.txt"), /Dropbox upload failed: HTTP 403/);
});
