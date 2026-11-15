export type EligibilityProvider = string;

import { FREE_CATALOG, IMPORTED_PROVIDERS, type CatalogModel } from "./free-catalog.generated";

/** The catalogue uses its own platform ids for two providers ULTRON names differently. */
const CATALOG_ALIAS: Record<string, string> = { google: "google_ai_studio", ollama: "ollama_cloud" };
const catalogByProvider = new Map<string, Map<string, CatalogModel>>();
for (const [platform, models] of Object.entries(FREE_CATALOG)) {
  const id = CATALOG_ALIAS[platform] ?? platform;
  catalogByProvider.set(id, new Map([...(catalogByProvider.get(id) ?? []), ...models.map((model): [string, CatalogModel] => [model.id, model])]));
}
const IMPORTED_IDS = new Set(IMPORTED_PROVIDERS.map((provider) => provider.id));

/** The published free-tier record for a model, when the freellmapi catalogue has one. */
export function catalogModel(provider: EligibilityProvider, id: string): CatalogModel | undefined {
  return catalogByProvider.get(provider)?.get(id);
}


export function freeModel(provider: EligibilityProvider, model: string): boolean {
  const id = model.toLowerCase();
  if (/(?:audio|tts|speech|transcri|live|realtime|bidi)/i.test(id)) return false;
  // Trial credits need a verified payment method and expire, so Cerebras is not zero-cost.
  if (provider === "cerebras") return false;
  if (provider === "openrouter") return id.endsWith(":free");
  // The freellmapi catalogue lists this exact model as free.
  if (catalogModel(provider, model)) return true;
  // Hugging Face: free signed-in quota across the router; stay on well-known open families.
  if (provider === "huggingface") return /(?:llama-3\.[13]|qwen3|qwen2\.5|gpt-oss|gemma|deepseek|mistral|phi-)/i.test(id);
  // NVIDIA NIM: the hosted catalog is free with developer credits.
  if (provider === "nvidia") return true;
  // Z.ai: only the GLM flash family is free.
  if (provider === "zhipu") return /^glm-4\.[5-9]v?-flash/i.test(id);
  // Ollama Cloud: the free plan covers its hosted models, within session caps.
  if (provider === "ollama_cloud") return true;
  if (provider === "groq") return /allam.*2.*7b|llama.?3[.-]1.*8b|llama.?3[.-]3.*70b|llama.?4.*scout|groq\/compound|gpt-oss-(120|20)b|qwen3-32b/.test(id);
  if (provider === "mistral") return /^(?:mistral|codestral|ministral|pixtral|magistral|devstral|open-mi[sx]tral)[-_]/.test(id);
  if (provider === "cohere") return /c4ai-aya-expanse-32b|command-a-03-2025|command-a-reasoning-08-2025|command-r-08-2024|command-r-plus-08-2024|command-r7b-12-2024|command-r7b-arabic-02-2025/.test(id);
  if (provider === "google_ai_studio") return /^gemini-(?:2\.5-(?:flash|flash-lite)|3(?:\.[678])?-flash|3\.5-flash(?:-lite)?|3-flash-preview|3\.1-flash-lite)/.test(id);
  // Imported community and regional gateways are free by selection; their models are discovered at key-verify time.
  if (IMPORTED_IDS.has(provider)) return true;
  return false;
}


const NON_CHAT_MODEL = /(?:audio|tts|speech|transcri|live|realtime|bidi|embed|moderation|rerank|whisper|image|guard|safety|reward|retriev|ocr|clip|translat|parse)/i;

/**
 * Models a key may be used with in Automatic mode. Project rule: Automatic only ever routes to models that the
 * free-tier policy marks eligible, never to a paid model because it is stronger. A model the user picks by hand is
 * not filtered here.
 */
export function automaticModels(provider: EligibilityProvider, models: string[], blocked: Record<string, string> | undefined): string[] {
  const now = Date.now();
  return models.filter((id) => !NON_CHAT_MODEL.test(id) && freeModel(provider, id) && Date.parse(blocked?.[id] ?? "1970-01-01") <= now);
}
