/**
 * RAGAS-style eval runner — pure rule-based, zero external LLM calls.
 *
 * Usage: npx tsx lib/eval/eval-runner.ts
 *
 * For each test case:
 *   1. Simulates retrieval against a local knowledge corpus
 *   2. Generates a simple answer from the retrieved evidence
 *   3. Computes faithfulness, answer-relevance, context-precision, context-recall
 *   4. Reports per-case and aggregate scores
 */

import { computeFaithfulness } from "./metrics/faithfulness";
import { computeAnswerRelevance } from "./metrics/answer-relevance";
import { computeContextPrecision } from "./metrics/context-precision";
import { computeContextRecall } from "./metrics/context-recall";
import { sampleCases } from "./sample-cases";
import type { EvalCaseResult, EvalMetrics, EvalRunResult } from "./types";

// ---------------------------------------------------------------------------
// Local knowledge corpus (mirrors ts-local-retrieval-adapter for offline eval)
// ---------------------------------------------------------------------------
type LocalChunk = { id: string; kbId: string; title: string; content: string };

const LOCAL_CORPUS: LocalChunk[] = [
  {
    id: "chunk_policy_leave",
    kbId: "kb_policy",
    title: "Leave Policy Overview",
    content:
      "Annual leave requests require manager approval and should be submitted three business days in advance.",
  },
  {
    id: "chunk_policy_payroll",
    kbId: "kb_policy",
    title: "Payroll and Benefits",
    content:
      "Payroll closes on the 25th of each month. Benefit enrollment changes take effect on the first day of the next month.",
  },
  {
    id: "chunk_ops_incident",
    kbId: "kb_ops",
    title: "Incident Response Runbook",
    content:
      "Priority 1 incidents require an incident commander, status updates every 15 minutes, and a follow-up review within 24 hours.",
  },
  {
    id: "chunk_ops_ticket",
    kbId: "kb_ops",
    title: "Ticket Triage SOP",
    content:
      "Support tickets should be routed by product area, urgency, and customer tier before escalation.",
  },
  {
    id: "chunk_product_release",
    kbId: "kb_product",
    title: "Release Readiness Checklist",
    content:
      "Release readiness requires QA signoff, rollout notes, rollback guidance, and stakeholder communication.",
  },
  {
    id: "chunk_product_roadmap",
    kbId: "kb_product",
    title: "Product Planning Notes",
    content:
      "Roadmap reviews prioritize customer demand, implementation cost, and dependencies across teams.",
  },
];

// ---------------------------------------------------------------------------
// Simple keyword-based retrieval (no external deps needed for eval)
// ---------------------------------------------------------------------------
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function retrieve(
  query: string,
  knowledgeBaseId: string | undefined,
  topK: number,
): string[] {
  const queryTerms = new Set(tokenize(query));
  const corpus =
    knowledgeBaseId != null
      ? LOCAL_CORPUS.filter((c) => c.kbId === knowledgeBaseId)
      : LOCAL_CORPUS;

  const scored = corpus.map((chunk) => {
    const text = `${chunk.title} ${chunk.content}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score++;
      if (chunk.title.toLowerCase().includes(term)) score += 0.5;
    }
    return { content: chunk.content, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((c) => c.score > 0).map((c) => c.content);
}

function generateAnswer(question: string, chunks: string[]): string {
  if (chunks.length === 0) {
    return "No relevant information found to answer this question.";
  }
  return `Based on available information: ${chunks.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------
function computeAggregate(results: EvalCaseResult[]): EvalMetrics {
  if (results.length === 0) {
    return { faithfulness: 0, answerRelevance: 0, contextPrecision: 0, contextRecall: 0 };
  }
  const sum = results.reduce(
    (acc, r) => ({
      faithfulness: acc.faithfulness + r.metrics.faithfulness,
      answerRelevance: acc.answerRelevance + r.metrics.answerRelevance,
      contextPrecision: acc.contextPrecision + r.metrics.contextPrecision,
      contextRecall: acc.contextRecall + r.metrics.contextRecall,
    }),
    { faithfulness: 0, answerRelevance: 0, contextPrecision: 0, contextRecall: 0 },
  );
  const n = results.length;
  return {
    faithfulness: sum.faithfulness / n,
    answerRelevance: sum.answerRelevance / n,
    contextPrecision: sum.contextPrecision / n,
    contextRecall: sum.contextRecall / n,
  };
}

function runEval(): EvalRunResult {
  const caseResults: EvalCaseResult[] = [];

  for (const testCase of sampleCases) {
    const startedAt = Date.now();

    // 1. Retrieve
    const retrievedChunks = retrieve(testCase.question, testCase.knowledgeBaseId, 6);

    // 2. Generate (simple template-based for eval — no LLM needed)
    const answer = generateAnswer(testCase.question, retrievedChunks);

    // 3. Compute metrics
    const faithfulness = computeFaithfulness(answer, testCase.groundTruthChunks);
    const answerRelevance = computeAnswerRelevance(testCase.question, answer);
    const contextPrecision = computeContextPrecision(retrievedChunks, testCase.groundTruthChunks);
    const contextRecall = computeContextRecall(retrievedChunks, testCase.groundTruthChunks);

    caseResults.push({
      caseId: testCase.id,
      question: testCase.question,
      answer,
      retrievedChunks,
      metrics: { faithfulness, answerRelevance, contextPrecision, contextRecall },
      durationMs: Date.now() - startedAt,
    });
  }

  const passedCases = caseResults.filter(
    (r) =>
      r.metrics.contextRecall >= 0.5 && r.metrics.answerRelevance >= 0.3,
  ).length;

  return {
    timestamp: new Date().toISOString(),
    totalCases: caseResults.length,
    passedCases,
    caseResults,
    aggregateMetrics: computeAggregate(caseResults),
  };
}

// ---------------------------------------------------------------------------
// Main entry point — runs when executed directly
// ---------------------------------------------------------------------------
const result = runEval();

console.log("\n========================================");
console.log("  RAG Evaluation Report");
console.log("========================================");
console.log(`Timestamp: ${result.timestamp}`);
console.log(`Cases:     ${result.totalCases} total, ${result.passedCases} passed`);
console.log("----------------------------------------");
console.log("Aggregate Metrics:");
console.log(`  Faithfulness:       ${(result.aggregateMetrics.faithfulness * 100).toFixed(1)}%`);
console.log(`  Answer Relevance:   ${(result.aggregateMetrics.answerRelevance * 100).toFixed(1)}%`);
console.log(`  Context Precision:  ${(result.aggregateMetrics.contextPrecision * 100).toFixed(1)}%`);
console.log(`  Context Recall:     ${(result.aggregateMetrics.contextRecall * 100).toFixed(1)}%`);
console.log("========================================\n");

for (const r of result.caseResults) {
  const pass =
    r.metrics.contextRecall >= 0.5 && r.metrics.answerRelevance >= 0.3 ? "PASS" : "FAIL";
  console.log(`[${pass}] ${r.caseId} (${r.durationMs}ms)`);
  console.log(`  Q: ${r.question}`);
  console.log(`  Retrieved: ${r.retrievedChunks.length} chunks`);
  console.log(`  Faith: ${(r.metrics.faithfulness * 100).toFixed(0)}%  Relevance: ${(r.metrics.answerRelevance * 100).toFixed(0)}%  Precision: ${(r.metrics.contextPrecision * 100).toFixed(0)}%  Recall: ${(r.metrics.contextRecall * 100).toFixed(0)}%`);
}

console.log();

// Fail CI if any case doesn't meet threshold
if (result.passedCases < result.totalCases) {
  process.exitCode = 1;
}
