/** Clean, token-lean Markdown from a DOM subtree: what the model reads instead of raw HTML. */

type N = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<N>; getAttribute?: (n: string) => string | null };

const DROP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "canvas", "form", "select", "button", "nav", "footer", "aside", "head", "link", "meta"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "ul", "ol", "li", "table", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "figcaption", "dl", "dt", "dd"]);
const clean = (s: string): string => s.replace(/[ \t\r\f\v]+/g, " ");

export function toMarkdown(root: N, baseUrl = "", maxChars = 60000): string {
  const out: string[] = [];
  const abs = (href: string | null | undefined): string => { if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) return ""; try { return new URL(href, baseUrl || undefined).toString(); } catch { return ""; } };

  const inline = (n: N): string => {
    if (n.nodeType === 3) return clean(n.textContent ?? "");
    if (n.nodeType !== 1) return "";
    const name = n.nodeName.toLowerCase();
    if (DROP.has(name)) return "";
    const kids = Array.from(n.childNodes).map(inline).join("");
    if (name === "br") return "\n";
    if (name === "a") { const href = abs(n.getAttribute?.("href")); const t = kids.trim(); return href && t ? `[${t}](${href})` : t; }
    if (name === "strong" || name === "b") return kids.trim() ? `**${kids.trim()}**` : "";
    if (name === "em" || name === "i") return kids.trim() ? `*${kids.trim()}*` : "";
    if (name === "code") return kids.trim() ? `\`${kids.trim()}\`` : "";
    if (name === "img") { const alt = (n.getAttribute?.("alt") ?? "").trim(); return alt ? `[image: ${alt}]` : ""; }
    return kids;
  };

  const pushBlock = (text: string): void => { const t = text.replace(/[ \t]*\n[ \t]*/g, "\n").trim(); if (t) out.push(t); };

  const walk = (n: N, listDepth = 0): void => {
    if (n.nodeType === 3) { const t = clean(n.textContent ?? "").trim(); if (t) pushBlock(t); return; }
    if (n.nodeType !== 1) return;
    const name = n.nodeName.toLowerCase();
    if (DROP.has(name)) return;
    const heading = name.match(/^h([1-6])$/);
    if (heading) { pushBlock(`${"#".repeat(Number(heading[1]))} ${inline(n).replace(/\s+/g, " ").trim()}`); return; }
    if (name === "p" || name === "figcaption" || name === "dt" || name === "dd") { pushBlock(inline(n).replace(/\s*\n\s*/g, " ")); return; }
    if (name === "pre") { pushBlock("```\n" + (n.textContent ?? "").trim() + "\n```"); return; }
    if (name === "blockquote") { pushBlock(inline(n).split("\n").map((l) => `> ${l.trim()}`).join("\n")); return; }
    if (name === "ul" || name === "ol") {
      let i = 0;
      for (const li of Array.from(n.childNodes)) if (li.nodeType === 1 && li.nodeName.toLowerCase() === "li") {
        const nested = Array.from(li.childNodes).filter((c) => c.nodeType === 1 && ["ul", "ol"].includes(c.nodeName.toLowerCase()));
        const own = Array.from(li.childNodes).filter((c) => !nested.includes(c)).map(inline).join("").replace(/\s+/g, " ").trim();
        if (own) out.push(`${"  ".repeat(listDepth)}${name === "ol" ? `${++i}.` : "-"} ${own}`);
        for (const sub of nested) walk(sub, listDepth + 1);
      }
      return;
    }
    if (name === "table") {
      const rows = Array.from((n as unknown as { querySelectorAll: (s: string) => ArrayLike<N> }).querySelectorAll("tr")).map((tr) => Array.from((tr as unknown as { querySelectorAll: (s: string) => ArrayLike<N> }).querySelectorAll("th,td")).map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "/").trim()));
      const filtered = rows.filter((r) => r.some(Boolean));
      if (filtered.length) { const [head, ...rest] = filtered; out.push(`| ${(head as string[]).join(" | ")} |\n| ${(head as string[]).map(() => "---").join(" | ")} |\n${rest.map((r) => `| ${r.join(" | ")} |`).join("\n")}`); }
      return;
    }
    const hasBlockChild = Array.from(n.childNodes).some((c) => c.nodeType === 1 && (BLOCK.has(c.nodeName.toLowerCase()) || DROP.has(c.nodeName.toLowerCase())));
    if (!hasBlockChild && BLOCK.has(name)) { pushBlock(inline(n)); return; }
    if (!hasBlockChild) { const t = inline(n).trim(); if (t) pushBlock(t); return; }
    for (const c of Array.from(n.childNodes)) walk(c, listDepth);
  };

  walk(root);
  const text = out.join("\n\n").replace(/\n{3,}/g, "\n\n");
  return text.length > maxChars ? text.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n\n[truncated]" : text;
}
