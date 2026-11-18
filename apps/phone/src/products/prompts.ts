import { BOOK_FORMATS, DEPTH_SPEC, type Product } from "./types";
import { digestsForSection } from "./deep-research";
import { isSafeCategory } from "./scoring";

export const BANNED = "Never use: 'in today's fast-paced world', 'unlock', 'game-changer', 'delve', 'tapestry', 'navigate the complexities', 'it's not X, it's Y' constructions, rhetorical-question openers, or more than one em dash per page. No guru voice, no hype, no invented statistics, no fake testimonials, no fake studies.";

export const SYSTEM_JSON = "You are Ultron's offer strategist. You reply with ONE valid JSON value and nothing else: no markdown fences, no commentary. Use plain double quotes. Keep every string concrete and specific.";
export const SYSTEM_WRITER = "You are Ultron's book author and editor. You write clear, specific, useful prose for real readers. You follow the requested output dialect exactly and add no commentary.";

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function guardrails(product: Pick<Product, "topic" | "pocket">): string {
  const g = isSafeCategory(`${product.topic} ${product.pocket?.industry ?? ""} ${product.pocket?.niche ?? ""}`);
  return g.rules.length ? "SAFETY RULES: " + g.rules.join(" ") : "";
}

/** The canonical brief every step is built against. Compact on purpose: free models can have small context windows. */
export function brief(product: Product): string {
  const p = product.pocket;
  const o = product.outlines.find((x) => x.id === product.outlineId);
  const lines: string[] = [];
  lines.push(`TOPIC: ${product.topic}`);
  if (p) lines.push(`OFFER: ${p.statement}`, `AUDIENCE/NICHE: ${p.niche} (${p.industry})`, `KNOWLEDGE: ${clip(p.knowledge, 280)}`, `PROBLEM: ${clip(p.problem, 280)}`);
  if (o) lines.push(`APPROVED OUTLINE "${o.name}": ${o.promise} | ${o.fromTo}`);
  if (product.vtm?.stages.length) lines.push("TRANSFORMATION STAGES: " + product.vtm.stages.map((s, i) => `${i + 1}. ${s.stage}`).join("; "));
  if (product.summary) lines.push(`BOOK: "${product.summary.title}" — ${product.summary.subtitle}`);
  if (product.summary?.glossary.length) lines.push("NAMED FRAMEWORKS (use these exact names consistently): " + product.summary.glossary.map((g) => `${g.term} = ${clip(g.meaning, 80)}`).join("; "));
  lines.push(`VOICE: ${clip(product.custom.tone, 220)}`);
  if (product.custom.notes.trim()) lines.push(`AUTHOR NOTES: ${clip(product.custom.notes, 500)}`);
  if (product.research?.notes) lines.push(`MARKET RESEARCH (from ${product.research.deep ? `${product.research.digests?.length ?? 0} web sources the app read` : "the web"}): ${clip(product.research.notes, product.research.deep ? 2400 : 900)}`);
  if (product.creator?.notes) lines.push(`CREATOR MATERIAL (public, consented): ${clip(product.creator.notes, 900)}`);
  const refs = product.custom.references.map((r) => `[${r.name}] ${clip(r.text, 500)}`).join("\n");
  if (refs) lines.push("SUPPORTING REFERENCES:\n" + clip(refs, 1500));
  const g = guardrails(product);
  if (g) lines.push(g);
  return lines.join("\n");
}

export const promptDirections = (product: Product, count: number): string =>
  `${brief(product)}\n\nTask: expand this input into ${count} DISTINCT market directions a solo creator could build a digital product in. Vary the categories; no near-duplicates; each direction is a specific angle, not a broad field.\nReturn JSON: {"directions":[{"title":"specific angle","category":"2-3 word category"}]}`;

export const promptBrainstorm = (product: Product, directions: Array<{ id: string; title: string; category: string }>, perDirection: number): string =>
  `${brief(product)}\n\nTask: for EACH direction below write ${perDirection} "profitable pocket" offers. Template for the statement, exactly: "I help [specific audience] [achieve specific outcome] without [common bad alternative or pain]." Make the outcome time-boxed where natural ("in 14 days"). No guru phrasing.\nDirections:\n${directions.map((d) => `- ${d.id}: ${d.title} (${d.category})`).join("\n")}\n${MARKET_NOTE(product)}\nReturn JSON: {"pockets":[{"directionId":"id from above","statement":"I help ...","industry":"","niche":"Industry niche","knowledge":"the expertise required and why a market exists","problem":"the pain, how it worsens, what the buyer learns over a time-boxed period"}]}`;

