/**
 * Faithfulness — does the answer only contain facts present in the evidence?
 *
 * Pure n-gram + entity overlap. No LLM calls.
 * Splits answer into claims (sentences), checks each claim against
 * the concatenated retrieved evidence.
 */
export function computeFaithfulness(answer: string, retrievedChunks: string[]): number {
  if (!answer.trim() || retrievedChunks.length === 0) {
    return 0;
  }

  const evidence = retrievedChunks.join(" ").toLowerCase();
  const claims = splitClaims(answer);

  if (claims.length === 0) {
    return 0;
  }

  let supportedClaims = 0;
  for (const claim of claims) {
    if (isClaimSupported(claim, evidence)) {
      supportedClaims++;
    }
  }

  return supportedClaims / claims.length;
}

function splitClaims(text: string): string[] {
  return text
    .split(/[.。!！?？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
}

function isClaimSupported(claim: string, evidence: string): boolean {
  const lowered = claim.toLowerCase();

  // Extract key n-grams (3-5 word sequences) and check if they appear in evidence
  const words = lowered.split(/\s+/);
  if (words.length <= 2) {
    // Short claim — check as substring
    return evidence.includes(lowered);
  }

  // Build 3-grams and check overlap
  const trigrams = buildNgrams(words, 3);
  if (trigrams.length === 0) {
    return evidence.includes(lowered);
  }

  let matched = 0;
  for (const gram of trigrams) {
    if (evidence.includes(gram)) {
      matched++;
    }
  }

  const overlapRatio = matched / trigrams.length;

  // Also check key entities (numbers, proper nouns) as fallback
  const entities = extractEntities(claim);
  let entityMatch = 0;
  if (entities.length > 0) {
    for (const entity of entities) {
      if (evidence.includes(entity.toLowerCase())) {
        entityMatch++;
      }
    }
    const entityRatio = entityMatch / entities.length;
    return Math.max(overlapRatio, entityRatio * 0.7) >= 0.3;
  }

  return overlapRatio >= 0.3;
}

function buildNgrams(words: string[], n: number): string[] {
  if (words.length < n) {
    return [words.join(" ")];
  }
  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(" "));
  }
  return ngrams;
}

function extractEntities(text: string): string[] {
  // Numbers and capitalized words as proxy for entities
  const matches = text.match(/\d+(?:\.\d+)?%?|[A-Z][a-z]+/g);
  return matches ?? [];
}
