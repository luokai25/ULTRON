import type { Pocket, SubScores } from "./types";

/** Weighted overall score (fitted to the reference blueprint's visible data points; tune as needed). */
export const SCORE_WEIGHTS = { pain: 0.3, worsening: 0.25, purchasing: 0.3, speed: 0.15 } as const;

export function overallScore(s: SubScores): number {
  const raw = SCORE_WEIGHTS.pain * s.pain + SCORE_WEIGHTS.worsening * s.worsening + SCORE_WEIGHTS.purchasing * s.purchasing + SCORE_WEIGHTS.speed * s.speed;
  // Half-up with a tiny epsilon: 8.85 must round to 8.9 even though 8.85 * 10 is 88.4999… in floating point.
  return Math.round(raw * 10 + 1e-9) / 10;
}

/** Sort best first, mark the top pocket recommended. Ties keep the original order. */
export function rankPockets(pockets: Pocket[]): Pocket[] {
  const ranked = pockets
    .map((p, i) => ({ p: { ...p, overall: overallScore(p.scores), recommended: false }, i }))
    .sort((a, b) => b.p.overall - a.p.overall || a.i - b.i)
    .map((row) => row.p);
  if (ranked[0]) ranked[0] = { ...ranked[0], recommended: true };
  return ranked;
}

export const scoreTone = (overall: number): "high" | "mid" | "low" => (overall >= 8 ? "high" : overall >= 6.5 ? "mid" : "low");

export function isSafeCategory(text: string): { sensitive: boolean; rules: string[]; disclaimer: string } {
  const t = text.toLowerCase();
  const rules: string[] = [];
  let disclaimer = "";
  if (/\b(health|medical|symptom|diet|nutrition|fitness|injur|pain|sleep|pregnan|medicat|therapy|disease|vet|dog training|pet)\b/.test(t)) {
    rules.push("Health: give general education only, never diagnose, say when to see a doctor or vet, and flag mild versus urgent cases.");
    disclaimer = "This book is general education and is not medical, veterinary or professional advice. Talk to a qualified professional about your situation.";
  }
  if (/\b(money|budget|invest|debt|tax|finance|income|savings|retire|crypto|stock|loan|mortgage)\b/.test(t)) {
    rules.push("Money: no guaranteed returns, no specific security picks, explain trade-offs, and say results vary.");
    disclaimer = disclaimer || "This book is general education and is not financial, tax or legal advice. Results vary; consult a qualified professional.";
  }
  if (/\b(anxiety|depress|mental|trauma|grief|addiction|burnout|stress|relationship|marriage|divorce)\b/.test(t)) {
    rules.push("Mental health and relationships: be gentle, avoid clinical claims, and point to professional or crisis support when risk appears.");
    disclaimer = disclaimer || "This book is not a substitute for therapy or professional care. If you are in crisis, contact local emergency or crisis services.";
  }
  if (/\b(legal|law|contract|visa|immigration|lawsuit|custody)\b/.test(t)) {
    rules.push("Legal: general information only; laws differ by place; recommend a licensed professional for decisions.");
    disclaimer = disclaimer || "This book is general information and not legal advice. Laws differ by location.";
  }
  return { sensitive: rules.length > 0, rules, disclaimer };
}
