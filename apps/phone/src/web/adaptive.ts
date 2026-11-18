import { jaccard, ratio } from "./similarity";

/**
 * Adaptive element tracking, the idea behind Scrapling's `adaptive=True`: remember what an element looked like, and when a
 * selector stops matching after a site redesign, find the element that now looks most like it. Pure data in, pure data out.
 */

export type Fingerprint = {
  tag: string;
  text: string;
  attrs: Record<string, string>;
  classes: string[];
  path: string[];
  parentTag: string;
  parentClasses: string[];
  prevTag: string;
  nextTag: string;
  depth: number;
};

export type ElementLike = {
  tagName: string;
  textContent: string | null;
  attributes: ArrayLike<{ name: string; value: string }>;
  parentElement: ElementLike | null;
  previousElementSibling: ElementLike | null;
  nextElementSibling: ElementLike | null;
};

const SKIP_ATTRS = new Set(["style", "class"]);
const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

function classesOf(el: ElementLike): string[] {
  const attr = Array.from(el.attributes).find((a) => a.name === "class");
  return norm(attr?.value).split(" ").filter(Boolean);
}

export function fingerprint(el: ElementLike): Fingerprint {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (!SKIP_ATTRS.has(a.name) && a.value.length < 200) attrs[a.name] = a.value;
  const path: string[] = [];
  for (let n: ElementLike | null = el; n; n = n.parentElement) path.unshift(n.tagName.toLowerCase());
  return {
    tag: el.tagName.toLowerCase(), text: norm(el.textContent).slice(0, 160), attrs, classes: classesOf(el), path,
    parentTag: el.parentElement?.tagName.toLowerCase() ?? "", parentClasses: el.parentElement ? classesOf(el.parentElement) : [],
    prevTag: el.previousElementSibling?.tagName.toLowerCase() ?? "", nextTag: el.nextElementSibling?.tagName.toLowerCase() ?? "", depth: path.length,
  };
}

/** 0..100. A weighted blend of tag, text, attributes, classes, position and neighbours (a redesign may swap span for b). */
export function score(a: Fingerprint, b: Fingerprint): number {
  const attrKeys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  let attrScore = 1;
  if (attrKeys.size) { let sum = 0; for (const k of attrKeys) sum += k in a.attrs && k in b.attrs ? ratio(a.attrs[k] as string, b.attrs[k] as string) : 0; attrScore = sum / attrKeys.size; }
  const pathScore = jaccard(a.path.map((t, i) => `${i}:${t}`), b.path.map((t, i) => `${i}:${t}`)) * 0.5 + ratio(a.path.join(">"), b.path.join(">")) * 0.5;
  const parent = (a.parentTag === b.parentTag ? 0.5 : 0) + jaccard(a.parentClasses, b.parentClasses) * 0.5;
  const neighbours = ((a.prevTag === b.prevTag ? 1 : 0) + (a.nextTag === b.nextTag ? 1 : 0)) / 2;
  const total = 0.1 * (a.tag === b.tag ? 1 : 0) + 0.25 * ratio(a.text, b.text) + 0.15 * attrScore + 0.15 * jaccard(a.classes, b.classes) + 0.15 * pathScore + 0.1 * parent + 0.1 * neighbours;
  return Math.round(total * 1000) / 10;
}

export function bestMatch<T extends ElementLike>(saved: Fingerprint, candidates: T[], threshold = 40): { element: T; score: number } | null {
  let best: { element: T; score: number } | null = null;
  for (const c of candidates) {
    const s = score(saved, fingerprint(c));
    if (s >= threshold && (!best || s > best.score)) best = { element: c, score: s };
  }
  return best;
}

export type AdaptiveStore = { get(key: string): Promise<Fingerprint | null>; set(key: string, fp: Fingerprint): Promise<void> };

export function memoryStore(): AdaptiveStore & { size: () => number } {
  const map = new Map<string, Fingerprint>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, size: () => map.size };
}