const MARKET_NOTE = (product: Product): string => (product.research?.notes ? "Ground 'why a market exists' in the market research above; do not invent sources." : "Do not claim a market is 'validated'; say what kind of existing products suggest demand.");

export const promptScore = (product: Product, pockets: Array<{ id: string; statement: string }>): string =>
  `${brief(product)}\n\nTask: score each pocket on four dimensions from 1 to 10 in 0.5 steps. Be a harsh, discriminating reviewer: a typical pocket is 5-7; only truly urgent, worsening, high-budget and fast-to-win problems earn 8+. Spread the scores; do not give everything 7-9.\npain = how urgently people want this solved. worsening = how much it gets worse if ignored. purchasing = ability and willingness of this audience to pay. speed = how fast a buyer sees a result.\nPockets:\n${pockets.map((p) => `- ${p.id}: ${p.statement}`).join("\n")}\nReturn JSON: {"scores":[{"id":"pocket id","pain":0,"worsening":0,"purchasing":0,"speed":0,"rationale":"one sentence"}]}`;

export const promptOutline = (product: Product, label: string, previous: Array<{ name: string; promise: string }>, feedback?: string, base?: { name: string; promise: string }): string =>
  `${brief(product)}\n\nFormat: ${BOOK_FORMATS[product.custom.bookFormat].label}. Depth: ${DEPTH_SPEC[product.custom.depth].label} (${DEPTH_SPEC[product.custom.depth].chapters} chapters). ${BOOK_FORMATS[product.custom.bookFormat].rule}\nTask: write product outline option ${label}. It needs a memorable name, a one-sentence time-boxed promise ("Within 14 days, ..."), a from-to transformation line, and ${DEPTH_SPEC[product.custom.depth].chapters} chapter titles each with a one-sentence purpose.${previous.length ? `\nIt MUST differ clearly in angle and method from these earlier options:\n${previous.map((o) => `- ${o.name}: ${o.promise}`).join("\n")}` : ""}${base ? `\nRevise this existing option: "${base.name}" — ${base.promise}` : ""}${feedback ? `\nAuthor feedback to apply: ${feedback}` : ""}\n${BANNED}\nReturn JSON: {"name":"","promise":"","fromTo":"From ... to ...","chapters":[{"title":"","purpose":""}]}`;

export const promptVtm = (product: Product): string =>
  `${brief(product)}\n\nTask: write the Visceral Transformation Map. Part 1: a Before and After table with exactly these four rows: Emotional State, Core Fear, Daily Experience, Identity. Each cell is 2-3 concrete sentences (${product.mode === "creator" ? "second person" : "third person"}). Part 2: exactly 5 transformation stages that form the logical backbone of the book; each has a stage name, a goal and a one-sentence description.\n${BANNED}\nReturn JSON: {"rows":[{"label":"Emotional State","before":"","after":""}],"stages":[{"stage":"","goal":"","description":""}]}`;

export const promptRefineVtm = (product: Product, instruction: string): string =>
  `${brief(product)}\n\nCurrent map JSON:\n${JSON.stringify(product.vtm ?? {})}\n\nTask: apply this change and return the FULL updated map in the same JSON shape: ${instruction}\nReturn JSON: {"rows":[...],"stages":[...]}`;

export const promptSummary = (product: Product): string => {
  const d = DEPTH_SPEC[product.custom.depth];
  return `${brief(product)}\n\nFormat: ${BOOK_FORMATS[product.custom.bookFormat].label}; depth ${d.label}.\nTask: produce the eBook summary. Invent 3-4 NAMED frameworks or tools (short, memorable names) that the book will teach and that every chapter will reuse. Include 2 bonus materials (for example a diagnostic and a template or card).\n${BANNED}\nReturn JSON: {"title":"","subtitle":"","about":"2-3 sentences","learn":["4 bullets naming the book's own frameworks"],"glossary":[{"term":"","meaning":""}],"bonuses":[{"title":"","kind":"diagnostic|template|checklist|card"}]}`;
};

