/**
 * Context Precision — of the chunks we retrieved, how many are actually relevant?
 *
 * Computes: |retrieved ∩ groundTruth| / |retrieved|
 * If nothing retrieved, returns 0.
 */
export function computeContextPrecision(
  retrievedChunks: string[],
  groundTruthChunks: string[],
): number {
  if (retrievedChunks.length === 0) {
    return 0;
  }

  let relevant = 0;
  for (const retrieved of retrievedChunks) {
    if (isRelevant(retrieved, groundTruthChunks)) {
      relevant++;
    }
  }

  return relevant / retrievedChunks.length;
}

function isRelevant(chunk: string, groundTruth: string[]): boolean {
  const lowered = chunk.toLowerCase();
  for (const gt of groundTruth) {
    const gtLower = gt.toLowerCase();
    // Direct substring or significant n-gram overlap
    if (lowered.includes(gtLower) || gtLower.includes(lowered.slice(0, Math.min(200, lowered.length)))) {
      return true;
    }
    // Partial overlap via word-level Jaccard
    if (wordJaccard(lowered, gtLower) >= 0.3) {
      return true;
    }
  }
  return false;
}

function wordJaccard(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length >= 2));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length >= 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]);
  return intersection / union.size;
}
