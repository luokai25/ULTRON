import { asArray, asRecord, asString, clampScore, extractJson } from "./json";
import { blocksToMarkdown, countWords, normalizeBlocks, parseBlocks } from "./blocks";
import { brief, promptBrainstorm, promptBranding, promptChapterPlan, promptDirections, promptOutline, promptRefineVtm, promptScore, promptSection, promptStore, promptSummary, promptTrends, promptVtm, SYSTEM_JSON, SYSTEM_WRITER } from "./prompts";
import { overallScore, rankPockets, isSafeCategory } from "./scoring";
import { DEFAULT_CUSTOM, DEPTH_SPEC, FONT_ALLOWLIST, type Block, type Brand, type Charter, type Direction, type EbookSummary, type Outline, type Pocket, type Product, type ProductMode, type Section, type SectionKind, type StoreCopy, type Vtm } from "./types";

export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type CompleteOptions = { maxTokens: number; signal?: AbortSignal; onToken?: (token: string) => void };
export type Completer = (messages: Msg[], options: CompleteOptions) => Promise<string>;

export type Progress =
  | { phase: "directions" | "brainstorm" | "score"; done: number; total: number; label: string }
  | { phase: "section"; index: number; total: number; words: number; wave: number; waves: number }
  | { phase: "note"; label: string };

export type EngineEnv = {
  complete: Completer;
  signal?: AbortSignal;
  /** Parallel model calls. Free tiers are rate limited, so keep this small. */
  concurrency?: number;
  persist?: (product: Product) => Promise<void> | void;
  progress?: (event: Progress) => void;
  /** Called with streamed text for a section while it is being written. */
  stream?: (sectionId: string, text: string) => void;
  now?: () => string;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Optional illustration generator; failures are tolerated. */
  image?: (prompt: string, brandMood: string, signal?: AbortSignal) => Promise<{ mime: string; data: string } | null>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nowIso = (env: EngineEnv): string => (env.now ?? (() => new Date().toISOString()))();
let counter = 0;
const nextId = (env: EngineEnv, prefix: string): string => (env.newId ? `${prefix}_${env.newId()}` : `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`);

function abortIf(env: EngineEnv): void { if (env.signal?.aborted) throw new DOMException("Generation stopped", "AbortError"); }

export function log(product: Product, env: EngineEnv, step: string, note: string): void {
  product.history.push({ at: nowIso(env), step, note });
  if (product.history.length > 200) product.history.splice(0, product.history.length - 200);
  product.updatedAt = nowIso(env);
}

async function save(env: EngineEnv, product: Product): Promise<void> { product.updatedAt = nowIso(env); await env.persist?.(product); }

export function newProduct(topic: string, mode: ProductMode, env: EngineEnv = { complete: async () => "" }, source: Product["source"] = "tab"): Product {
  const at = nowIso(env);
  return {
    id: nextId(env, "prod"), schema: 1, title: "Untitled eBook", createdAt: at, updatedAt: at, mode, topic: topic.trim().slice(0, 200),
    directions: [], pockets: [], outlines: [], custom: { ...DEFAULT_CUSTOM, references: [] }, sections: [], images: [], stage: "discover",
    runningSummary: "", history: [], source,
  };
}

/** Ask for JSON; on a parse or validation failure, show the model its own output and ask again. */
export async function askJson<T>(env: EngineEnv, user: string, parse: (raw: unknown) => T, maxTokens = 2200, retries = 2): Promise<T> {
  const messages: Msg[] = [{ role: "system", content: SYSTEM_JSON }, { role: "user", content: user }];
  let lastError: Error = new Error("The model did not return usable JSON.");
  for (let attempt = 0; attempt <= retries; attempt++) {
    abortIf(env);
    let text = "";
    try {
      text = await env.complete(messages, { maxTokens, signal: env.signal });
      return parse(extractJson(text));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error instanceof Error ? error : lastError;
      if (!text) { await (env.sleep ?? defaultSleep)(900 * (attempt + 1)); continue; }
      messages.push({ role: "assistant", content: text.slice(0, 3000) }, { role: "user", content: `That was not valid for the schema (${lastError.message.slice(0, 120)}). Reply again with ONLY the corrected JSON.` });
    }
  }
  throw lastError;
}

async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i] as T, i); }
  });
  await Promise.all(runners);
  return results;
}

