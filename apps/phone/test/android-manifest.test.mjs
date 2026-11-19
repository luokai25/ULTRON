import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Mirrors the "Verify privacy-safe merged Android manifest" step of .github/workflows/android-release.yml, so a forbidden
// permission fails here instead of after a 10 minute release build.
const FORBIDDEN = /android\.permission\.(READ_SMS|RECEIVE_SMS|SEND_SMS|WRITE_SMS|READ_CALL_LOG|WRITE_CALL_LOG|PROCESS_OUTGOING_CALLS|MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA_IMAGES|READ_MEDIA_VIDEO|REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)|BIND_ACCESSIBILITY_SERVICE|AccessibilityService/;

test("the Android manifest declares no restricted or broad storage permissions", () => {
  const manifest = readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.doesNotMatch(manifest, FORBIDDEN);
});

test("native plugins do not use APIs that need those permissions", () => {
  const dir = new URL("../android/app/src/main/java/app/ultron/mobile/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".java"))) {
    assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|getExternalStoragePublicDirectory/, f);
  }
});

test("saving to Downloads goes through MediaStore", () => {
  const src = readFileSync(new URL("../android/app/src/main/java/app/ultron/mobile/UltronDownloadsPlugin.java", import.meta.url), "utf8");
  assert.match(src, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
});
