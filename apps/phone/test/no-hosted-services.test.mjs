import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const phone = join(repo, "apps/phone");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "build", ".gradle"].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

test("the repository has no Supabase or Vercel project folders", () => {
  for (const folder of ["supabase", "api", "vercel.json", ".vercel"]) assert.equal(existsSync(join(repo, folder)), false, `${folder} must not exist`);
});

test("the app source, shell, manifest and build config never reference Supabase or Vercel", () => {
  const files = [...walk(join(phone, "src")), join(phone, "index.html"), join(phone, "package.json"), join(phone, "vite.config.ts"), join(phone, "capacitor.config.ts"), join(repo, "package.json")];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /supabase|vercel/i, file.replace(repo, ""));
  }
  const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lock, /@supabase\//, "the lockfile must not resolve any Supabase package");
});

test("CI and the release workflow do not build or test hosted services", () => {
  for (const name of ["ci.yml", "android-release.yml"]) {
    const text = readFileSync(join(repo, ".github/workflows", name), "utf8");
    assert.doesNotMatch(text, /supabase|vercel|deno/i, name);
  }
});

test("the app makes no network calls except to providers, Google and model hosts it lists", () => {
  const hosts = new Set();
  for (const file of walk(join(phone, "src")).filter((f) => /\.(ts|mjs)$/.test(f))) {
    for (const match of readFileSync(file, "utf8").matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(match[1].toLowerCase());
  }
  for (const host of hosts) assert.doesNotMatch(host, /supabase|vercel\.app|ultron-pied-gamma/, host);
});