// ---------- Stage 1: discovery ----------

export async function discoverPockets(product: Product, env: EngineEnv): Promise<Product> {
  const total = 12;
  env.progress?.({ phase: "directions", done: 0, total, label: "Reading your input" });
  const rawDirections = await askJson(env, promptDirections(product, total), (raw) => {
    const list = asArray(asRecord(raw).directions ?? raw).map((d) => asRecord(typeof d === "string" ? { title: d } : d));
    const out = list.map((d) => ({ title: asString(d.title), category: asString(d.category, "General") })).filter((d) => d.title);
    if (out.length < 3) throw new Error("fewer than 3 directions");
    return out.slice(0, 16);
  });
  product.directions = rawDirections.map((d, i): Direction => ({ id: `d${i + 1}`, title: d.title, category: d.category }));
  env.progress?.({ phase: "directions", done: product.directions.length, total: product.directions.length, label: `${product.directions.length} directions explored` });
  await save(env, product);

  const batches: Direction[][] = [];
  for (let i = 0; i < product.directions.length; i += 4) batches.push(product.directions.slice(i, i + 4));
  let produced = 0;
  const raw: Pocket[] = [];
  const results = await pool(batches, env.concurrency ?? 2, async (batch) => {
    const got = await askJson(env, promptBrainstorm(product, batch, 2), (value) => {
      const list = asArray(asRecord(value).pockets ?? value).map(asRecord);
      const out = list.map((p) => ({
        directionId: asString(p.directionId), statement: asString(p.statement), industry: asString(p.industry, "General"),
        niche: asString(p.niche, asString(p.industry, "General")), knowledge: asString(p.knowledge), problem: asString(p.problem),
      })).filter((p) => p.statement.length > 12);
      if (!out.length) throw new Error("no pockets");
      return out;
    }, 2600);
    produced += got.length;
    env.progress?.({ phase: "brainstorm", done: produced, total: product.directions.length * 2, label: "Turning directions into opportunities" });
    return got;
  });
  for (const batch of results) for (const p of batch) {
    const direction = product.directions.find((d) => d.id === p.directionId) ?? product.directions[0];
    raw.push({ id: `p${raw.length + 1}`, directionId: direction?.id ?? "d1", statement: p.statement, industry: p.industry, niche: p.niche, knowledge: p.knowledge, problem: p.problem,
      scores: { pain: 6, worsening: 6, purchasing: 6, speed: 6 }, overall: 6, rationale: "" });
  }
  if (!raw.length) throw new Error("The model returned no opportunities. Try again or pick a stronger model.");
  const evidence = product.research?.sources.slice(0, 3).map((s) => s.title) ?? [];

  env.progress?.({ phase: "score", done: 0, total: raw.length, label: "Ranking opportunities" });
  const scoreBatches: Pocket[][] = [];
  for (let i = 0; i < raw.length; i += 12) scoreBatches.push(raw.slice(i, i + 12));
  let scored = 0;
  await pool(scoreBatches, env.concurrency ?? 2, async (batch) => {
    const rows = await askJson(env, promptScore(product, batch.map((p) => ({ id: p.id, statement: p.statement }))), (value) => {
      const list = asArray(asRecord(value).scores ?? value).map(asRecord);
      if (!list.length) throw new Error("no scores");
      return list;
    }, 2400).catch(() => [] as Array<Record<string, unknown>>);
    for (const row of rows) {
      const target = batch.find((p) => p.id === asString(row.id));
      if (!target) continue;
      target.scores = { pain: clampScore(row.pain), worsening: clampScore(row.worsening), purchasing: clampScore(row.purchasing ?? row.pp), speed: clampScore(row.speed) };
      target.rationale = asString(row.rationale);
      target.overall = overallScore(target.scores);
    }
    scored += batch.length;
    env.progress?.({ phase: "score", done: scored, total: raw.length, label: `${scored} of ${raw.length} scored` });
  });
  product.pockets = rankPockets(raw.map((p) => ({ ...p, evidence })));
  product.stage = "pockets";
  log(product, env, "discover", `${product.pockets.length} pockets scored`);
  await save(env, product);
  return product;
}

