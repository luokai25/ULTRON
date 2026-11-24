import { str, type Json } from "./composio-json";

/**
 * Schemas in, repaired arguments out. A small model often sends "5" for a number, a bare string for a list, "True" for a boolean,
 * a made-up field, or an enum value in the wrong case. Every one of those is a failed action that a few lines of code can prevent,
 * so the code fixes what is unambiguous and only reports what it cannot fix.
 */

export type ParamInfo = { name: string; type: string; desc: string; enumValues?: unknown[]; itemType?: string; min?: number; max?: number };
export type ToolInfo = { slug: string; toolkit: string; description: string; deprecated: boolean; required: string[]; params: ParamInfo[]; hasSchema: boolean };

const sentence = (s: string, n = 170): string => { const t = s.replace(/\s+/g, " ").trim(); const first = t.split(/(?<=\.)\s/)[0] ?? t; return first.length > n ? first.slice(0, n - 1) + "…" : first; };

/** Composio sometimes returns a stub (`hasFullSchema: false` plus a `schemaRef`) instead of the real input schema. */
export function isSchemaStub(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as Json;
  if (s.hasFullSchema === false || "schemaRef" in s) return true;
  const input = (s.input_schema ?? s.inputSchema ?? s.parameters ?? (s.properties ? s : undefined)) as Json | undefined;
  return !input || typeof input !== "object";
}

function typeOf(p: Json | undefined): string {
  if (!p) return "any";
  if (typeof p.type === "string") return p.type;
  if (Array.isArray(p.type)) return String(p.type.find((t) => t !== "null") ?? "any");
  if (Array.isArray(p.enum)) return "enum";
  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = p[key];
    if (Array.isArray(alts)) { const first = alts.map((a) => (a && typeof a === "object" ? typeOf(a as Json) : "any")).find((t) => t !== "null" && t !== "any"); if (first) return first; }
  }
  return "any";
}

export function toolInfoFromSchema(slug: string, schema: unknown, description = ""): ToolInfo {
  const s = (schema && typeof schema === "object" ? schema : {}) as Json;
  const stub = isSchemaStub(schema);
  const input = ((s.input_schema ?? s.inputSchema ?? s.parameters ?? s) as Json) ?? {};
  const props = (input.properties && typeof input.properties === "object" ? input.properties : {}) as Record<string, Json>;
  const required = Array.isArray(input.required) ? (input.required as unknown[]).map(String) : [];
  const text = description || str(s.description) || str(s.human_description);
  const params: ParamInfo[] = Object.entries(props).map(([name, p]) => {
    const items = (p?.items && typeof p.items === "object" ? p.items : undefined) as Json | undefined;
    return {
      name, type: typeOf(p), desc: sentence(str(p?.description), 110),
      ...(Array.isArray(p?.enum) ? { enumValues: p.enum as unknown[] } : {}),
      ...(items ? { itemType: typeOf(items) } : {}),
      ...(typeof p?.minimum === "number" ? { min: p.minimum } : {}), ...(typeof p?.maximum === "number" ? { max: p.maximum } : {}),
    };
  });
  return { slug, toolkit: str(s.toolkit).toLowerCase(), description: sentence(text), deprecated: /^\s*deprecated\b/i.test(text), required, params, hasSchema: !stub && params.length > 0 };
}

/** One prompt line per tool. Required arguments come first so a long schema can never push them out of view. */
export function toolLine(t: ToolInfo, maxParams = 14): string {
  const shown = [...t.params.filter((p) => t.required.includes(p.name)), ...t.params.filter((p) => !t.required.includes(p.name))].slice(0, maxParams);
  const fmt = (p: ParamInfo): string => `${p.name}${t.required.includes(p.name) ? "*" : ""}:${p.type}${p.enumValues ? `[${p.enumValues.slice(0, 8).map(String).join("|")}]` : ""}${p.desc ? ` (${p.desc})` : ""}`;
  // Keep the schema's own order among equals so the line reads the way the tool documents it.
  const ordered = t.params.filter((p) => shown.includes(p));
  return `- ${t.slug}: ${t.description}${t.deprecated ? " [deprecated: prefer a newer tool]" : ""}\n  args: ${ordered.map(fmt).join("; ") || "none"}`;
}

