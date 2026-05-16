/**
 * Context Recall — of the ground-truth chunks, how many were we able to retrieve?
 *
 * Computes: |retrieved ∩ groundTruth| / |groundTruth|
 * If no ground truth, returns 0.
 */
export function computeContextRecall(
  retrievedChunks: string[],
  groundTruthChunks: string[],
): number {
  if (groundTruthChunks.length === 0) {
    return 0;
  }

  let found = 0;
  for (const gt of groundTruthChunks) {
    if (isRetrieved(gt, retrievedChunks)) {
      found++;
    }
  }

  return found / groundTruthChunks.length;
}

function isRetrieved(groundTruth: string, retrieved: string[]): boolean {
  const gtLower = groundTruth.toLowerCase();
  for (const chunk of retrieved) {
    const chunkLower = chunk.toLowerCase();
    if (chunkLower.includes(gtLower) || gtLower.includes(chunkLower.slice(0, Math.min(200, chunkLower.length)))) {
      return true;
    }
    if (wordJaccard(chunkLower, gtLower) >= 0.3) {
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