// ---------- Stage 3: outlines ----------

function parseOutline(raw: unknown): Pick<Outline, "name" | "promise" | "fromTo" | "chapters"> {
  const r = asRecord(raw);
  const chapters = asArray(r.chapters).map(asRecord).map((c) => ({ title: asString(c.title), purpose: asString(c.purpose) })).filter((c) => c.title);
  const name = asString(r.name);
  if (!name || chapters.length < 3) throw new Error("outline needs a name and 3+ chapters");
  return { name, promise: asString(r.promise), fromTo: asString(r.fromTo ?? r.from_to), chapters };
}

/** Options are written one after another so each one can be told to differ from the earlier ones. */
export async function generateOutlines(product: Product, env: EngineEnv): Promise<Product> {
  const labels: Array<"A" | "B" | "C"> = ["A", "B", "C"];
  product.outlines = [];
  for (const label of labels) {
    abortIf(env);
    const previous = product.outlines.map((o) => ({ name: o.name, promise: o.promise }));
    const body = await askJson(env, promptOutline(product, label, previous), parseOutline, 1800);
    product.outlines.push({ id: `o${label}1`, label, version: 1, ...body });
    env.progress?.({ phase: "note", label: `Drafted outline ${label}` });
    await save(env, product);
  }
  product.stage = "outline";
  log(product, env, "outline", "3 outline options drafted");
  await save(env, product);
  return product;
}

export async function reviseOutline(product: Product, outlineId: string, feedback: string, env: EngineEnv): Promise<Outline> {
  const index = product.outlines.findIndex((o) => o.id === outlineId);
  const current = product.outlines[index];
  if (!current) throw new Error("Outline not found");
  const others = product.outlines.filter((o) => o.id !== outlineId).map((o) => ({ name: o.name, promise: o.promise }));
  const body = await askJson(env, promptOutline(product, current.label, others, feedback, { name: current.name, promise: current.promise }), parseOutline, 1800);
  const next: Outline = { ...current, ...body, version: current.version + 1, feedback, approved: false };
  product.outlines[index] = next;
  log(product, env, "outline", `Option ${current.label} revised to v${next.version}`);
  await save(env, product);
  return next;
}

export function approveOutline(product: Product, outlineId: string, env: EngineEnv = { complete: async () => "" }): void {
  const found = product.outlines.find((o) => o.id === outlineId);
  if (!found) throw new Error("Outline not found");
  product.outlines.forEach((o) => { o.approved = o.id === outlineId; });
  product.outlineId = outlineId;
  product.title = found.name;
  product.stage = "customise";
  log(product, env, "outline", `Approved option ${found.label}: ${found.name}`);
}

// ---------- Stage 3: transformation map ----------

const VTM_LABELS = ["Emotional State", "Core Fear", "Daily Experience", "Identity"];
function parseVtm(raw: unknown): Vtm {
  const r = asRecord(raw);
  const rows = asArray(r.rows).map(asRecord).map((x, i) => ({ label: asString(x.label, VTM_LABELS[i] ?? `Row ${i + 1}`), before: asString(x.before), after: asString(x.after) })).filter((x) => x.before && x.after);
  const stages = asArray(r.stages).map(asRecord).map((x) => ({ stage: asString(x.stage), goal: asString(x.goal), description: asString(x.description) })).filter((x) => x.stage);
  if (rows.length < 3 || stages.length < 3) throw new Error("map needs 3+ rows and 3+ stages");
  return { rows: rows.slice(0, 6), stages: stages.slice(0, 7) };
}

