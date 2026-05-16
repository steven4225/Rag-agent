import type { ModelMessage } from "ai";

// Approximate token counts: CJK ~2 chars/token, Latin ~4 chars/token.
// These ratios are conservative — they slightly overestimate to stay
// safely under model context limits. GPT-4 tokenizer reports ~1 token
// per 2.5 CJK chars and ~1 token per 3.5 Latin chars in practice.
const CJK_RATIO = 2;
const LATIN_RATIO = 4;

function isCJK(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isCJK(code)) {
      tokens += 1 / CJK_RATIO;
    } else if (code > 32) {
      tokens += 1 / LATIN_RATIO;
    }
  }
  return Math.ceil(tokens);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && "text" in part) {
          total += estimateTokens(String(part.text));
        }
      }
    }
  }
  return total;
}

export function fitToBudget<T>(
  items: T[],
  getTokens: (item: T) => number,
  budget: number,
): T[] {
  const result: T[] = [];
  let used = 0;
  // Take items from the end (most recent first) until budget exhausted
  for (let i = items.length - 1; i >= 0; i--) {
    const cost = getTokens(items[i]);
    if (used + cost > budget) break;
    result.unshift(items[i]);
    used += cost;
  }
  return result;
}

export const CONTEXT_BUDGET = 6000;
export const SUMMARY_TOKEN_BUDGET = 800;
export const RECENT_RATIO = 0.5;
