/**
 * Reasoning models (Qwen3, DeepSeek-R1 and similar) print their chain of thought between <think> tags. That is for the model, not the
 * owner: it is removed from what is shown and saved. While a reply is still streaming, an unclosed <think> hides everything after it.
 */
const CLOSED = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const OPEN_TAIL = /<(think|thinking|reasoning)>[\s\S]*$/i;
const STRAY_CLOSE = /<\/(think|thinking|reasoning)>/gi;

export function stripThinking(text: string): string {
  if (!text || !/<\/?(think|thinking|reasoning)>/i.test(text)) return text;
  let out = text.replace(CLOSED, "").replace(OPEN_TAIL, "").replace(STRAY_CLOSE, "");
  // Some models emit only a closing tag after hidden reasoning: keep what follows it.
  const lastClose = text.search(/<\/(think|thinking|reasoning)>(?![\s\S]*<\/(think|thinking|reasoning)>)/i);
  if (lastClose >= 0 && !/<(think|thinking|reasoning)>/i.test(text)) out = text.slice(lastClose).replace(STRAY_CLOSE, "");
  return out.replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
}

/** Like stripThinking, but never returns an empty string when the model only produced reasoning. */
export function visibleReply(text: string): string {
  const stripped = stripThinking(text);
  if (stripped.trim()) return stripped;
  return text.trim() ? text.replace(/<\/?(think|thinking|reasoning)>/gi, "").trim() : "";
}

/** Separates the model's reasoning from its answer. `open` is true while a <think> block has not closed yet (still streaming). */
export function splitThinking(text: string): { thought: string; answer: string; open: boolean } {
  if (!text || !/<\/?(think|thinking|reasoning)>/i.test(text)) return { thought: "", answer: text, open: false };
  const thoughts: string[] = [];
  let answer = text.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => { thoughts.push(inner.trim()); return ""; });
  let open = false;
  const tail = answer.match(/<(think|thinking|reasoning)>([\s\S]*)$/i);
  if (tail) { thoughts.push((tail[2] ?? "").trim()); answer = answer.slice(0, tail.index); open = true; }
  const lone = answer.match(/^([\s\S]*?)<\/(think|thinking|reasoning)>/i);
  if (lone && !/<(think|thinking|reasoning)>/i.test(text)) { thoughts.push((lone[1] ?? "").trim()); answer = answer.slice((lone[0] ?? "").length); }
  return { thought: thoughts.filter(Boolean).join("\n\n"), answer: answer.replace(/<\/?(think|thinking|reasoning)>/gi, "").replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n"), open };
}
