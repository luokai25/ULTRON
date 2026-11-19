import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const core = await loadSource("device-save.ts");
const blobOf = (n, type = "application/pdf") => new Blob([new Uint8Array(n).map((_, i) => i % 251)], { type });

function fakePlugin(opts = {}) {
  const calls = []; const written = [];
  return { calls, written, plugin: {
    begin: async (o) => { calls.push(["begin", o]); if (opts.beginError) throw new Error(opts.beginError); return { id: "s1" }; },
    append: async (o) => { calls.push(["append"]); if (opts.failAt && written.length + 1 === opts.failAt) throw new Error("disk full"); written.push(Buffer.from(o.data, "base64")); },
    finish: async () => { calls.push(["finish"]); return { name: opts.finalName ?? "book.pdf", bytes: 1, location: "Downloads/book.pdf" }; },
    abort: async () => { calls.push(["abort"]); },
  } };
}
function deps(over = {}) {
  let consent = over.consent ?? ""; const asked = []; const browser = [];
  const d = { isAndroid: true, getConsent: () => consent, setConsent: (v) => { consent = v; }, ask: async () => { asked.push(1); return over.allow ?? true; }, plugin: () => (over.fp ?? fakePlugin()).plugin,
    browserDownload: async (b, n) => { browser.push(n); return { ok: true, where: "browser", message: `Download started: ${n}`, name: n }; } };
  return { d, asked, browser, consent: () => consent };
}

test("first save asks once, then saves into Downloads and never asks again", async () => {
  const fp = fakePlugin(); const t = deps({ fp });
  const r = await core.saveWith(t.d, blobOf(1000), "My Book.pdf");
  assert.deepEqual([r.ok, r.where, r.message], [true, "downloads", "Saved to Downloads: book.pdf"]);
  assert.equal(t.asked.length, 1); assert.equal(t.consent(), "allowed");
  assert.deepEqual(fp.calls[0], ["begin", { name: "My Book.pdf", mimeType: "application/pdf" }]);
  await core.saveWith(t.d, blobOf(10), "b.pdf");
  assert.equal(t.asked.length, 1, "consent is remembered");
});

test("large files are written in chunks and arrive byte for byte", async () => {
  const fp = fakePlugin(); const t = deps({ fp, consent: "allowed" });
  const size = core.CHUNK * 2 + 12345;
  await core.saveWith(t.d, blobOf(size), "big.bin");
  assert.equal(fp.written.length, 3);
  const all = Buffer.concat(fp.written);
  assert.equal(all.length, size);
  assert.ok(all.every((v, i) => v === i % 251), "no bytes lost or reordered across chunk boundaries");
});

test("saying not now falls back to a normal download and is remembered", async () => {
  const fp = fakePlugin(); const t = deps({ fp, allow: false });
  const r = await core.saveWith(t.d, blobOf(10), "a.pdf");
  assert.equal(r.where, "browser"); assert.match(r.message, /Settings/);
  assert.equal(fp.calls.length, 0, "nothing is written to Downloads without consent");
  assert.equal(t.consent(), "denied");
  await core.saveWith(t.d, blobOf(10), "b.pdf");
  assert.equal(t.asked.length, 1);
});

test("a write failure cleans up the partial file and still delivers the file another way", async () => {
  const fp = fakePlugin({ failAt: 2 }); const t = deps({ fp, consent: "allowed" });
  const r = await core.saveWith(t.d, blobOf(core.CHUNK * 3), "x.pdf");
  assert.ok(fp.calls.some((c) => c[0] === "abort"));
  assert.ok(!fp.calls.some((c) => c[0] === "finish"));
  assert.equal(r.where, "browser"); assert.match(r.message, /Could not save to Downloads/);
  assert.deepEqual(t.browser, ["x.pdf"]);
});

test("a refused Android permission turns the setting off instead of nagging", async () => {
  const fp = fakePlugin({ beginError: "Storage permission was not granted." }); const t = deps({ fp, consent: "allowed" });
  const r = await core.saveWith(t.d, blobOf(10), "x.pdf");
  assert.match(r.message, /did not allow/); assert.equal(t.consent(), "denied");
});

test("on a desktop browser it simply downloads, without asking", async () => {
  const t = deps(); t.d.isAndroid = false;
  const r = await core.saveWith(t.d, blobOf(10), "x.pdf");
  assert.equal(r.where, "browser"); assert.equal(t.asked.length, 0);
  assert.equal((await core.saveWith({ ...t.d, isAndroid: true, getConsent: () => "allowed", plugin: () => fakePlugin().plugin }, blobOf(5), "  ")).name, "book.pdf");
});
