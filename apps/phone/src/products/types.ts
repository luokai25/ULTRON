/** Data model for the AI digital products generator. Everything is stored on the device. */

export type ProductMode = "guided" | "creator";
export type BookFormat = "standard" | "cookbook" | "stepbystep";
export type Depth = "quick" | "complete" | "deep";

export type Direction = { id: string; title: string; category: string };

export type SubScores = { pain: number; worsening: number; purchasing: number; speed: number };

export type Pocket = {
  id: string;
  directionId: string;
  statement: string;
  industry: string;
  niche: string;
  knowledge: string;
  problem: string;
  scores: SubScores;
  overall: number;
  rationale: string;
  recommended?: boolean;
  evidence?: string[];
};

export type Outline = {
  id: string;
  label: "A" | "B" | "C";
  version: number;
  name: string;
  promise: string;
  fromTo: string;
  chapters: Array<{ title: string; purpose: string }>;
  feedback?: string;
  approved?: boolean;
};

export type VtmRow = { label: string; before: string; after: string };
export type VtmStage = { stage: string; goal: string; description: string };
export type Vtm = { rows: VtmRow[]; stages: VtmStage[] };

export type Customisation = {
  tone: string;
  notes: string;
  bookFormat: BookFormat;
  depth: Depth;
  imageCount: number;
  references: Array<{ name: string; text: string }>;
};

export type EbookSummary = {
  title: string;
  subtitle: string;
  about: string;
  learn: string[];
  glossary: Array<{ term: string; meaning: string }>;
  wordRange: [number, number];
  readingMinutes: number;
  bonuses: Array<{ title: string; kind: string }>;
};

export type SectionKind = "intro" | "chapter" | "conclusion" | "bonus";
export type SectionStatus = "queued" | "writing" | "done" | "error";

export type Block =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "callout"; label: string; text: string }
  | { type: "timeline"; title: string; steps: Array<{ when: string; name: string; tag: string; text: string }> }
  | { type: "checklist"; items: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "image"; prompt: string; assetId?: string };

export type Section = {
  id: string;
  position: number;
  kind: SectionKind;
  title: string;
  purpose: string;
  status: SectionStatus;
  words: number;
  blocks: Block[];
  error?: string;
};

export type Brand = {
  page: string; type: string; accent: string; tint: string; muted: string;
  displayFont: string; bodyFont: string; style: string; coverPrompt: string; mood: string;
};

export type StoreCopy = { headline: string; subhead: string; bullets: string[]; priceSuggestion: string; faq: Array<{ q: string; a: string }> };
export type Charter = { promise: string; audience: string; outcome: string; structure: string[]; voice: string; guardrails: string[]; nextSteps: string[] };

export type ImageAsset = { id: string; prompt: string; mime: string; data: string };

export type HistoryEvent = { at: string; step: string; note: string };

export type Product = {
  id: string;
  schema: 1;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: ProductMode;
  topic: string;
  creator?: { handle: string; notes: string; sources: Array<{ title: string; url: string }>; consent: boolean };
  research?: { query: string; notes: string; sources: Array<{ title: string; url: string; snippet: string }> };
  directions: Direction[];
  pockets: Pocket[];
  pocket?: Pocket;
  format?: "ebook" | "course" | "coaching";
  outlines: Outline[];
  outlineId?: string;
  custom: Customisation;
  vtm?: Vtm;
  summary?: EbookSummary;
  sections: Section[];
  brand?: Brand;
  charter?: Charter;
  store?: StoreCopy;
  images: ImageAsset[];
  stage: "discover" | "pockets" | "format" | "outline" | "customise" | "vtm" | "structure" | "manuscript" | "branding" | "done";
  runningSummary: string;
  history: HistoryEvent[];
  source: "tab" | "chat";
};

export const DEFAULT_CUSTOM: Customisation = {
  tone: "Warm, direct and practical. Short sentences. No hype, no guru language.",
  notes: "",
  bookFormat: "standard",
  depth: "complete",
  imageCount: 3,
  references: [],
};

export const DEPTH_SPEC: Record<Depth, { label: string; chapters: number; words: [number, number]; hint: string }> = {
  quick: { label: "Quick Guide", chapters: 5, words: [350, 600], hint: "The essentials, fast." },
  complete: { label: "Complete Guide", chapters: 7, words: [550, 900], hint: "The full picture, with examples for every key point." },
  deep: { label: "Deep Dive", chapters: 9, words: [800, 1300], hint: "Everything, in depth." },
};

export const BOOK_FORMATS: Record<BookFormat, { label: string; hint: string; rule: string }> = {
  standard: { label: "Standard Book", hint: "Chapters of prose with images.", rule: "Each chapter teaches one idea in prose, with examples, a callout and a short exercise." },
  cookbook: { label: "Cookbook", hint: "One recipe per chapter.", rule: "Each chapter is ONE recipe: a short intro, an ingredient checklist, numbered method steps as a timeline, and a tips callout." },
  stepbystep: { label: "Step-by-Step Guide", hint: "One tutorial per chapter.", rule: "Each chapter is ONE tutorial: what you will have at the end, what you need (checklist), numbered steps as a timeline, and a troubleshooting callout." },
};

export const FONT_ALLOWLIST = ["Merriweather", "Open Sans"] as const;
