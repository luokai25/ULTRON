import { readFileSync } from "node:fs";
import ts from "typescript";
import { posix } from "node:path";

/**
 * Loads a TypeScript module from ../src for tests: transpiles it and, recursively, every relative module it imports,
 * wiring them together with data: URLs. `stubs` replaces a relative import (by its specifier) with given JS source.
 */
const cache = new Map();
const toUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

function build(name, stubs) {
  const key = name + "|" + Object.keys(stubs).join(",");
  if (cache.has(key)) return cache.get(key);
  const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  js = js.replace(/from\s+"(\.\/[^"]+)"/g, (_all, spec) => {
    if (spec in stubs) return `from "${toUrl(stubs[spec])}"`;
    // Resolve relative to the importing file so modules in subfolders (src/products) can import their siblings.
    const file = posix.normalize(posix.join(posix.dirname(name), spec)) + (spec.endsWith(".mjs") ? "" : ".ts");
    return `from "${build(file, stubs)}"`;
  });
  const url = toUrl(js);
  cache.set(key, url);
  return url;
}

export const loadSource = (name, stubs = {}) => import(build(name, stubs));
