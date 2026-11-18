import { stripInline } from "./blocks";
import { bookSubtitle, bookTitle, brandOf, disclaimerOf, imageLookup, sectionLabel, usedSources } from "./book";
import { wrapTitle } from "./cover";
import type { Block, Product } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PdfFonts = { display: string; body: string; bodyBold: string };
export type PdfDeps = { jsPDF: new (options: Record<string, unknown>) => any; fonts: PdfFonts; coverImage?: { mime: string; data: string } | null };

const PAGE_W = 152.4; // 6 x 9 inch trim, a comfortable phone and e-reader size
const PAGE_H = 228.6;
const MX = 17;
const MT = 20;
const MB = 20;
const W = PAGE_W - MX * 2;
const PT = 0.3528; // mm per point

const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

type Word = { t: string; bold: boolean; w: number };

function runs(text: string): Array<{ t: string; bold: boolean }> {
  const out: Array<{ t: string; bold: boolean }> = [];
  let bold = false;
  for (const part of text.split("**")) { const t = part.replace(/(^|\s)\*(\S[^*]*)\*(?=[\s.,;:!?)]|$)/g, "$1$2").replace(/`/g, ""); if (t) out.push({ t, bold }); bold = !bold; }
  return out;
}

/** Image size from the file header, so figures keep their proportions without decoding the picture. */
export function imageSize(base64: string, mime: string): { w: number; h: number } | null {
  try {
    const bin = atob(base64.slice(0, 120000));
    const byte = (i: number): number => bin.charCodeAt(i);
    if (mime === "image/png") return { w: (byte(16) << 24) | (byte(17) << 16) | (byte(18) << 8) | byte(19), h: (byte(20) << 24) | (byte(21) << 16) | (byte(22) << 8) | byte(23) };
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < bin.length - 9) {
        if (byte(i) !== 0xff) { i++; continue; }
        const marker = byte(i + 1);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: (byte(i + 5) << 8) | byte(i + 6), w: (byte(i + 7) << 8) | byte(i + 8) };
        i += 2 + ((byte(i + 2) << 8) | byte(i + 3));
      }
    }
  } catch { /* unreadable header */ }
  return null;
}

export function buildPdf(p: Product, deps: PdfDeps): Uint8Array { return buildPdfWithInfo(p, deps).bytes; }

export function buildPdfWithInfo(p: Product, deps: PdfDeps): { bytes: Uint8Array; pages: number } {
  const brand = brandOf(p);
  const doc = new deps.jsPDF({ unit: "mm", format: [PAGE_W, PAGE_H], orientation: "portrait", compress: true });
  doc.addFileToVFS("BookDisplay-Bold.ttf", deps.fonts.display); doc.addFont("BookDisplay-Bold.ttf", "BookDisplay", "bold");
  doc.addFileToVFS("BookBody-Regular.ttf", deps.fonts.body); doc.addFont("BookBody-Regular.ttf", "BookBody", "normal");
  doc.addFileToVFS("BookBody-Bold.ttf", deps.fonts.bodyBold); doc.addFont("BookBody-Bold.ttf", "BookBody", "bold");
  const look = imageLookup(p);
  const title = bookTitle(p);
  const color = { page: rgb(brand.page), type: rgb(brand.type), accent: rgb(brand.accent), tint: rgb(brand.tint), muted: rgb(brand.muted) };
  let y = MT;
  const sectionStarts = new Set<number>([1, 2, 3]);
  const tocEntries: Array<{ title: string; page: number }> = [];

  const fill = (c: [number, number, number]): void => doc.setFillColor(c[0], c[1], c[2]);
  const ink = (c: [number, number, number]): void => doc.setTextColor(c[0], c[1], c[2]);
  const stroke = (c: [number, number, number], w = 0.2): void => { doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(w); };
  const paintPage = (): void => { fill(color.page); doc.rect(0, 0, PAGE_W, PAGE_H, "F"); };
  const newPage = (): void => { doc.addPage([PAGE_W, PAGE_H]); paintPage(); y = MT; };
  const ensure = (h: number): void => { if (y + h > PAGE_H - MB) newPage(); };
  const font = (family: "BookDisplay" | "BookBody", style: "normal" | "bold", size: number): void => { doc.setFont(family, style); doc.setFontSize(size); };

  const words = (text: string, size: number, baseBold = false): { list: Word[]; space: number } => {
    font("BookBody", "normal", size);
    const space = doc.getTextWidth(" ");
    const list: Word[] = [];
    for (const r of runs(text)) {
      font("BookBody", r.bold || baseBold ? "bold" : "normal", size);
      for (const t of r.t.split(/\s+/).filter(Boolean)) list.push({ t, bold: r.bold || baseBold, w: doc.getTextWidth(t) });
    }
    return { list, space };
  };

  const layout = (text: string, size: number, width: number, baseBold = false): Word[][] => {
    const { list, space } = words(text, size, baseBold);
    const lines: Word[][] = [];
    let line: Word[] = [];
    let used = 0;
    for (const word of list) {
      const need = line.length ? used + space + word.w : word.w;
      if (line.length && need > width) { lines.push(line); line = [word]; used = word.w; } else { line.push(word); used = need; }
    }
    if (line.length) lines.push(line);
    return lines;
  };

  const drawLine = (line: Word[], x: number, baseline: number, size: number, width: number, justify: boolean): void => {
    font("BookBody", "normal", size);
    const space = doc.getTextWidth(" ");
    const natural = line.reduce((n, w) => n + w.w, 0);
    const gap = justify && line.length > 1 ? Math.min((width - natural) / (line.length - 1), space * 2.6) : space;
    let cx = x;
    for (const w of line) { font("BookBody", w.bold ? "bold" : "normal", size); doc.text(w.t, cx, baseline); cx += w.w + gap; }
  };

  /** Draws wrapped text and returns the height used. With `measureOnly`, nothing is drawn. */
  const paragraph = (text: string, opts: { size?: number; x?: number; width?: number; justify?: boolean; bold?: boolean; leading?: number; measureOnly?: boolean; breakPages?: boolean } = {}): number => {
    const size = opts.size ?? 9.6; const x = opts.x ?? MX; const width = opts.width ?? W; const lh = size * PT * (opts.leading ?? 1.55);
    const lines = layout(text, size, width, opts.bold);
    if (opts.measureOnly) return lines.length * lh;
    ink(color.type);
    const startY = y;
    lines.forEach((line, i) => {
      if (opts.breakPages !== false) ensure(lh);
      drawLine(line, x, y + size * PT * 0.9, size, width, Boolean(opts.justify) && i < lines.length - 1);
      y += lh;
    });
    return y - startY;
  };

  // ----- cover -----
  paintPage();
  const coverH = 120;
  if (deps.coverImage) {
    try { doc.addImage(`data:${deps.coverImage.mime};base64,${deps.coverImage.data}`, deps.coverImage.mime === "image/png" ? "PNG" : "JPEG", 0, 0, PAGE_W, coverH, undefined, "FAST"); } catch { fill(color.tint); doc.rect(0, 0, PAGE_W, coverH, "F"); }
    fill(color.accent); doc.rect(0, coverH, PAGE_W, 1.6, "F");
  } else {
    fill(color.tint); doc.rect(0, 0, PAGE_W, coverH, "F");
    try { const G = doc.GState; doc.setGState(new G({ opacity: 0.16 })); fill(color.accent); doc.circle(PAGE_W * 0.78, 40, 32, "F"); doc.setGState(new G({ opacity: 0.1 })); doc.circle(PAGE_W * 0.2, 80, 20, "F"); doc.setGState(new G({ opacity: 1 })); } catch { /* opacity is optional */ }
    fill(color.accent); doc.rect(MX, 16, 18, 1.8, "F");
  }
  const titleLines = wrapTitle(title, 17, 5);
  const tSize = titleLines.some((l) => l.length > 14) ? 25 : 29;
  font("BookDisplay", "bold", tSize); ink(color.type);
  let cy = coverH + 24;
  for (const l of titleLines) { doc.text(l, MX, cy); cy += tSize * PT * 1.18; }
  fill(color.accent); doc.rect(MX, cy - 3, 16, 1.4, "F");
  cy += 9;
  for (const l of wrapTitle(bookSubtitle(p), 36, 3)) { font("BookBody", "normal", 11.5); ink(color.muted); doc.text(l, MX, cy); cy += 6.4; }

  // ----- title page -----
  newPage();
  font("BookDisplay", "bold", 20); ink(color.type);
  let ty = 70;
  for (const l of wrapTitle(title, 22, 4)) { doc.text(l, PAGE_W / 2, ty, { align: "center" }); ty += 9; }
  font("BookBody", "normal", 10.5); ink(color.muted);
  for (const l of wrapTitle(bookSubtitle(p), 40, 3)) { doc.text(l, PAGE_W / 2, ty + 4, { align: "center" }); ty += 6; }
  const dis = disclaimerOf(p);
  if (dis) { y = PAGE_H - 54; ink(color.muted); paragraph(dis, { size: 8, justify: false }); }

  // ----- contents placeholder (filled once page numbers are known) -----
  newPage();

  // ----- sections -----
  const checkbox = (x: number, top: number): void => { stroke(color.accent, 0.35); doc.rect(x, top, 3, 3); };
  const blockHeight = (b: Block): number => {
    if (b.type === "callout") return 9 + paragraph(b.text, { size: 9.2, x: MX + 5, width: W - 10, measureOnly: true });
    return 0;
  };
  const renderBlock = (b: Block): void => {
    switch (b.type) {
      case "heading": {
        ensure(b.level === 2 ? 24 : 18); y += b.level === 2 ? 4 : 2;
        if (b.level === 2) { font("BookDisplay", "bold", 13.5); ink(color.type); for (const l of wrapTitle(stripInline(b.text), 38, 3)) { doc.text(l, MX, y + 4); y += 6.4; } y += 1.5; }
        else { paragraph(stripInline(b.text), { size: 10.8, bold: true, leading: 1.4 }); y += 1; }
        break;
      }
      case "paragraph": paragraph(b.text, { justify: true }); y += 2.4; break;
      case "quote": { const h = paragraph(b.text, { size: 9.6, measureOnly: true, x: MX + 5, width: W - 6 }); ensure(h + 4); stroke(color.muted, 0.6); doc.line(MX + 1, y, MX + 1, y + h); paragraph(b.text, { x: MX + 5, width: W - 6 }); y += 3; break; }
      case "callout": {
        const h = blockHeight(b); ensure(h + 4); y += 1;
        fill(color.tint); doc.roundedRect(MX, y, W, h, 1.5, 1.5, "F"); fill(color.accent); doc.rect(MX, y, 1.3, h, "F");
        font("BookBody", "bold", 7); ink(color.accent); doc.setCharSpace?.(0.5); doc.text(b.label, MX + 5, y + 5); doc.setCharSpace?.(0);
        const save = y; y += 6.6; paragraph(b.text, { size: 9.2, x: MX + 5, width: W - 10, breakPages: false }); y = save + h + 4; break;
      }
      case "checklist": for (const item of b.items) { const h = Math.max(5, paragraph(item, { measureOnly: true, x: MX + 7, width: W - 7 })); ensure(h); checkbox(MX + 0.5, y + 0.9); paragraph(item, { x: MX + 7, width: W - 7, breakPages: false }); } y += 2; break;
      case "list": b.items.forEach((item, i) => { const h = paragraph(item, { measureOnly: true, x: MX + 7, width: W - 7 }); ensure(h); font("BookBody", "bold", 9.6); ink(color.accent); doc.text(b.ordered ? `${i + 1}.` : "•", MX + 1, y + 9.6 * PT * 0.9); paragraph(item, { x: MX + 7, width: W - 7, breakPages: false }); }); y += 2; break;
      case "timeline": {
        if (b.title) { ensure(14); font("BookBody", "bold", 7); ink(color.muted); doc.setCharSpace?.(0.6); doc.text(b.title, MX, y + 3); doc.setCharSpace?.(0); y += 7; }
        b.steps.forEach((s, i) => {
          const body = paragraph(s.text, { size: 9, x: MX + 8, width: W - 8, measureOnly: true });
          const head = 6 + (s.when ? 4.4 : 0);
          const h = head + body + 3;
          ensure(h);
          stroke(color.accent, 0.5);
          if (i < b.steps.length - 1) doc.line(MX + 2, y + 2.6, MX + 2, y + h + 2.6);
          fill(color.accent); doc.circle(MX + 2, y + 2.6, 1.4, "F");
          font("BookDisplay", "bold", 9.6); ink(color.type); doc.text(stripInline(s.name), MX + 8, y + 3.4);
          if (s.tag) { const nameW = doc.getTextWidth(stripInline(s.name)); font("BookBody", "bold", 6.2); const tw = doc.getTextWidth(s.tag) + 3; fill(color.tint); doc.roundedRect(MX + 10 + nameW, y + 0.4, tw, 4.2, 1, 1, "F"); ink(color.accent); doc.text(s.tag, MX + 11.5 + nameW, y + 3.3); }
          let yy = y + 6;
          if (s.when) { font("BookBody", "normal", 8); ink(color.muted); doc.text(stripInline(s.when), MX + 8, yy + 0.6); yy += 4.4; }
          const save = y; y = yy; paragraph(s.text, { size: 9, x: MX + 8, width: W - 8, breakPages: false }); y = save + h;
        });
        y += 2; break;
      }
      case "table": {
        const cols = b.columns.length; const cw = W / cols; font("BookBody", "normal", 8.6);
        const rowH = (cells: string[], bold: boolean): number => Math.max(...cells.map((c) => layout(c, 8.6, cw - 3, bold).length), 1) * 8.6 * PT * 1.45 + 3;
        const drawRow = (cells: string[], header: boolean): void => {
          const h = rowH(cells, header); ensure(h);
          if (header) { fill(color.tint); doc.rect(MX, y, W, h, "F"); }
          stroke(color.muted, 0.15); doc.line(MX, y + h, MX + W, y + h);
          cells.forEach((c, i) => { const save = y; y = y + 1.5; paragraph(c, { size: 8.6, x: MX + i * cw + 1.5, width: cw - 3, bold: header, breakPages: false, leading: 1.45 }); y = save; });
          y += h;
        };
        y += 1; drawRow(b.columns, true); for (const r of b.rows) drawRow(b.columns.map((_, i) => r[i] ?? ""), false); y += 3; break;
      }
      case "image": {
        const a = b.assetId ? look(b.assetId) : null;
        if (!a || (a.mime !== "image/png" && a.mime !== "image/jpeg")) return;
        const size = imageSize(a.data, a.mime) ?? { w: 3, h: 2 };
        const w = Math.min(W, 100); const h = (w * size.h) / size.w;
        ensure(h + 10); doc.addImage(`data:${a.mime};base64,${a.data}`, a.mime === "image/png" ? "PNG" : "JPEG", MX + (W - w) / 2, y, w, h, undefined, "FAST");
        y += h + 2; font("BookBody", "normal", 7.6); ink(color.muted);
        for (const l of wrapTitle(b.prompt, 70, 2)) { doc.text(l, PAGE_W / 2, y + 2.4, { align: "center" }); y += 3.6; }
        y += 4; break;
      }
    }
  };

  for (const s of p.sections.filter((x) => x.status === "done")) {
    newPage();
    const start = doc.getNumberOfPages();
    sectionStarts.add(start); tocEntries.push({ title: s.title, page: start });
    y = MT + 8;
    font("BookBody", "bold", 7.5); ink(color.accent); doc.setCharSpace?.(0.9); doc.text(sectionLabel(p, s), MX, y); doc.setCharSpace?.(0);
    y += 8;
    font("BookDisplay", "bold", 20); ink(color.type);
    for (const l of wrapTitle(s.title, 24, 4)) { doc.text(l, MX, y); y += 9.2; }
    fill(color.accent); doc.rect(MX, y - 3, 14, 1.2, "F"); y += 8;
    for (const b of s.blocks) renderBlock(b);
  }

  // ----- sources -----
  const sources = usedSources(p);
  if (sources.length) {
    newPage();
    const start = doc.getNumberOfPages();
    sectionStarts.add(start); tocEntries.push({ title: "Sources and further reading", page: start });
    y = MT + 8;
    font("BookBody", "bold", 7.5); ink(color.accent); doc.setCharSpace?.(0.9); doc.text("SOURCES", MX, y); doc.setCharSpace?.(0);
    y += 8; font("BookDisplay", "bold", 20); ink(color.type);
    for (const l of wrapTitle("Sources and further reading", 24, 3)) { doc.text(l, MX, y); y += 9.2; }
    fill(color.accent); doc.rect(MX, y - 3, 14, 1.2, "F"); y += 8;
    for (const src of sources) {
      const head = paragraph(`[${src.n}] ${src.title}`, { size: 8.4, bold: true, leading: 1.35, measureOnly: true, x: MX, width: W });
      ensure(head + 8);
      paragraph(`[${src.n}] ${src.title}`, { size: 8.4, bold: true, leading: 1.35 });
      font("BookBody", "normal", 7); ink(color.muted);
      for (const l of doc.splitTextToSize(src.url.length > 140 ? src.url.slice(0, 140) + "…" : src.url, W) as string[]) { ensure(3.4); doc.text(l, MX, y + 2); y += 3.3; }
      y += 2.2;
    }
  }

  // ----- contents page, running header and page numbers -----
  doc.setPage(3);
  font("BookDisplay", "bold", 18); ink(color.type); doc.text("Contents", MX, MT + 8);
  let cyy = MT + 24;
  for (const e of tocEntries) {
    font("BookBody", "normal", 10); ink(color.type);
    const label = wrapTitle(e.title, 46, 1)[0] ?? e.title; doc.text(label, MX, cyy);
    const num = String(e.page - 0); doc.text(num, PAGE_W - MX, cyy, { align: "right" });
    stroke(color.muted, 0.1); const lw = doc.getTextWidth(label); doc.setLineDashPattern?.([0.4, 1.2], 0); doc.line(MX + lw + 2, cyy - 0.8, PAGE_W - MX - doc.getTextWidth(num) - 2, cyy - 0.8); doc.setLineDashPattern?.([], 0);
    cyy += 8.2;
  }
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    font("BookBody", "normal", 7.4); ink(color.muted);
    doc.text(String(i), PAGE_W / 2, PAGE_H - 10, { align: "center" });
    if (!sectionStarts.has(i)) doc.text(wrapTitle(title, 60, 1)[0] ?? title, PAGE_W / 2, 11, { align: "center" });
  }
  return { bytes: new Uint8Array(doc.output("arraybuffer")), pages: total };
}
