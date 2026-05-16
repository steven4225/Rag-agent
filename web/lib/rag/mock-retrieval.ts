import type { RetrievalChunk, RetrievalResponse } from "@/lib/contracts";
import type { RetrievalPlan, RewritePlan } from "@/lib/rag/types";

type MockKnowledgeChunk = Omit<RetrievalChunk, "score" | "source" | "metadata"> & {
  terms: string[];
};

const MOCK_KNOWLEDGE: MockKnowledgeChunk[] = [
  {
    chunkId: "chunk_policy_leave",
    knowledgeBaseId: "kb_policy",
    documentId: "doc_policy_leave",
    title: "Leave Policy Overview",
    content: "Annual leave requests require manager approval and should be submitted three business days in advance.",
    terms: ["leave", "vacation", "policy", "annual leave", "manager approval"]
  },
  {
    chunkId: "chunk_policy_payroll",
    knowledgeBaseId: "kb_policy",
    documentId: "doc_policy_payroll",
    title: "Payroll and Benefits",
    content: "Payroll closes on the 25th of each month. Benefit enrollment changes take effect on the first day of the next month.",
    terms: ["payroll", "benefits", "salary", "policy", "enrollment"]
  },
  {
    chunkId: "chunk_ops_incident",
    knowledgeBaseId: "kb_ops",
    documentId: "doc_ops_incident",
    title: "Incident Response Runbook",
    content: "Priority 1 incidents require an incident commander, status updates every 15 minutes, and a follow-up review within 24 hours.",
    terms: ["incident", "p1", "support", "runbook", "sla"]
  },
  {
    chunkId: "chunk_ops_ticket",
    knowledgeBaseId: "kb_ops",
    documentId: "doc_ops_ticket",
    title: "Ticket Triage SOP",
    content: "Support tickets should be routed by product area, urgency, and customer tier before escalation.",
    terms: ["ticket", "support", "triage", "escalation", "ops"]
  },
  {
    chunkId: "chunk_product_release",
    knowledgeBaseId: "kb_product",
    documentId: "doc_product_release",
    title: "Release Readiness Checklist",
    content: "Release readiness requires QA signoff, rollout notes, rollback guidance, and stakeholder communication.",
    terms: ["release", "product", "feature", "roadmap", "rollout"]
  },
  {
    chunkId: "chunk_product_roadmap",
    knowledgeBaseId: "kb_product",
    documentId: "doc_product_roadmap",
    title: "Product Planning Notes",
    content: "Roadmap reviews prioritize customer demand, implementation cost, and dependencies across teams.",
    terms: ["roadmap", "product", "feature", "planning", "dependencies"]
  }
];

function scoreChunk(chunk: MockKnowledgeChunk, queryTerms: string[]) {
  const haystack = `${chunk.title} ${chunk.content} ${chunk.terms.join(" ")}`.toLowerCase();
  return queryTerms.reduce((score, term) => (haystack.includes(term) ? score + 1 : score), 0);
}

function extractTerms(rewrite: RewritePlan) {
  return rewrite.rewrittenQuery
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

export function executeLocalRetrieval(input: {
  traceId: string;
  rewrite: RewritePlan;
  retrieval: RetrievalPlan;
}): RetrievalResponse {
  const startedAt = Date.now();
  const queryTerms = extractTerms(input.rewrite);
  const visibleCorpus =
    input.retrieval.selectedKnowledgeBaseIds.length > 0
      ? MOCK_KNOWLEDGE.filter((chunk) => input.retrieval.selectedKnowledgeBaseIds.includes(chunk.knowledgeBaseId))
      : MOCK_KNOWLEDGE;

  const chunks = visibleCorpus
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(chunk, queryTerms),
      source: "ts-local-mock-retrieval",
      metadata: {}
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.retrieval.topK);

  return {
    traceId: input.traceId,
    chunks,
    timing: {
      totalMs: Date.now() - startedAt
    },
    source: "ts-local-mock-retrieval"
  };
}
