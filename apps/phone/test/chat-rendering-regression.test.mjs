import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pathModule from "node:path";

const root = pathModule.resolve(pathModule.dirname(fileURLToPath(import.meta.url)), "..");
const main = await readFile(pathModule.join(root, "src/main.ts"), "utf8");
const html = await readFile(pathModule.join(root, "index.html"), "utf8");

test("cloud chat visibly reports connection attempts before a response arrives", () => {
  assert.match(main, /type LinkState = "offline" \| "connecting" \| "online" \| "error"/);
  assert.match(main, /setLink\("connecting", "Connecting to ULTRON/);
});

test("every completed model turn has visible output even when a provider returns an empty string", () => {
  assert.match(main, /else if \(!result\.content \|\| !result\.content\.trim\(\)\) result = \{ \.\.\.result, content:/);
  assert.match(main, /reply\.body\.replaceChildren\(\)/);
  assert.match(main, /typewriter\(reply\.body, result\.content/);
  assert.match(main, /renderStreamedReply\(reply\.body, streamedText\)/);
});

test("identity screen always has explicit back and Escape exits to chat", () => {
  assert.match(html, /id="agent-identities-screen"/);
  assert.match(html, /id="identity-back"/);
  assert.match(main, /function leaveIdentityScreen\(\)/);
  assert.match(main, /identityBackButton\.addEventListener\("click"/);
  assert.match(main, /app\.dataset\.page === "agent-identities"\) leaveIdentityScreen\(\)/);
  assert.match(main, /app\.dataset\.page = "chat"/);
});
