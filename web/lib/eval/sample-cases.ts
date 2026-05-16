/**
 * Sample eval test cases for the RAG system.
 *
 * Each case has a question and ground-truth chunks that a good retrieval
 * should return. These are used by the eval runner to measure precision/recall.
 */
import type { EvalTestCase } from "./types";

export const sampleCases: EvalTestCase[] = [
  {
    id: "leave-policy",
    question: "How do I request annual leave?",
    groundTruthChunks: [
      "Annual leave requests require manager approval and should be submitted three business days in advance.",
    ],
    knowledgeBaseId: "kb_policy",
  },
  {
    id: "payroll-timing",
    question: "When does payroll close each month?",
    groundTruthChunks: [
      "Payroll closes on the 25th of each month. Benefit enrollment changes take effect on the first day of the next month.",
    ],
    knowledgeBaseId: "kb_policy",
  },
  {
    id: "incident-priority",
    question: "What is the procedure for a priority 1 incident?",
    groundTruthChunks: [
      "Priority 1 incidents require an incident commander, status updates every 15 minutes, and a follow-up review within 24 hours.",
    ],
    knowledgeBaseId: "kb_ops",
  },
  {
    id: "release-checklist",
    question: "What is needed before a product release?",
    groundTruthChunks: [
      "Release readiness requires QA signoff, rollout notes, rollback guidance, and stakeholder communication.",
    ],
    knowledgeBaseId: "kb_product",
  },
  {
    id: "ticket-routing",
    question: "How should support tickets be handled?",
    groundTruthChunks: [
      "Support tickets should be routed by product area, urgency, and customer tier before escalation.",
    ],
    knowledgeBaseId: "kb_ops",
  },
];
