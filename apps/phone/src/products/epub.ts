import { escapeHtml } from "./blocks";
import { bookCss, bookSubtitle, bookTitle, brandOf, disclaimerOf, imageLookup, sectionBodyHtml, sourcesHtml, usedSources } from "./book";
import { coverSvg } from "./cover";
import type { Product } from "./types";

export type ZipDeps = { zipSync: (files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]>) => Uint8Array; strToU8: (s: string) => Uint8Array };

const xhtml = (title: string, body: string, bodyClass = ""): string => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body${bodyClass ? ` class="${bodyClass}"` : ""}>${body}</body></html>`;

/** Deterministic RFC 4122 (version 4 layout) UUID from the product id, so re-exports keep the same book identity. */
function stableUuid(seed: string): string {
  let a = 0x811c9dc5; let b = 0x1b873593; let hex = "";
  for (let i = 0; hex.length < 32; i++) {
    const c = seed.charCodeAt(i % Math.max(1, seed.length)) + i;
    a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b + a + c, 2246822519) >>> 0;
    hex += ((a ^ b) >>> 0).toString(16).padStart(8, "0");
  }
  const h = hex.slice(0, 32).split("");
  h[12] = "4"; h[16] = "89ab"[parseInt(h[16] as string, 16) % 4] as string;
  const j = h.join("");
  return `${j.slice(0, 8)}-${j.slice(8, 12)}-${j.slice(12, 16)}-${j.slice(16, 20)}-${j.slice(20, 32)}`;
}

const b64 = (data: string): Uint8Array => { const bin = atob(data); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** EPUB 3 with an EPUB 2 NCX for older readers. Illustrations are embedded, so the file works fully offline. */
export function buildEpub(p: Product, zip: ZipDeps, coverPngBytes?: Uint8Array | null): Uint8Array {
  const brand = brandOf(p);
  const title = bookTitle(p);
  const done = p.sections.filter((s) => s.status === "done");
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = {};
  const put = (path: string, text: string): void => { files[path] = zip.strToU8(text); };
  files["mimetype"] = [zip.strToU8("application/epub+zip"), { level: 0 }];
  put("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  put("OEBPS/styles.css", bookCss(brand, true));

  const look = imageLookup(p);
  const manifest: string[] = [];
  const spine: string[] = [];
  const imageItems: string[] = [];
  let imgCount = 0;
  const used = new Set<string>();
  const chapterFiles = done.map((s, i) => {
    let html = sectionBodyHtml(p, s);
    html = html.replace(/<img src="data:([^;]+);base64,([^"]+)"/g, (_m, mime: string, data: string) => {
      const ext = EXT[mime];
      if (!ext) return "<img";
      const name = `images/img${++imgCount}.${ext}`;
      files[`OEBPS/${name}`] = b64(data);
      imageItems.push(`<item id="img${imgCount}" href="${name}" media-type="${mime}"/>`);
      used.add(name);
      return `<img src="${name}"`;
    });
    return { id: `c${i + 1}`, href: `chapter${i + 1}.xhtml`, title: s.title, html };
  });
  void look;
  if (usedSources(p).length) chapterFiles.push({ id: `c${chapterFiles.length + 1}`, href: `chapter${chapterFiles.length + 1}.xhtml`, title: "Sources and further reading", html: sourcesHtml(p).replace(/^<section id="sources">|<\/section>$/g, "") });

  const cover = coverPngBytes ?? null;
  if (cover) files["OEBPS/images/cover.png"] = cover; else put("OEBPS/images/cover.svg", coverSvg(title, bookSubtitle(p), brand));
  const coverItem = cover ? `<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>` : `<item id="cover-image" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>`;
  put("OEBPS/cover.xhtml", xhtml(title, `<div style="text-align:center"><img src="${cover ? "images/cover.png" : "images/cover.svg"}" alt="${escapeHtml(title)}" style="max-width:100%;max-height:100%"/></div>`));
  const dis = disclaimerOf(p);
  put("OEBPS/title.xhtml", xhtml(title, `<div class="title-page"><h1>${escapeHtml(title)}</h1><p class="subtitle" style="text-align:center">${escapeHtml(bookSubtitle(p))}</p></div>${dis ? `<p class="fine">${escapeHtml(dis)}</p>` : ""}`));
  for (const c of chapterFiles) put(`OEBPS/${c.href}`, xhtml(c.title, c.html));

  const id = `urn:uuid:${stableUuid(p.id)}`;
  put("OEBPS/nav.xhtml", xhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapterFiles.map((c) => `<li><a href="${c.href}">${escapeHtml(c.title)}</a></li>`).join("")}</ol></nav>`));
  put("OEBPS/toc.ncx", `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeHtml(title)}</text></docTitle><navMap>${chapterFiles.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeHtml(c.title)}</text></navLabel><content src="${c.href}"/></navPoint>`).join("")}</navMap></ncx>`);

  manifest.push(coverItem, `<item id="css" href="styles.css" media-type="text/css"/>`, `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`, `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`, `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    ...chapterFiles.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`), ...imageItems);
  spine.push(`<itemref idref="cover"/>`, `<itemref idref="title"/>`, `<itemref idref="nav"/>`, ...chapterFiles.map((c) => `<itemref idref="${c.id}"/>`));
  const modified = (p.updatedAt || new Date().toISOString()).replace(/\.\d+Z$/, "Z").replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/, "$1Z");
  put("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${escapeHtml(title)}</dc:title><dc:language>en</dc:language>${bookSubtitle(p) ? `<dc:description>${escapeHtml(bookSubtitle(p))}</dc:description>` : ""}<meta property="dcterms:modified">${/Z$/.test(modified) ? modified : "2026-01-01T00:00:00Z"}</meta></metadata><manifest>${manifest.join("")}</manifest><spine toc="ncx">${spine.join("")}</spine></package>`);
  return zip.zipSync(files);
}
