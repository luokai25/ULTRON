/**
 * How hard a step is, so Automatic can match the model to the work.
 *
 * "deep"  : choosing a tool or filling its arguments from a schema. Mistakes cost a failed action, so the strongest free model goes first.
 * "light" : a tiny classification or rewrite. Any free model can do it, so the ordering is flattened and load spreads across keys
 *           instead of burning the best model's daily quota on trivia.
 * unset   : normal chat; the strongest model first, as before.
 */
export type Effort = "light" | "deep";

/** The task complexity (0-7) the router scores unlisted models with. Deep work counts as at least 4; light work as at most 1. */
export function effectiveComplexity(inferred: number, effort?: Effort): number {
  if (effort === "deep") return Math.max(inferred, 4);
  if (effort === "light") return Math.min(inferred, 1);
  return inferred;
}

/**
 * Score for a model the freellmapi catalogue lists. Its `rank` is an *intelligence rank*: 1 is the smartest and larger numbers are
 * weaker (upstream scores `tier - sqrt(rank)`, preferring the lower rank). So a lower rank must score higher.
 * The result spans roughly 650 (rank 30) to 1955 (rank 1), the same band the older formula used.
 */
export function catalogScore(rank: number, effort?: Effort): number {
  const strength = Math.max(0, 2000 - Math.max(1, rank) * 45);
  // Light work: keep the order but squeeze the spread, so the usage penalty (up to 400) can move traffic to fresher keys and models.
  return effort === "light" ? 1300 + (strength - 1300) * 0.35 : strength;
}
