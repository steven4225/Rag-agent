/**
 * Answer Relevance — does the answer actually address the question?
 *
 * Computes keyword coverage: what fraction of question keywords appear
 * in the answer, penalizing answers that go off-topic.
 */
export function computeAnswerRelevance(question: string, answer: string): number {
  if (!answer.trim() || !question.trim()) {
    return 0;
  }

  const questionKeywords = extractKeywords(question);
  if (questionKeywords.length === 0) {
    return 0.5; // neutral — can't assess
  }

  const answerLower = answer.toLowerCase();

  let matched = 0;
  for (const kw of questionKeywords) {
    if (answerLower.includes(kw)) {
      matched++;
    }
  }

  return matched / questionKeywords.length;
}

function extractKeywords(text: string): string[] {
  const lowered = text.toLowerCase();

  // Remove question words
  const cleaned = lowered.replace(
    /\b(what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|will|would|shall|should|may|might|the|a|an|in|on|at|to|for|of|with|by|from|and|or|but|not|this|that|these|those|it|its|be|been|being|have|has|had|请|怎么|如何|什么|为什么|哪里|哪个|多少|吗|呢|吧|的|了|在|是|有|和|与|或|不|也|都|就|要|会|能|可以|应该|需要|必须|已经|还|更|最)\b/g,
    " "
  );

  // Extract remaining words (2+ chars, alphanumeric or CJK)
  const words = cleaned.split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 2);

  // Deduplicate
  return [...new Set(words)];
}