export async function buildVtm(product: Product, env: EngineEnv): Promise<Vtm> {
  product.vtm = await askJson(env, promptVtm(product), parseVtm, 2200);
  product.stage = "vtm";
  log(product, env, "vtm", "Transformation map built");
  await save(env, product);
  return product.vtm;
}

export async function refineVtm(product: Product, instruction: string, env: EngineEnv): Promise<Vtm> {
  product.vtm = await askJson(env, promptRefineVtm(product, instruction), parseVtm, 2200);
  log(product, env, "vtm", `Refined: ${instruction.slice(0, 80)}`);
  await save(env, product);
  return product.vtm;
}

// ---------- Stage 4: summary, chapter plan ----------

export async function buildSummary(product: Product, env: EngineEnv): Promise<EbookSummary> {
  const d = DEPTH_SPEC[product.custom.depth];
  const parsed = await askJson(env, promptSummary(product), (raw) => {
    const r = asRecord(raw);
    const title = asString(r.title);
    if (!title) throw new Error("summary needs a title");
    return {
      title, subtitle: asString(r.subtitle), about: asString(r.about),
      learn: asArray(r.learn).map((x) => asString(x)).filter(Boolean).slice(0, 5),
      glossary: asArray(r.glossary).map(asRecord).map((g) => ({ term: asString(g.term), meaning: asString(g.meaning) })).filter((g) => g.term).slice(0, 6),
      bonuses: asArray(r.bonuses).map(asRecord).map((b) => ({ title: asString(b.title), kind: asString(b.kind, "template") })).filter((b) => b.title).slice(0, 3),
    };
  }, 1800);
  const sectionCount = d.chapters + 2 + Math.max(1, parsed.bonuses.length);
  const avg = (d.words[0] + d.words[1]) / 2;
  const low = Math.round((sectionCount * avg * 0.8) / 50) * 50;
  const high = Math.round((sectionCount * avg * 1.2) / 50) * 50;
  product.summary = { ...parsed, wordRange: [low, high], readingMinutes: Math.max(5, Math.round(((low + high) / 2) / 230)) };
  product.title = parsed.title;
  log(product, env, "structure", `Summary: ${parsed.title}`);
  await save(env, product);
  return product.summary;
}

export async function planChapters(product: Product, env: EngineEnv): Promise<Section[]> {
  const kinds: SectionKind[] = ["intro", "chapter", "conclusion", "bonus"];
  const parsed = await askJson(env, promptChapterPlan(product), (raw) => {
    const list = asArray(asRecord(raw).sections ?? raw).map(asRecord).map((s) => ({
      kind: (kinds.includes(asString(s.kind) as SectionKind) ? asString(s.kind) : "chapter") as SectionKind, title: asString(s.title), purpose: asString(s.purpose),
    })).filter((s) => s.title);
    if (list.filter((s) => s.kind === "chapter").length < 3) throw new Error("need 3+ chapters");
    return list;
  }, 2200);
  const order: Record<SectionKind, number> = { intro: 0, chapter: 1, conclusion: 2, bonus: 3 };
  const sorted = parsed.map((s, i) => ({ s, i })).sort((a, b) => order[a.s.kind] - order[b.s.kind] || a.i - b.i).map((x) => x.s);
  if (!sorted.some((s) => s.kind === "intro")) sorted.unshift({ kind: "intro", title: "Start Here", purpose: "Hook the reader and promise the outcome." });
  if (!sorted.some((s) => s.kind === "conclusion")) sorted.splice(sorted.filter((s) => s.kind !== "bonus").length, 0, { kind: "conclusion", title: "Keep It Going", purpose: "Recap and give the next 7 days." });
  product.sections = sorted.map((s, i) => ({ id: `s${i + 1}`, position: i + 1, kind: s.kind, title: s.title, purpose: s.purpose, status: "queued", words: 0, blocks: [] }));
  product.stage = "manuscript";
  log(product, env, "structure", `${product.sections.length} sections planned`);
  await save(env, product);
  return product.sections;
}

