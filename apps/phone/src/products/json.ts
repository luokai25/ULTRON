/** Tolerant JSON extraction for model output (fences, prose around the JSON, trailing commas, smart quotes). */

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

/** Returns the first balanced {...} or [...] slice, respecting strings. */
export function firstBalanced(text: string): string | null {
  let start = -1;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === "{" || c === "[") { start = i; break; } }
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") { inString = true; continue; }
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return null;
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return null;
}

function repair(raw: string): string {
  return raw
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/(^|[^\\])\n(?=[^"]*"\s*[,}\]])/g, "$1 ");
}

export function extractJson<T = unknown>(text: string): T {
  const cleaned = stripFences(text);
  const candidates = [cleaned, firstBalanced(cleaned) ?? "", firstBalanced(text) ?? ""].filter(Boolean);
  let lastError: unknown = new Error("The model did not return JSON.");
  for (const candidate of candidates) {
    for (const attempt of [candidate, repair(candidate)]) {
      try { return JSON.parse(attempt) as T; } catch (error) { lastError = error; }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The model did not return JSON.");
}

export const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : fallback);
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
export const clampScore = (value: unknown, fallback = 6): number => {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n * 2) / 2)) : fallback;
};
