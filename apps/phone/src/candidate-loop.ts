import { ProviderHttpError } from "./provider-adapters";

/**
 * Tries the ranked model candidates one after another until one answers. Pulled out of cloud-llm.ts so the rules can be tested
 * without a vault, a network or a browser: what to do with a 401, a 429, a timeout, a stream cut half-way, a reply with no text.
 */

export type LoopCandidate = { provider: string; key: { id: string }; model: string };
export type KeyOutcome = { outcome: "success" | "invalid" | "expired" | "rate_limited" | "transient" | "model_error"; error?: string; retryAfterMs?: number; tokens?: number; model?: string };

export type LoopDeps<C extends LoopCandidate> = {
  stream(candidate: C, onToken: (token: string | null) => void, signal: AbortSignal): Promise<string>;
  record(candidate: C, result: KeyOutcome): Promise<void>;
  noteRequest(id: string): void;
  noteTokens(id: string, tokens: number): void;
  providerName(provider: string): string;
};

export type LoopResult = { content: string | null; lastError: Error | null };

export async function runCandidates<C extends LoopCandidate>(
  candidates: readonly C[],
  o: { signal: AbortSignal; controller: AbortController; onToken: (token: string | null) => void; promptChars: number },
  deps: LoopDeps<C>,
): Promise<LoopResult> {
  const skippedKeys = new Set<string>();
  let lastError: Error | null = null;
  const silent: string[] = [];
  for (const candidate of candidates) {
    if (o.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    if (o.controller.signal.aborted) break;
    if (skippedKeys.has(candidate.key.id)) continue;
    let emitted = false;
    let content = "";
    deps.noteRequest(`${candidate.key.id}|${candidate.model}`);
    try {
      content = await deps.stream(candidate, (token) => { emitted = true; o.onToken(token); }, o.controller.signal);
    } catch (error) {
      if (o.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
      if (o.controller.signal.aborted) break;
      if (error instanceof ProviderHttpError) {
        const message = error.message;
        lastError = new Error(`${deps.providerName(candidate.provider)} HTTP ${error.status}: ${message.slice(0, 400)}`);
        const status = error.status;
        const outcome = status === 401 ? "invalid"
          : status === 403 ? (/model|only available/i.test(message) ? "model_error" : "expired")
          : status === 404 ? "model_error"
          : status === 429 ? "rate_limited"
          : status >= 500 || status === 408 ? "transient" : null;
        if (outcome) await deps.record(candidate, { outcome, error: message, retryAfterMs: error.retryAfterMs ?? 900_000, model: candidate.model }).catch(() => undefined);
        if (outcome === "invalid" || outcome === "expired" || outcome === "rate_limited") skippedKeys.add(candidate.key.id);
        if (![401, 403, 404, 429, 500, 502, 503, 504].includes(status)) throw lastError;
        continue;
      }
      const failed = error instanceof Error ? error : new Error("The provider request failed.");
      // Never splice another provider's answer into text the user has already seen.
      if (emitted) throw failed;
      lastError = failed;
      await deps.record(candidate, { outcome: "transient", error: failed.message }).catch(() => undefined);
      continue;
    }
    if (!content.trim()) {
      // A model can answer with nothing: a reasoning model that spent its whole token budget thinking, or a filtered reply. That says
      // nothing lasting about the key or the other models, so note it for this request only and try the next one.
      if (emitted) o.onToken(null);
      silent.push(`${deps.providerName(candidate.provider)} ${candidate.model}`);
      lastError = new Error(`No text came back from ${silent.join(", ")}.`);
      continue;
    }
    await deps.record(candidate, { outcome: "success", tokens: Math.max(1, Math.ceil(content.length / 4)) }).catch(() => undefined);
    deps.noteTokens(`${candidate.key.id}|${candidate.model}`, Math.ceil((o.promptChars + content.length) / 4));
    return { content: content.trim(), lastError };
  }
  return { content: null, lastError };
}
