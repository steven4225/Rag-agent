import type { RagHistoryMessage, RewritePlan } from "@/lib/rag/types";
import { mappingRepository } from "@/lib/repositories/platform-repositories";

const FOLLOW_UP_PREFIXES = [
  "that",
  "this",
  "it",
  "those",
  "these",
  "they",
  "he",
  "she",
  "\u5176",
  "\u8FD9\u4E2A",
  "\u90A3\u4E2A",
  "\u8FD9\u4E9B",
  "\u90A3\u4E9B",
  "\u5B83",
  "\u5B83\u4EEC",
  "\u7EE7\u7EED",
  "\u518D",
  "\u987A\u4FBF",
  "continue",
  "also",
  "and"
];

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function splitIntoSubQueries(message: string) {
  return message
    .split(/[?\uFF1F!\uFF01;\uFF1B\n]+|(?:\s+and\s+)|(?:\s+also\s+)/i)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)
    .slice(0, 3);
}

function findLastUserTurn(history: RagHistoryMessage[]) {
  return [...history].reverse().find((item) => item.role === "user" && item.content.trim().length > 0) ?? null;
}

function looksLikeFollowUp(message: string) {
  const lowered = message.trim().toLowerCase();
  return FOLLOW_UP_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyEnabledMappings(originalQuery: string) {
  let rewritten = originalQuery;
  let replacementCount = 0;
  const reasons: string[] = [];

  const enabledMappings = mappingRepository
    .listReadModel()
    .filter((item) => item.enabled)
    .sort((left, right) => right.sourceTerm.length - left.sourceTerm.length);

  for (const mapping of enabledMappings) {
    const source = normalizeWhitespace(mapping.sourceTerm);
    const target = normalizeWhitespace(mapping.targetTerm);
    if (!source || !target) continue;

    const containsWordChars = /\w/.test(source);
    const pattern = containsWordChars
      ? new RegExp(`\\b${escapeRegex(source)}\\b`, "gi")
      : new RegExp(escapeRegex(source), "gi");

    rewritten = rewritten.replace(pattern, (matched) => {
      replacementCount += 1;
      const lowerMatched = matched.toLowerCase();
      if (lowerMatched === matched) return target.toLowerCase();
      if (matched.toUpperCase() === matched) return target.toUpperCase();
      return target;
    });
  }

  if (replacementCount > 0) {
    reasons.push(`query-term mappings normalized ${replacementCount} matched term(s) before retrieval planning`);
  }

  return {
    rewritten,
    reasons
  };
}

export function buildRewritePlan(input: {
  message: string;
  history: RagHistoryMessage[];
}): RewritePlan {
  const originalQuery = normalizeWhitespace(input.message);
  const mapped = applyEnabledMappings(originalQuery);
  const mappedQuery = normalizeWhitespace(mapped.rewritten);
  const subQueries = splitIntoSubQueries(mappedQuery);
  const reasons: string[] = [...mapped.reasons];

  if (looksLikeFollowUp(mappedQuery)) {
    const lastUserTurn = findLastUserTurn(input.history);
    if (lastUserTurn) {
      reasons.push("follow-up question merged with previous user turn for retrieval clarity");
      return {
        strategy: "followup-merge",
        originalQuery,
        rewrittenQuery: normalizeWhitespace(`${lastUserTurn.content}. ${mappedQuery}`),
        subQueries: subQueries.length > 0 ? subQueries : [mappedQuery],
        reasons
      };
    }
  }

  if (subQueries.length > 1) {
    reasons.push("question split into smaller sub-queries for retrieval planning");
    return {
      strategy: "multi-query",
      originalQuery,
      rewrittenQuery: subQueries.join(" ; "),
      subQueries,
      reasons
    };
  }

  reasons.push("query kept close to the original wording");
  return {
    strategy: "passthrough",
    originalQuery,
    rewrittenQuery: mappedQuery,
    subQueries: [mappedQuery],
    reasons
  };
}
