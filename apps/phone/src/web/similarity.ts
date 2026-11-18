/** Small, dependency-free text similarity used by adaptive element matching. */

function bigrams(s: string): Map<string, number> {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Map<string, number>();
  if (t.length < 2) { if (t) out.set(t, 1); return out; }
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) ?? 0) + 1); }
  return out;
}

/** Dice coefficient on character bigrams, 0..1. Order-insensitive enough for class lists and short text. */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const ga = bigrams(a); const gb = bigrams(b);
  let overlap = 0; let total = 0;
  for (const [g, n] of ga) { overlap += Math.min(n, gb.get(g) ?? 0); total += n; }
  for (const n of gb.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a); const sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
