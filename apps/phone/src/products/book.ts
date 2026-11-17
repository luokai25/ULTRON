import { blocksToHtml, blocksToMarkdown, escapeHtml } from "./blocks";
import { isSafeCategory } from "./scoring";
import type { Brand, Product, Section } from "./types";

/** Shared book model for every export: labels, front matter, styles and image lookup. */

export const DEFAULT_BRAND: Brand = { page: "#f6f1e9", type: "#2b2a27", accent: "#b5532f", tint: "#ead9c5", muted: "#6b6760", displayFont: "Merriweather", bodyFont: "Open Sans", style: "editorial, serif rules, flat", mood: "calm", coverPrompt: "" };

export const brandOf = (p: Product): Brand => p.brand ?? DEFAULT_BRAND;

export function sectionLabel(p: Product, s: Section): string {
  if (s.kind === "intro") return "INTRODUCTION";
  if (s.kind === "conclusion") return "CONCLUSION";
  const same = p.sections.filter((x) => x.kind === s.kind);
  const n = same.findIndex((x) => x.id === s.id) + 1;
  return s.kind === "bonus" ? `BONUS ${n}` : `CHAPTER ${String(n).padStart(2, "0")}`;
}

export function disclaimerOf(p: Product): string {
  return isSafeCategory(`${p.topic} ${p.pocket?.industry ?? ""} ${p.pocket?.niche ?? ""}`).disclaimer;
}

export const bookTitle = (p: Product): string => p.summary?.title || p.title || "Untitled eBook";
export const bookSubtitle = (p: Product): string => p.summary?.subtitle ?? "";
export const fileStem = (p: Product): string => bookTitle(p).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "ebook";

export function imageLookup(p: Product): (assetId: string) => { mime: string; data: string } | null {
  const map = new Map(p.images.map((i) => [i.id, i]));
  return (id) => { const i = map.get(id); return i ? { mime: i.mime, data: i.data } : null; };
}

/** Conservative stylesheet: no CSS variables, so it renders in strict e-reader engines as well as the in-app reader. */
export function bookCss(brand: Brand, forEpub = false): string {
  const serif = `"${brand.displayFont}", Georgia, "Times New Roman", serif`;
  const sans = `"${brand.bodyFont}", "Helvetica Neue", Arial, sans-serif`;
  return `body{font-family:${sans};color:${brand.type};line-height:1.6;margin:0;${forEpub ? "" : `background:${brand.page};`}}
h1,h2,h3,h4{font-family:${serif};color:${brand.type};line-height:1.25}
h1{font-size:1.9em;margin:0 0 .3em}h2{font-size:1.35em;margin:1.6em 0 .5em}h3{font-size:1.1em;margin:1.3em 0 .4em}
p{margin:0 0 .9em;text-align:justify;hyphens:auto}
.label{font-size:.72em;letter-spacing:.18em;color:${brand.accent};font-weight:bold;margin:0 0 .6em;text-align:left}
.rule{width:2.6em;height:3px;background:${brand.accent};border:0;margin:.5em 0 1.4em}
.callout{background:${brand.tint};border-left:4px solid ${brand.accent};padding:.7em 1em;margin:1.2em 0;border-radius:4px}
.callout p{margin:.2em 0 0;text-align:left}
.callout-label{font-size:.72em;letter-spacing:.14em;font-weight:bold;color:${brand.accent}}
blockquote{border-left:3px solid ${brand.muted};margin:1.2em 0;padding:.1em 1em;color:${brand.muted};font-style:italic}
ul.checklist{list-style:none;padding-left:0}ul.checklist li{margin:.4em 0}.box{color:${brand.accent}}
.timeline{margin:1.4em 0;border-left:2px solid ${brand.accent};padding-left:1em}
.timeline-title{font-size:.72em;letter-spacing:.16em;font-weight:bold;color:${brand.muted};margin-bottom:.6em}
.step{margin:0 0 .9em}.step p{margin:.2em 0 0;text-align:left}.step-head strong{font-family:${serif}}
.tag{font-size:.65em;letter-spacing:.1em;margin-left:.6em;padding:.1em .5em;border-radius:3px;background:${brand.tint};color:${brand.accent};font-weight:bold}
.when{font-size:.8em;color:${brand.muted}}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:.92em}th{background:${brand.tint};text-align:left}th,td{border:1px solid ${brand.muted};padding:.4em .6em;vertical-align:top}
figure{margin:1.4em 0;text-align:center}figure img{max-width:100%;height:auto;border-radius:6px}figcaption{font-size:.78em;color:${brand.muted};margin-top:.4em}
.title-page{text-align:center;margin-top:30%}.subtitle{color:${brand.muted};font-size:1.1em}.fine{font-size:.8em;color:${brand.muted};text-align:left}
nav ol{list-style:none;padding:0}nav li{margin:.5em 0}a{color:${brand.accent}}`;
}

export function sectionBodyHtml(p: Product, s: Section, withLabel = true): string {
  const look = imageLookup(p);
  const img = (id: string): string | null => { const a = look(id); return a ? `data:${a.mime};base64,${a.data}` : null; };
  return `${withLabel ? `<p class="label">${escapeHtml(sectionLabel(p, s))}</p>` : ""}<h1>${escapeHtml(s.title)}</h1><hr class="rule"/>\n${blocksToHtml(s.blocks, img)}`;
}

export function buildHtml(p: Product): string {
  const brand = brandOf(p);
  const toc = p.sections.filter((s) => s.status === "done").map((s) => `<li><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`).join("");
  const dis = disclaimerOf(p);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(bookTitle(p))}</title><style>${bookCss(brand)}body{max-width:42em;margin:0 auto;padding:2em 1.2em}section{margin:0 0 3.5em}</style></head><body>
<div class="title-page"><h1>${escapeHtml(bookTitle(p))}</h1><p class="subtitle" style="text-align:center">${escapeHtml(bookSubtitle(p))}</p></div>
${dis ? `<p class="fine">${escapeHtml(dis)}</p>` : ""}
<nav><h2>Contents</h2><ol>${toc}</ol></nav>
${p.sections.filter((s) => s.status === "done").map((s) => `<section id="${s.id}">${sectionBodyHtml(p, s)}</section>`).join("\n")}
</body></html>`;
}

export function buildMarkdown(p: Product): string {
  const dis = disclaimerOf(p);
  return [`# ${bookTitle(p)}`, bookSubtitle(p) ? `*${bookSubtitle(p)}*` : "", dis ? `> ${dis}` : "", "## Contents", p.sections.filter((s) => s.status === "done").map((s, i) => `${i + 1}. ${s.title}`).join("\n"),
    ...p.sections.filter((s) => s.status === "done").map((s) => `\n---\n\n*${sectionLabel(p, s)}*\n\n## ${s.title}\n\n${blocksToMarkdown(s.blocks)}`)].filter(Boolean).join("\n\n");
}
