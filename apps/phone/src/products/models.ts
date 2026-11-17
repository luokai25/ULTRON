import { getUltronCloudModels, streamUltronBrainChat } from "../cloud-llm";
import type { Completer, Msg } from "./engine";

/**
 * Which brain writes the product. "auto" uses every provider key the owner has saved (free tiers included) and falls back to
 * the on-device model when it is loaded. A specific cloud model or the local model can be pinned instead.
 */
export type ModelChoice = { kind: "auto" } | { kind: "cloud"; id: string; label: string } | { kind: "local" };

export type LocalRoute = {
  ready: () => boolean;
  label: () => string;
  generate: (messages: Msg[], maxTokens: number, onToken: (t: string) => void) => Promise<string>;
};

export type ModelOptionList = { cloud: Array<{ id: string; label: string; provider: string }>; localReady: boolean; localLabel: string; connectedKeys: number };

export async function listModelOptions(local: LocalRoute): Promise<ModelOptionList> {
  let cloud: ModelOptionList["cloud"] = [];
  try { cloud = (await getUltronCloudModels()).map((m) => ({ id: m.id, label: m.model_id, provider: m.provider_label })); } catch { /* no keys yet */ }
  return { cloud, localReady: local.ready(), localLabel: local.label(), connectedKeys: new Set(cloud.map((c) => c.provider)).size };
}

export const NO_MODEL_MESSAGE = "No model is ready. Add a free provider key under LLM API KEYS, or load an on-device model in Local models.";

export function describeChoice(choice: ModelChoice): string {
  return choice.kind === "auto" ? "Automatic" : choice.kind === "local" ? "On-device model" : choice.label;
}

export function createCompleter(choice: ModelChoice, local: LocalRoute): { complete: Completer; concurrency: number } {
  const viaCloud = async (modelId: string, messages: Msg[], maxTokens: number, signal: AbortSignal | undefined, onToken?: (t: string) => void): Promise<string> => {
    let streamed = "";
    const content = await streamUltronBrainChat(modelId, messages, maxTokens, signal ?? new AbortController().signal, (token) => {
      if (token === null) { streamed = ""; return; }
      streamed += token; onToken?.(token);
    });
    return content || streamed;
  };
  const viaLocal = (messages: Msg[], maxTokens: number, onToken?: (t: string) => void): Promise<string> => local.generate(messages, Math.min(maxTokens, 1536), (t) => onToken?.(t));

  if (choice.kind === "local") {
    return { concurrency: 1, complete: async (messages, o) => { if (!local.ready()) throw new Error("The on-device model is not loaded. Open Local models and load one."); return viaLocal(messages, o.maxTokens, o.onToken); } };
  }
  if (choice.kind === "cloud") return { concurrency: 2, complete: (messages, o) => viaCloud(choice.id, messages, o.maxTokens, o.signal, o.onToken) };
  return {
    concurrency: 2,
    complete: async (messages, o) => {
      try { return await viaCloud("", messages, o.maxTokens, o.signal, o.onToken); }
      catch (error) {
        if (o.signal?.aborted) throw error;
        if (local.ready()) return viaLocal(messages, o.maxTokens, o.onToken);
        const text = error instanceof Error ? error.message : "";
        throw new Error(/no .*(key|model)|add .*key|not connected/i.test(text) ? NO_MODEL_MESSAGE : text || NO_MODEL_MESSAGE);
      }
    },
  };
}
