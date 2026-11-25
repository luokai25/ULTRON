import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./_ts-loader.mjs";

const n = await loadSource("media-names.ts");

test("a stored song keeps its real extension, anything else is chosen from its type", () => {
  assert.equal(n.extForMedia({ kind: "audio", title: "x", mime: "audio/mpeg", remote: { path: "/Ultron/Music/a.FLAC" } }), "flac");
  assert.equal(n.extForMedia({ kind: "audio", title: "x", mime: "audio/mp4" }), "m4a");
  assert.equal(n.extForMedia({ kind: "image", title: "x", mime: "image/jpeg" }), "jpg");
  assert.equal(n.extForMedia({ kind: "video", title: "x", mime: "video/webm; codecs=vp9" }), "webm");
  assert.equal(n.extForMedia({ kind: "audio", title: "x", mime: "weird/type" }), "mp3"); assert.equal(n.extForMedia({ kind: "video", title: "x", mime: "" }), "mp4");
});

test("download names are short, plain and never empty", () => {
  assert.equal(n.downloadName({ kind: "audio", title: "Night Drive", mime: "audio/mpeg", remote: { path: "/Ultron/Music/Night_Drive.mp3" } }), "night-drive.mp3");
  assert.equal(n.downloadName({ kind: "image", title: "Café at 5/6 — “sunset”!", mime: "image/png" }), "cafe-at-5-6-sunset.png");
  assert.equal(n.downloadName({ kind: "video", title: "", mime: "video/mp4" }), "video.mp4");
  assert.equal(n.downloadName({ kind: "image", title: "😀😀", mime: "image/png" }), "image.png");
  assert.ok(n.downloadName({ kind: "image", title: "x".repeat(200), mime: "image/png" }).length <= 44);
});