export function missingRequired(t: ToolInfo | undefined, args: Record<string, unknown>): string[] {
  return (t?.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
}

const TRUE = new Set(["true", "yes", "y", "1", "on"]); const FALSE = new Set(["false", "no", "n", "0", "off"]);

function coerce(value: unknown, type: string, p: ParamInfo): { value: unknown; changed: boolean; problem?: string } {
  const same = { value, changed: false };
  switch (type) {
    case "integer": case "number": {
      let n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim().replace(/,/g, "")) : NaN;
      if (!Number.isFinite(n)) return { value, changed: false, problem: `${p.name} must be a number` };
      if (type === "integer") n = Math.round(n);
      if (p.min !== undefined && n < p.min) n = p.min;
      if (p.max !== undefined && n > p.max) n = p.max;
      return { value: n, changed: n !== value };
    }
    case "boolean": {
      if (typeof value === "boolean") return same;
      const k = String(value).trim().toLowerCase();
      if (TRUE.has(k)) return { value: true, changed: true }; if (FALSE.has(k)) return { value: false, changed: true };
      return { value, changed: false, problem: `${p.name} must be true or false` };
    }
    case "string": {
      if (typeof value === "string") return same;
      if (typeof value === "number" || typeof value === "boolean") return { value: String(value), changed: true };
      return { value, changed: false, problem: `${p.name} must be text` };
    }
    case "array": {
      let list: unknown[];
      if (Array.isArray(value)) list = value;
      else if (typeof value === "string" && value.trim().startsWith("[")) { try { const j = JSON.parse(value); list = Array.isArray(j) ? j : [value]; } catch { list = [value]; } }
      else if (typeof value === "string" && (p.itemType === "string" || !p.itemType)) list = value.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
      else if (value === undefined || value === null) return same;
      else list = [value];
      if (p.itemType === "integer" || p.itemType === "number") { const nums = list.map((x) => Number(x)); if (nums.every(Number.isFinite)) list = nums; }
      if (p.itemType === "string") list = list.map((x) => (typeof x === "number" || typeof x === "boolean" ? String(x) : x));
      return { value: list, changed: JSON.stringify(list) !== JSON.stringify(value) };
    }
    case "object": {
      if (value && typeof value === "object" && !Array.isArray(value)) return same;
      if (typeof value === "string" && value.trim().startsWith("{")) { try { return { value: JSON.parse(value), changed: true }; } catch { /* fall through */ } }
      return { value, changed: false, problem: `${p.name} must be an object` };
    }
    default: return same;
  }
}

export type Normalized = { args: Record<string, unknown>; fixes: string[]; problems: string[] };

/**
 * Repairs what is unambiguous: wrong types, list shapes, enum case, numbers outside min/max, empty optionals and fields the
 * tool does not have. What it cannot repair is returned as `problems` for the model to fix with the schema in front of it.
 * A tool whose schema is unknown is left alone, apart from dropping empty values.
 */
export function normalizeArgs(info: ToolInfo | undefined, raw: Record<string, unknown>): Normalized {
  const fixes: string[] = []; const problems: string[] = []; const out: Record<string, unknown> = {};
  const byName = new Map((info?.params ?? []).map((p) => [p.name, p]));
  const required = new Set(info?.required ?? []);
  const known = Boolean(info?.hasSchema);
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null || (value === "" && !required.has(key))) continue;
    const p = byName.get(key);
    if (!p) { if (known) fixes.push(`left out "${key}" (not an argument of ${info?.slug})`); else out[key] = value; continue; }
    let v: unknown = value;
    const c = coerce(v, p.type, p);
    if (c.problem) { problems.push(c.problem); out[key] = value; continue; }
    if (c.changed) { fixes.push(`${key}: ${typeof value} → ${p.type}`); v = c.value; }
    if (p.enumValues?.length) {
      const hit = p.enumValues.find((e) => e === v || String(e).toLowerCase() === String(v).trim().toLowerCase());
      if (hit === undefined) { problems.push(`${key} must be one of ${p.enumValues.slice(0, 8).map(String).join(", ")}`); } else if (hit !== v) { v = hit; fixes.push(`${key}: matched allowed value "${String(hit)}"`); }
    }
    out[key] = v;
  }
  return { args: out, fixes, problems };
}
