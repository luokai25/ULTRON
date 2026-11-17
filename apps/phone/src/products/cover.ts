import type { Brand } from "./types";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));

export function wrapTitle(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) { lines.push(line); line = w; } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = (kept[maxLines - 1] as string).replace(/\s*\S*$/, "") + "…"; return kept; }
  return lines;
}

/** Typeset cover. The title is real text over a flat design, never baked into a generated picture. */
export function coverSvg(title: string, subtitle: string, brand: Brand, photoDataUri?: string): string {
  const lines = wrapTitle(title, 16, 5);
  const sub = wrapTitle(subtitle, 34, 3);
  const size = lines.some((l) => l.length > 14) ? 92 : 104;
  const top = 1040 - lines.length * size * 0.5;
  const serif = `${brand.displayFont}, Georgia, serif`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
<rect width="1200" height="1800" fill="${brand.page}"/>
${photoDataUri ? `<image href="${photoDataUri}" x="0" y="0" width="1200" height="820" preserveAspectRatio="xMidYMid slice"/><rect x="0" y="820" width="1200" height="14" fill="${brand.accent}"/>` : `<rect x="0" y="0" width="1200" height="820" fill="${brand.tint}"/><circle cx="930" cy="300" r="250" fill="${brand.accent}" opacity=".16"/><circle cx="260" cy="560" r="160" fill="${brand.accent}" opacity=".1"/><rect x="90" y="90" width="150" height="14" fill="${brand.accent}"/>`}
<text x="90" y="${top}" font-family="${serif}" font-weight="700" font-size="${size}" fill="${brand.type}">${lines.map((l, i) => `<tspan x="90" dy="${i ? size * 1.12 : 0}">${esc(l)}</tspan>`).join("")}</text>
<rect x="90" y="${top + lines.length * size * 1.12 + 10}" width="120" height="10" fill="${brand.accent}"/>
<text x="90" y="${top + lines.length * size * 1.12 + 100}" font-family="${brand.bodyFont}, Arial, sans-serif" font-size="44" fill="${brand.muted}">${sub.map((l, i) => `<tspan x="90" dy="${i ? 58 : 0}">${esc(l)}</tspan>`).join("")}</text>
</svg>`;
}

/** Rasterise the SVG cover with the WebView's canvas. Returns null when no canvas is available (tests, workers). */
export async function coverPng(svg: string): Promise<Uint8Array | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  try {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("cover failed")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 1800;
    canvas.getContext("2d")?.drawImage(img, 0, 0, 1200, 1800);
    URL.revokeObjectURL(url);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}