// ---------- Manuscript ----------

export function imageSlots(product: Product): Map<number, number> {
  const slots = new Map<number, number>();
  const chapters = product.sections.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "chapter" || x.s.kind === "intro");
  const want = Math.min(product.custom.imageCount, chapters.length);
  for (let k = 0; k < want; k++) {
    const pick = chapters[Math.floor(((k + 0.5) * chapters.length) / want)] ?? chapters[k];
    if (pick) slots.set(pick.i, (slots.get(pick.i) ?? 0) + 1);
  }
  return slots;
}

function keepImages(blocks: Block[], allowed: number): Block[] {
  let seen = 0;
  return blocks.filter((b) => (b.type !== "image" ? true : ++seen <= allowed));
}

export function updateRunningSummary(product: Product): void {
  const done = product.sections.filter((s) => s.status === "done");
  product.runningSummary = done.map((s) => {
    const firstPara = s.blocks.find((b) => b.type === "paragraph");
    const text = firstPara && firstPara.type === "paragraph" ? firstPara.text.split(/(?<=[.!?])\s/)[0] ?? "" : "";
    return `- ${s.title}: ${text.slice(0, 140)}`;
  }).join("\n").slice(-1800);
}

function lastParagraph(section: Section | undefined): string {
  if (!section) return "";
  for (let i = section.blocks.length - 1; i >= 0; i--) { const b = section.blocks[i]; if (b && b.type === "paragraph") return b.text; }
  return "";
}

export async function writeSection(product: Product, index: number, env: EngineEnv, slots: Map<number, number> = imageSlots(product)): Promise<Section> {
  const section = product.sections[index];
  if (!section) throw new Error("Unknown section");
  const wantImages = slots.get(index) ?? 0;
  section.status = "writing"; section.error = undefined;
  let attempt = 0;
  for (;;) {
    abortIf(env);
    try {
      let streamed = "";
      const prompt = promptSection(product, index, lastParagraph(product.sections[index - 1]), wantImages);
      const text = await env.complete([{ role: "system", content: SYSTEM_WRITER }, { role: "user", content: prompt }], {
        maxTokens: DEPTH_SPEC[product.custom.depth].words[1] * 2 + 700, signal: env.signal,
        onToken: (t) => { streamed += t; env.stream?.(section.id, streamed); },
      });
      let blocks = normalizeBlocks(parseBlocks(text));
      blocks = blocks.filter((b, i) => !(i === 0 && b.type === "heading" && b.text.toLowerCase().replace(/[^a-z0-9]/g, "") === section.title.toLowerCase().replace(/[^a-z0-9]/g, "")));
      blocks = keepImages(blocks, wantImages);
      const words = countWords(blocks);
      if (words < 60) throw new Error("The section came back too short.");
      section.blocks = blocks; section.words = words; section.status = "done";
      return section;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") { section.status = "queued"; throw error; }
      if (attempt++ >= 2) { section.status = "error"; section.error = error instanceof Error ? error.message : "Writing failed"; return section; }
      await (env.sleep ?? defaultSleep)(1500 * attempt);
    }
  }
}