export const promptChapterPlan = (product: Product): string => {
  const d = DEPTH_SPEC[product.custom.depth];
  const o = product.outlines.find((x) => x.id === product.outlineId);
  return `${brief(product)}\n\nApproved outline chapters:\n${(o?.chapters ?? []).map((c, i) => `${i + 1}. ${c.title} — ${c.purpose}`).join("\n")}\n\nTask: plan the chapters. Produce an introduction, ${d.chapters} core chapters mapped to the transformation stages in order (a stage may split across two chapters; the last core chapter must measure whether the outcome happened), a conclusion, then ${d.bonuses} bonus materials (diagnostics, templates, checklists or cards). Keep the approved outline's chapter titles where they fit.\nReturn JSON: {"sections":[{"kind":"intro|chapter|conclusion|bonus","title":"","purpose":"what this section must accomplish in one sentence"}]}`;
};

/** Source excerpts for this section, numbered so the writer can cite them and the book can list them. */
export function sourceNotes(product: Product, title: string, purpose: string): string {
  const ds = product.research?.digests;
  if (!ds?.length) return "";
  const picked = digestsForSection(ds, title, purpose, 6);
  if (!picked.length) return "";
  return `\nSOURCE NOTES FOR THIS SECTION (from pages the app actually read; use facts only from here or from general knowledge, never invent numbers, studies or quotes; when you use a specific fact from a note, add its number in brackets like [12]):\n${picked.map((d) => `[${d.n}] ${clip(d.digest, 380)}`).join("\n")}\n`;
}

function sectionTarget(product: Product, index: number): number {
  const s = product.sections[index];
  const d = DEPTH_SPEC[product.custom.depth];
  return s?.kind === "bonus" ? Math.round(d.words[0] * 0.6) : s?.kind === "intro" || s?.kind === "conclusion" ? Math.round(d.words[0] * 0.8) : Math.round((d.words[0] + d.words[1]) / 2);
}

const DIALECT = `OUTPUT DIALECT (plain text, no JSON, no code fences, no title line):
## Heading            (use headings to organise the text)
paragraphs separated by blank lines; **bold** sparingly
> LABEL: one-to-two sentence rule of thumb      (LABEL is 1-3 capital words)
- [ ] checklist item                              (for exercises or templates)
::timeline TITLE IN CAPITALS
- when | step name | TAG | one line
::end
::table
| Column | Column |
| cell | cell |
::end`;

export function promptSection(product: Product, index: number, previousTail: string, imagesHere: number, part: 1 | 2 = 1, firstPart: string = ""): string {
  const s = product.sections[index];
  if (!s) throw new Error("Unknown section");
  const d = DEPTH_SPEC[product.custom.depth];
  const two = d.parts === 2 && s.kind !== "bonus";
  const total = sectionTarget(product, index);
  const target = two ? (part === 1 ? Math.round(total * 0.55) : Math.round(total * 0.5)) : total;
  const outline = product.sections.map((x, i) => `${i + 1}. ${x.title}${i === index ? "  <-- WRITE THIS" : ""}`).join("\n");
  const common = `${brief(product)}\n\nBOOK OUTLINE:\n${outline}\n${product.runningSummary ? `\nWHAT HAS BEEN COVERED SO FAR (do not repeat it):\n${product.runningSummary}\n` : ""}${sourceNotes(product, s.title, s.purpose)}`;
  if (two && part === 2) {
    return `${common}\nHere is the first half of "${s.title}" that is already written (do not repeat any of it):\n"""\n${clip(firstPart, 1800)}\n"""\n\nTask: write the SECOND half of the ${s.kind} titled "${s.title}". About ${target} words of NEW material only. ${BOOK_FORMATS[product.custom.bookFormat].rule}\nInclude: one worked example with concrete numbers or a named scenario, the most common mistakes and how to fix each, and a short exercise the reader can do. Use the named frameworks by their exact names. End with one small action the reader can do today. Start directly with a new "## " heading. Do not summarise the first half.\n${BANNED}\n\n${DIALECT}\nStart writing now.`;
  }
  return `${common}${previousTail ? `\nEnd of the previous section, for continuity:\n"${clip(previousTail, 400)}"\n` : ""}\nTask: write ${two ? "the FIRST half of " : ""}the ${s.kind === "bonus" ? "bonus material" : s.kind} titled "${s.title}". Purpose: ${s.purpose}\nTarget length about ${target} words${two ? " (a second call will write the second half, so do not conclude the section)" : ""}. ${BOOK_FORMATS[product.custom.bookFormat].rule}\nOpen with something concrete (a scene, a number to count, a mistake people make), never with a definition. Use the named frameworks by their exact names. ${two ? "Teach the core idea clearly with at least one example." : "Give at least one worked example with specifics. End with one small action the reader can do today."}\n${imagesHere > 0 ? `Include exactly ${imagesHere} illustration slot${imagesHere > 1 ? "s" : ""} as a line "::image <a concrete visual description, no text in the picture>".\n` : "Do not include images.\n"}${BANNED}\n\n${DIALECT}\n::image describe the picture\nStart writing now.`;
}

