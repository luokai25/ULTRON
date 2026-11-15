import { catalogModel, type EligibilityProvider } from "./model-eligibility";

/**
 * Approximate free-tier ceilings per API key, used only to spread load and to keep a key out of rotation shortly
 * before its provider would refuse it. They are estimates (providers change free tiers without notice, and some
 * limits are per model or per account, not per key). The provider's own 429 stays the source of truth.
 *
 * Figures follow the public catalog in the MIT-licensed tashfeenahmed/freellmapi project (copyright (c) 2026
 * Tashfeen Ahmed) cross-checked against each provider's documentation where that was possible.
 */
export type FreeTierLimits = {
  /** Requests per minute, per key. */
  rpm?: number;
  /** Requests per UTC day, per key. */
  rpd?: number;
  /** Tokens per UTC day, per key. */
  tpd?: number;
  /** Rough free tokens per month for ONE account with this provider. */
  monthlyTokens: number;
  note: string;
};

export const FREE_TIER_LIMITS: Record<EligibilityProvider, FreeTierLimits> = {
  groq: { rpm: 30, rpd: 1000, tpd: 500_000, monthlyTokens: 15_000_000, note: "Per-model daily caps; the 70B models allow about 500k tokens a day." },
  openrouter: { rpm: 20, rpd: 200, monthlyTokens: 6_000_000, note: ":free models only; about 200 requests a day without account credit." },
  google_ai_studio: { rpm: 10, rpd: 250, monthlyTokens: 3_000_000, note: "Flash models; quotas change often and vary by model." },
  mistral: { rpm: 2, monthlyTokens: 50_000_000, note: "Experiment plan: a large monthly token pool shared across models, slow request rate." },
  cerebras: { rpm: 30, tpd: 1_000_000, monthlyTokens: 30_000_000, note: "Not used by Automatic (trial credits need a payment method)." },
  cohere: { rpm: 20, rpd: 33, monthlyTokens: 1_000_000, note: "Trial keys: about 1,000 calls a month." },
  nvidia: { rpm: 40, monthlyTokens: 5_000_000, note: "Evaluation access with a per-minute limit." },
  huggingface: { rpm: 10, monthlyTokens: 1_000_000, note: "Small monthly credit for signed-in accounts." },
  zhipu: { rpm: 10, tpd: 1_000_000, monthlyTokens: 30_000_000, note: "GLM flash models, about 1M tokens a day." },
  ollama_cloud: { rpm: 10, monthlyTokens: 5_000_000, note: "Free plan: one concurrent request and session caps." },
};

const UNKNOWN_LIMITS: FreeTierLimits = { monthlyTokens: 0, note: "Community gateway: free-tier limits are not published, so ULTRON relies on the provider's own responses." };

/**
 * Limits for one provider and model. A model the freellmapi catalogue lists brings its own published per-minute and
 * per-day caps, which replace the provider-wide defaults.
 */
export function limitsFor(provider: EligibilityProvider, model?: string): FreeTierLimits {
  const base = FREE_TIER_LIMITS[provider] ?? UNKNOWN_LIMITS;
  const listed = model ? catalogModel(provider, model) : undefined;
  if (!listed) return base;
  return {
    ...base,
    ...(listed.rpm_limit !== undefined ? { rpm: listed.rpm_limit } : {}),
    ...(listed.rpd_limit !== undefined ? { rpd: listed.rpd_limit } : {}),
    ...(listed.tpd_limit !== undefined ? { tpd: listed.tpd_limit } : {}),
  };
}

export type CapacityLine = { provider: EligibilityProvider; keys: number; monthlyTokens: number; note: string };
export type Capacity = { lines: CapacityLine[]; totalMonthlyTokens: number; excluded: EligibilityProvider[] };

/** Providers that Automatic never routes to, whatever keys are saved. */
export const NOT_AUTO_ROUTED: ReadonlySet<EligibilityProvider> = new Set<EligibilityProvider>(["cerebras"]);

/**
 * Estimated free tokens per month for the keys the owner has connected. Counted once per provider: free tiers are
 * normally per account, and the providers' terms ask for one account each, so ten keys from one provider are not
 * ten times the allowance. Excluded providers are listed but not counted.
 */
export function estimateFreeCapacity(connectedKeysByProvider: Partial<Record<EligibilityProvider, number>>): Capacity {
  const lines: CapacityLine[] = [];
  const excluded: EligibilityProvider[] = [];
  for (const [provider, keys] of Object.entries(connectedKeysByProvider)) {
    if (!keys || keys < 1) continue;
    if (NOT_AUTO_ROUTED.has(provider)) { excluded.push(provider); continue; }
    const limits = limitsFor(provider);
    lines.push({ provider, keys, monthlyTokens: limits.monthlyTokens, note: limits.note });
  }
  lines.sort((a, b) => b.monthlyTokens - a.monthlyTokens);
  return { lines, totalMonthlyTokens: lines.reduce((sum, line) => sum + line.monthlyTokens, 0), excluded };
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