/** Writes pending sections in waves. Safe to call again after a stop or failure: finished sections are kept. */
export async function writeManuscript(product: Product, env: EngineEnv, waveSize = 3): Promise<Product> {
  product.sections.forEach((s) => { if (s.status === "writing" || s.status === "error") { s.status = "queued"; s.error = undefined; } });
  const slots = imageSlots(product);
  const pending = (): number[] => product.sections.map((s, i) => ({ s, i })).filter((x) => x.s.status === "queued").map((x) => x.i);
  const waves = Math.ceil(product.sections.length / waveSize);
  let wave = 0;
  for (;;) {
    abortIf(env);
    const todo = pending().slice(0, waveSize);
    if (!todo.length) break;
    wave++;
    // The introduction is written alone first so later sections can build on its voice.
    const batch = todo.includes(0) ? [0] : todo;
    await pool(batch, Math.min(env.concurrency ?? 2, batch.length), async (i) => {
      await writeSection(product, i, env, slots);
      const done = product.sections.filter((s) => s.status === "done");
      env.progress?.({ phase: "section", index: i, total: product.sections.length, words: done.reduce((n, s) => n + s.words, 0), wave, waves });
      await save(env, product);
    });
    updateRunningSummary(product);
    await save(env, product);
  }
  const failed = product.sections.filter((s) => s.status === "error").length;
  log(product, env, "manuscript", failed ? `${failed} section(s) need a retry` : "Manuscript complete");
  await save(env, product);
  return product;
}

/** Final lightweight check: flags repeated openings, short sections and unfinished blocks. No model call. */
export function qualityReport(product: Product): { issues: string[]; totalWords: number } {
  const issues: string[] = [];
  const openers = new Map<string, number>();
  for (const s of product.sections) {
    if (s.status !== "done") { issues.push(`"${s.title}" is not written yet.`); continue; }
    const first = s.blocks.find((b) => b.type === "paragraph");
    if (first && first.type === "paragraph") {
      const key = first.text.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
      openers.set(key, (openers.get(key) ?? 0) + 1);
    }
    const range = DEPTH_SPEC[product.custom.depth].words;
    if (s.kind === "chapter" && s.words < range[0] * 0.5) issues.push(`"${s.title}" is short (${s.words} words).`);
  }
  for (const [key, n] of openers) if (n > 1) issues.push(`${n} sections open with "${key}…".`);
  const text = product.sections.map((s) => blocksToMarkdown(s.blocks)).join(" ").toLowerCase();
  for (const phrase of ["in today's fast-paced world", "game-changer", "unlock your", "delve"]) if (text.includes(phrase)) issues.push(`Contains the cliché "${phrase}".`);
  return { issues, totalWords: product.sections.reduce((n, s) => n + s.words, 0) };
}

// ---------- Branding, charter, store ----------