/** Adds new material to a finished section when the measured PDF is shorter than the target length. */
export function promptExpand(product: Product, index: number, words: number): string {
  const s = product.sections[index];
  if (!s) throw new Error("Unknown section");
  const headings = s.blocks.filter((b) => b.type === "heading").map((b) => (b.type === "heading" ? b.text : "")).join("; ");
  const lastPara = [...s.blocks].reverse().find((b) => b.type === "paragraph");
  return `${brief(product)}\n${sourceNotes(product, s.title, s.purpose)}\nThe ${s.kind} "${s.title}" is already written. Headings so far: ${headings || "none"}.${lastPara && lastPara.type === "paragraph" ? `\nIts last paragraph: "${clip(lastPara.text, 300)}"` : ""}\n\nTask: add about ${words} words of NEW, useful material to this section that does not repeat anything above. Choose what fits best: a realistic scenario told step by step with specifics, troubleshooting for what goes wrong and why, a comparison of two approaches with trade-offs, a short checklist or table the reader can reuse, or answers to the questions readers ask most. Start with a new "## " heading. Do not conclude the book and do not summarise.\n${BANNED}\n\n${DIALECT}\nStart writing now.`;
}

export const promptBranding = (product: Product): string =>
  `${brief(product)}\n\nTask: design the book's branding. Choose a 5-colour palette (page background, body text, accent, tint, muted) with strong text contrast on the page colour, a display font and body font from this allow-list ONLY: Merriweather, Open Sans, a short style label (for example "editorial, serif rules, flat"), the mood in 3 words, and a cover image prompt (a concrete scene or object, no text in the image).\nReturn JSON: {"palette":{"page":"#rrggbb","type":"#rrggbb","accent":"#rrggbb","tint":"#rrggbb","muted":"#rrggbb"},"displayFont":"Merriweather","bodyFont":"Open Sans","style":"","mood":"","coverPrompt":""}`;

export const promptStore = (product: Product): string =>
  `${brief(product)}\n\nTask: write the sales page copy for this finished eBook. Honest, specific, no fake reviews, no income promises. Return JSON: {"headline":"","subhead":"","bullets":["5 benefit bullets that name the book's frameworks"],"priceSuggestion":"a price and one line of reasoning","faq":[{"q":"","a":""}]}`;

export const promptTrends = (headlines: string[]): string =>
  `Here are today's public trending search topics and headlines:\n${headlines.slice(0, 40).map((h) => "- " + h).join("\n")}\n\nTask: turn them into 6 evergreen digital-product ideas a solo creator could sell as an eBook (practical topics people pay to learn; skip celebrity, sports scores and tragedy). Each idea is a short phrase.\nReturn JSON: {"ideas":["..."]}`;

export const promptCondense = (batch: string, topic: string): string =>
  `Numbered excerpts from web pages about "${topic}":\n${batch}\n\nTask: write 6-8 bullets with the most useful concrete facts, advice, numbers and common mistakes found across these excerpts. End each bullet with the [n] numbers of the excerpts it comes from. No opinions of your own, no filler, no claims that are not in the excerpts. Maximum 1100 characters.`;
