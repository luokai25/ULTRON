/**
 * Detects "make me an ebook / digital product about X" in normal chat so Ultron can hand the job to the products tab
 * instead of writing a long answer inline. Conservative on purpose: explicit creation verbs plus a product noun.
 */
const NOUN = String.raw`(?:e-?books?|digital products?|info ?products?|guides?|playbooks?|workbooks?|cookbooks?|lead magnets?|digital downloads?)`;
const VERB = String.raw`(?:make|create|build|write|generate|produce|design|put together|draft)`;
const RE = new RegExp(String.raw`\b${VERB}\b[^.?!\n]{0,40}?\b${NOUN}\b(?:\s+(?:about|on|for|around|covering|that teaches?|to help)\s+(?<topic>[^.?!\n]{3,160}))?`, "i");
const CODE_TALK = /\b(function|script|code|class|regex|api|json|yaml|python|javascript|typescript|parse|parser|variable|compile|bug|repo|commit|endpoint)\b|\w\.(?:json|ya?ml|md|txt|py|js|ts|html|pdf)\b/i;
const QUESTION = /^\s*(?:how|what|why|can you explain|should i)\b/i;

export function detectProductIntent(message: string): { topic: string } | null {
  const text = message.trim();
  if (text.length < 8 || text.length > 600 || QUESTION.test(text) || CODE_TALK.test(text)) return null;
  const m = RE.exec(text);
  if (!m) return null;
  const topic = (m.groups?.topic ?? "").replace(/^(?:my|the|a|an)\s+/i, "").replace(/\s+(?:please|thanks|thank you)\.?$/i, "").trim();
  return { topic };
}
