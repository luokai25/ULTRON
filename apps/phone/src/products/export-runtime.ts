import { saveLocalArtifact, type LocalArtifactMeta } from "../local-artifacts";
import { buildHtml, buildMarkdown, fileStem, brandOf, bookTitle, bookSubtitle } from "./book";
import { buildEpub } from "./epub";
import { coverPng, coverSvg } from "./cover";
import { buildPdf, buildPdfWithInfo } from "./pdf";
import type { Product } from "./types";
import merriweatherBold from "@expo-google-fonts/merriweather/700Bold/Merriweather_700Bold.ttf?url";
import openSans from "@expo-google-fonts/open-sans/400Regular/OpenSans_400Regular.ttf?url";
import openSansBold from "@expo-google-fonts/open-sans/700Bold/OpenSans_700Bold.ttf?url";

export const FONT_URLS = { merriweatherBold, openSans, openSansBold };

export type ExportFormat = "pdf" | "epub" | "html" | "md";
export const FORMAT_INFO: Record<ExportFormat, { label: string; mime: string; ext: string; hint: string }> = {
  pdf: { label: "PDF", mime: "application/pdf", ext: "pdf", hint: "Print-ready 6×9 in book with embedded fonts" },
  epub: { label: "EPUB", mime: "application/epub+zip", ext: "epub", hint: "For Kindle apps, Apple Books and e-readers" },
  html: { label: "Web page", mime: "text/html", ext: "html", hint: "One self-contained file, opens anywhere" },
  md: { label: "Markdown", mime: "text/markdown", ext: "md", hint: "Plain text for editing elsewhere" },
};

const fontCache = new Map<string, string>();
async function fontBase64(url: string): Promise<string> {
  const hit = fontCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error("A bundled font could not be loaded.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const out = btoa(bin);
  fontCache.set(url, out);
  return out;
}

export async function renderExport(p: Product, format: ExportFormat): Promise<Blob> {
  const info = FORMAT_INFO[format];
  if (!p.sections.some((s) => s.status === "done")) throw new Error("Write at least one section before exporting.");
  if (format === "html") return new Blob([buildHtml(p)], { type: info.mime });
  if (format === "md") return new Blob([buildMarkdown(p)], { type: info.mime });
  if (format === "epub") {
    const { zipSync, strToU8 } = await import("fflate");
    const png = await coverPng(coverSvg(bookTitle(p), bookSubtitle(p), brandOf(p)));
    const bytes = buildEpub(p, { zipSync: zipSync as never, strToU8 }, png);
    return new Blob([bytes as BlobPart], { type: info.mime });
  }
  const [{ jsPDF }, display, body, bodyBold] = await Promise.all([import("jspdf"), fontBase64(merriweatherBold), fontBase64(openSans), fontBase64(openSansBold)]);
  const bytes = buildPdf(p, { jsPDF: jsPDF as never, fonts: { display, body, bodyBold } });
  return new Blob([bytes as BlobPart], { type: info.mime });
}

/** Renders a format and files it with the user's other generated files, so it also shows up in the Agent Workspace. */
export async function exportProduct(p: Product, format: ExportFormat): Promise<{ meta: LocalArtifactMeta; blob: Blob; filename: string }> {
  const blob = await renderExport(p, format);
  const meta = await saveLocalArtifact({ name: `${fileStem(p)}.${FORMAT_INFO[format].ext}`, blob, mimeType: FORMAT_INFO[format].mime, description: `${bookTitle(p)} (${FORMAT_INFO[format].label})`, metadata: { productId: p.id, kind: "digital-product" } });
  return { meta, blob, filename: `${fileStem(p)}.${FORMAT_INFO[format].ext}` };
}

/** Real page count of the finished PDF, used to grow books to their target length. */
export async function measurePdfPages(p: Product): Promise<number> {
  const [{ jsPDF }, display, body, bodyBold] = await Promise.all([import("jspdf"), fontBase64(merriweatherBold), fontBase64(openSans), fontBase64(openSansBold)]);
  return buildPdfWithInfo(p, { jsPDF: jsPDF as never, fonts: { display, body, bodyBold } }).pages;
}