const hex = (value: unknown, fallback: string): string => { const v = asString(value); return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback; };
const luminance = (color: string): number => { const n = parseInt(color.slice(1), 16); const f = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
export const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

export const FALLBACK_BRAND: Brand = { page: "#f6f1e9", type: "#2b2a27", accent: "#b5532f", tint: "#ead9c5", muted: "#6b6760", displayFont: "Merriweather", bodyFont: "Open Sans", style: "editorial, serif rules, flat", mood: "warm, calm, practical", coverPrompt: "" };

export function sanitizeBrand(raw: unknown): Brand {
  const r = asRecord(raw);
  const p = asRecord(r.palette);
  const brand: Brand = {
    page: hex(p.page, FALLBACK_BRAND.page), type: hex(p.type, FALLBACK_BRAND.type), accent: hex(p.accent, FALLBACK_BRAND.accent), tint: hex(p.tint, FALLBACK_BRAND.tint), muted: hex(p.muted, FALLBACK_BRAND.muted),
    displayFont: (FONT_ALLOWLIST as readonly string[]).includes(asString(r.displayFont)) ? asString(r.displayFont) : "Merriweather",
    bodyFont: (FONT_ALLOWLIST as readonly string[]).includes(asString(r.bodyFont)) ? asString(r.bodyFont) : "Open Sans",
    style: asString(r.style, FALLBACK_BRAND.style), mood: asString(r.mood, FALLBACK_BRAND.mood), coverPrompt: asString(r.coverPrompt),
  };
  // Text must stay readable: fall back to the safe palette when contrast is poor.
  if (contrast(brand.page, brand.type) < 7 || contrast(brand.page, brand.muted) < 3.2 || contrast(brand.page, brand.accent) < 3) return { ...FALLBACK_BRAND, displayFont: brand.displayFont, bodyFont: brand.bodyFont, style: brand.style, mood: brand.mood, coverPrompt: brand.coverPrompt };
  return brand;
}

export async function designBranding(product: Product, env: EngineEnv): Promise<Brand> {
  product.brand = await askJson(env, promptBranding(product), sanitizeBrand, 900).catch(() => ({ ...FALLBACK_BRAND }));
  log(product, env, "branding", `${product.brand.displayFont} / ${product.brand.bodyFont}, ${product.brand.style}`);
  await save(env, product);
  return product.brand;
}

export function buildCharter(product: Product): Charter {
  const o = product.outlines.find((x) => x.id === product.outlineId);
  const g = isSafeCategory(`${product.topic} ${product.pocket?.industry ?? ""}`);
  return {
    promise: o?.promise ?? product.pocket?.statement ?? "",
    audience: product.pocket?.niche ?? product.topic,
    outcome: o?.fromTo ?? "",
    structure: product.sections.map((s) => `${s.kind === "bonus" ? "Bonus" : s.kind === "intro" ? "Introduction" : s.kind === "conclusion" ? "Conclusion" : "Chapter"}: ${s.title}`),
    voice: product.custom.tone,
    guardrails: [...g.rules, "No invented statistics, studies or testimonials.", "Add your own real examples before you sell this."],
    nextSteps: ["Read the whole book once and replace any example that is not true to you.", "Add one real story or result from your own experience to each chapter.", "Export the PDF and EPUB and send a sample to three people in the audience.", "Publish the store page copy where you sell."],
  };
}

export async function buildStore(product: Product, env: EngineEnv): Promise<StoreCopy> {
  const fallback: StoreCopy = {
    headline: product.title, subhead: product.summary?.subtitle ?? "", bullets: product.summary?.learn ?? [], priceSuggestion: "Start around $12–19 and adjust after your first ten sales.", faq: [],
  };
  product.store = await askJson(env, promptStore(product), (raw) => {
    const r = asRecord(raw);
    const headline = asString(r.headline);
    if (!headline) throw new Error("store copy needs a headline");
    return { headline, subhead: asString(r.subhead), bullets: asArray(r.bullets).map((b) => asString(b)).filter(Boolean).slice(0, 6), priceSuggestion: asString(r.priceSuggestion, fallback.priceSuggestion),
      faq: asArray(r.faq).map(asRecord).map((f) => ({ q: asString(f.q), a: asString(f.a) })).filter((f) => f.q && f.a).slice(0, 5) };
  }, 1400).catch(() => fallback);
  product.charter = buildCharter(product);
  log(product, env, "store", "Charter and store page ready");
  await save(env, product);
  return product.store;
}

/** Fetch illustrations in the background; missing images are simply left out of the exports. */
export async function renderImages(product: Product, env: EngineEnv): Promise<number> {
  if (!env.image) return 0;
  const jobs = product.sections.flatMap((s) => s.blocks).filter((b): b is Extract<Block, { type: "image" }> => b.type === "image" && !b.assetId);
  let made = 0;
  await pool(jobs, 2, async (block) => {
    try {
      const got = await env.image?.(block.prompt, product.brand?.mood ?? "", env.signal);
      if (!got) return;
      const id = nextId(env, "img");
      product.images.push({ id, prompt: block.prompt, mime: got.mime, data: got.data });
      block.assetId = id;
      made++;
    } catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; }
  });
  if (made) { log(product, env, "images", `${made} illustration(s) generated`); await save(env, product); }
  return made;
}

/** One call for the Trending offers row. Callers fall back to built-in ideas when this fails. */
export async function ideasFromTrends(headlines: string[], env: EngineEnv): Promise<string[]> {
  return askJson(env, promptTrends(headlines), (raw) => {
    const ideas = asArray(asRecord(raw).ideas ?? raw).map((x) => asString(x)).filter((x) => x.length > 4).slice(0, 8);
    if (ideas.length < 3) throw new Error("too few ideas");
    return ideas;
  }, 700, 1);
}

export { brief };
