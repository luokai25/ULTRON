import { ideasFromTrends, type EngineEnv } from "./engine";
import { trendingHeadlines, type Http } from "./browser";

/** Ideas that work with no network and no model, shown until a daily refresh succeeds. */
export const SEED_IDEAS = [
  "Sleep better without pills", "A calm budget for one income", "Meal prep for busy parents", "Beginner running plan after 40",
  "Houseplant care that actually works", "Learn a language in 20 minutes a day", "Declutter a small home in a week", "Start freelancing without burning out",
];

const KEY = "ultron.products.trends.v1";
const todayKey = (): string => new Date().toISOString().slice(0, 10);

export function cachedTrendIdeas(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { date: string; ideas: string[] } | null; if (raw && Array.isArray(raw.ideas) && raw.ideas.length) return raw.ideas; } catch { /* ignore */ }
  return SEED_IDEAS;
}

export function trendsAreFresh(): boolean {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? "null") as { date: string } | null)?.date === todayKey(); } catch { return false; }
}

/** Refreshes once a day from public trend feeds; always resolves with something usable. */
export async function refreshTrendIdeas(http: Http, env: EngineEnv): Promise<string[]> {
  if (trendsAreFresh()) return cachedTrendIdeas();
  try {
    const headlines = await trendingHeadlines(http);
    if (headlines.length < 5) return cachedTrendIdeas();
    const ideas = await ideasFromTrends(headlines, env);
    try { localStorage.setItem(KEY, JSON.stringify({ date: todayKey(), ideas })); } catch { /* storage full: still return them */ }
    return ideas;
  } catch { return cachedTrendIdeas(); }
}
