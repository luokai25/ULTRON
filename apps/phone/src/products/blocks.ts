import type { Block } from "./types";

/**
 * Section text is written by the model in a small, forgiving markdown dialect and parsed into typed blocks.
 * Markdown is far more reliable than long JSON for small and free models, and it streams naturally.
 *
 *   ## Heading            ### Sub-heading
 *   plain paragraph
 *   > LABEL: callout text
 *   > a quote with no label
 *   - [ ] checklist item
 *   - bullet     1. numbered
 *   ::timeline Title
 *   - when | step name | TAG | one line
 *   ::end
 *   ::table
 *   | A | B |
 *   | 1 | 2 |
 *   ::end
 *   ::image describe the picture
 */

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => { if (para.length) { const text = clean(para.join(" ")); if (text) blocks.push({ type: "paragraph", text }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^```/.test(line)) { continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flush(); blocks.push({ type: "heading", level: (heading[1] as string).length <= 2 ? 2 : 3, text: clean((heading[2] as string).replace(/[#*_]+$/g, "")) }); continue; }
    const timeline = line.match(/^::timeline\s*(.*)$/i);
    if (timeline) {
      flush();
      const steps: Array<{ when: string; name: string; tag: string; text: string }> = [];
      while (++i < lines.length && !/^::end/i.test((lines[i] as string).trim())) {
        const row = (lines[i] as string).trim().replace(/^[-*\d.)\s]+/, "");
        if (!row) continue;
        const parts = row.split("|").map(clean);
        if (parts.length >= 4) steps.push({ when: parts[0] as string, name: parts[1] as string, tag: (parts[2] as string).toUpperCase().slice(0, 24), text: parts.slice(3).join(" | ") });
        else if (parts.length === 3) steps.push({ when: parts[0] as string, name: parts[1] as string, tag: "", text: parts[2] as string });
        else if (parts.length === 2) steps.push({ when: "", name: parts[0] as string, tag: "", text: parts[1] as string });
        else if (parts[0]) steps.push({ when: "", name: parts[0], tag: "", text: "" });
      }
      if (steps.length) blocks.push({ type: "timeline", title: clean(timeline[1] ?? "").toUpperCase(), steps });
      continue;
    }
    if (/^::table/i.test(line) || (/^\|.+\|$/.test(line) && /^\|?[\s:-]+\|[\s|:-]*$/.test((lines[i + 1] ?? "").trim()))) {
      flush();
      const rows: string[][] = [];
      const explicit = /^::table/i.test(line);
      if (!explicit) i--;
      while (++i < lines.length) {
        const t = (lines[i] as string).trim();
        if (explicit && /^::end/i.test(t)) break;
        if (!t) { if (explicit) continue; break; }
        if (!t.startsWith("|")) { if (explicit) continue; i--; break; }
        if (/^\|?[\s:-]+(\|[\s:-]*)+$/.test(t) && !/[A-Za-z0-9]/.test(t)) continue;
        rows.push(t.replace(/^\||\|$/g, "").split("|").map(clean));
      }
      if (rows.length) { const [columns, ...body] = rows; blocks.push({ type: "table", columns: columns as string[], rows: body }); }
      continue;
    }
    const image = line.match(/^(?:::image|\[\[image:?|!\[[^\]]*\]\()\s*(.*?)(?:\]\]|\))?$/i);
    if (image && /^(::image|\[\[image|!\[)/i.test(line)) { flush(); const prompt = clean(image[1] ?? ""); if (prompt) blocks.push({ type: "image", prompt }); continue; }
    if (line.startsWith(">")) {
      flush();
      const parts: string[] = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && (lines[i + 1] as string).trim().startsWith(">")) parts.push((lines[++i] as string).trim().replace(/^>\s?/, ""));
      const text = clean(parts.join(" "));
      const labelled = text.match(/^\**([A-Za-z][A-Za-z0-9 '&/-]{1,28}?)\**\s*:\s*(.+)$/);
      if (labelled && (labelled[1] as string) === (labelled[1] as string).toUpperCase()) blocks.push({ type: "callout", label: labelled[1] as string, text: clean(labelled[2] as string) });
      else if (labelled && (labelled[1] as string).split(" ").length <= 3) blocks.push({ type: "callout", label: (labelled[1] as string).toUpperCase(), text: clean(labelled[2] as string) });
      else blocks.push({ type: "quote", text });
      continue;
    }
    if (/^[-*]\s+\[[ xX]\]\s+/.test(line)) {
      flush();
      const items = [line.replace(/^[-*]\s+\[[ xX]\]\s+/, "")];
      while (i + 1 < lines.length && /^[-*]\s+\[[ xX]\]\s+/.test((lines[i + 1] as string).trim())) items.push((lines[++i] as string).trim().replace(/^[-*]\s+\[[ xX]\]\s+/, ""));
      blocks.push({ type: "checklist", items: items.map(clean).filter(Boolean) });
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d{1,2}[.)]\s+/.test(line)) {
      flush();
      const ordered = /^\d/.test(line);
      const re = ordered ? /^\d{1,2}[.)]\s+/ : /^[-*•]\s+/;
      const items = [line.replace(re, "")];
      while (i + 1 < lines.length && re.test((lines[i + 1] as string).trim())) items.push((lines[++i] as string).trim().replace(re, ""));
      blocks.push({ type: "list", ordered, items: items.map(clean).filter(Boolean) });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Drop empty or broken blocks and collapse accidental repeats. */
export function normalizeBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "quote") { if (b.text.trim().length < 2) continue; }
    if (b.type === "heading" && !b.text.trim()) continue;
    if (b.type === "callout" && !b.text.trim()) continue;
    if ((b.type === "checklist" || b.type === "list") && !b.items.length) continue;
    if (b.type === "timeline" && !b.steps.length) continue;
    if (b.type === "table" && (!b.columns.length || !b.rows.length)) continue;
    const prev = out[out.length - 1];
    if (prev && JSON.stringify(prev) === JSON.stringify(b)) continue;
    out.push(b);
  }
  return out;
}

const inlineText = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[\s(])\*(.+?)\*(?=[\s).,;:!?]|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1");

export function stripInline(s: string): string { return inlineText(s); }

export function blockText(block: Block): string {
  switch (block.type) {
    case "heading": case "paragraph": case "quote": return block.text;
    case "callout": return `${block.label}: ${block.text}`;
    case "timeline": return `${block.title} ` + block.steps.map((s) => `${s.when} ${s.name} ${s.text}`).join(" ");
    case "checklist": case "list": return block.items.join(" ");
    case "table": return [...block.columns, ...block.rows.flat()].join(" ");
    case "image": return "";
  }
}

export function countWords(blocks: Block[]): number {
  return blocks.reduce((sum, b) => sum + (blockText(b).match(/\S+/g)?.length ?? 0), 0);
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));

export function inlineHtml(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** XHTML-safe rendering (used by the in-app reader, the EPUB and the HTML export). */
export function blocksToHtml(blocks: Block[], imageSrc: (assetId: string) => string | null = () => null): string {
  return blocks.map((b) => {
    switch (b.type) {
      case "heading": return `<h${b.level + 1}>${inlineHtml(b.text)}</h${b.level + 1}>`;
      case "paragraph": return `<p>${inlineHtml(b.text)}</p>`;
      case "quote": return `<blockquote><p>${inlineHtml(b.text)}</p></blockquote>`;
      case "callout": return `<div class="callout"><span class="callout-label">${escapeHtml(b.label)}</span><p>${inlineHtml(b.text)}</p></div>`;
      case "checklist": return `<ul class="checklist">${b.items.map((t) => `<li><span class="box">&#9744;</span> ${inlineHtml(t)}</li>`).join("")}</ul>`;
      case "list": { const tag = b.ordered ? "ol" : "ul"; return `<${tag}>${b.items.map((t) => `<li>${inlineHtml(t)}</li>`).join("")}</${tag}>`; }
      case "timeline": return `<div class="timeline">${b.title ? `<div class="timeline-title">${escapeHtml(b.title)}</div>` : ""}${b.steps.map((s) => `<div class="step"><div class="dot"></div><div class="step-body"><div class="step-head"><strong>${inlineHtml(s.name)}</strong>${s.tag ? `<span class="tag">${escapeHtml(s.tag)}</span>` : ""}</div>${s.when ? `<div class="when">${inlineHtml(s.when)}</div>` : ""}<p>${inlineHtml(s.text)}</p></div></div>`).join("")}</div>`;
      case "table": return `<table><thead><tr>${b.columns.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${b.columns.map((_, i) => `<td>${inlineHtml(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "image": { const src = b.assetId ? imageSrc(b.assetId) : null; return src ? `<figure><img src="${src}" alt="${escapeHtml(b.prompt)}"/><figcaption>${escapeHtml(b.prompt)}</figcaption></figure>` : ""; }
    }
  }).join("\n");
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.type) {
      case "heading": return `${"#".repeat(b.level)} ${b.text}`;
      case "paragraph": return b.text;
      case "quote": return `> ${b.text}`;
      case "callout": return `> **${b.label}:** ${b.text}`;
      case "checklist": return b.items.map((t) => `- [ ] ${t}`).join("\n");
      case "list": return b.items.map((t, i) => (b.ordered ? `${i + 1}. ${t}` : `- ${t}`)).join("\n");
      case "timeline": return (b.title ? `**${b.title}**\n\n` : "") + b.steps.map((s, i) => `${i + 1}. **${s.name}**${s.tag ? ` (${s.tag})` : ""}${s.when ? ` — ${s.when}` : ""}: ${s.text}`).join("\n");
      case "table": return `| ${b.columns.join(" | ")} |\n| ${b.columns.map(() => "---").join(" | ")} |\n` + b.rows.map((r) => `| ${b.columns.map((_, i) => r[i] ?? "").join(" | ")} |`).join("\n");
      case "image": return b.assetId ? `*[Illustration: ${b.prompt}]*` : "";
    }
  }).filter(Boolean).join("\n\n");
}
