import type { RetrievalBoundary, RetrievalChunk, RetrievalRequest, ToolCall } from "@/lib/contracts";

export type RagHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type RewritePlan = {
  strategy: "passthrough" | "followup-merge" | "multi-query";
  originalQuery: string;
  rewrittenQuery: string;
  subQueries: string[];
  reasons: string[];
};

export type ToolPlan = {
  shouldUseTools: boolean;
  selectedToolIds: string[];
  reasons: string[];
};

export type RetrievalPlan = {
  shouldRetrieve: boolean;
  mode: RetrievalBoundary["mode"];
  reason: string;
  topK: number;
  selectedKnowledgeBaseIds: string[];
  filters: Record<string, unknown>;
  knowledgeBaseReason: string;
};

export type AssembledContext = {
  scene: "direct" | "kb" | "mcp" | "mixed";
  kbContext: string;
  toolContext: string;
  evidence: RetrievalChunk[];
};

export type PromptArtifact = {
  scene: AssembledContext["scene"];
  systemPrompt: string;
  userPrompt: string;
  sections: string[];
};

export type OrchestrationTraceStage = {
  stage: string;
  status: "pending" | "running" | "succeeded" | "failed";
  metadata: Record<string, unknown>;
};

export type RagOrchestrationInput = {
  traceId: string;
  conversationId: string;
  userId: string;
  userRole: "user" | "admin";
  tenantId: string;
  orgId: string | null;
  message: string;
  history: RagHistoryMessage[];
  /** Rolling summary of older turns (incremental, token-budgeted). */
  summary: string;
  /** Message id marking where the summary leaves off. */
  lastSummarizedMessageId: string;
};

export type AgentActionType = "search" | "call_tool" | "rewrite" | "final_answer";

export type AgentAction = {
  type: AgentActionType;
  toolName?: string;
  query?: string;
  knowledgeBaseIds?: string[];
  args?: Record<string, unknown>;
  reason: string;
};

export type AgentStep = {
  step: number;
  thought: string;
  action: AgentAction;
  observation: string;
  status: "succeeded" | "failed";
  durationMs: number;
};

export type RagOrchestrationResult = {
  plan: {
    useRetrieval: boolean;
    useTools: boolean;
    retrievalReason: string;
  };
  toolCalls: ToolCall[];
  retrievalBoundary: RetrievalBoundary;
  retrievalRequest: RetrievalRequest | null;
  rewrite: RewritePlan;
  retrieval: RetrievalPlan;
  context: AssembledContext;
  prompt: PromptArtifact;
  retrievalSource: string;
  retrievalExecution: {
    boundaryMode: RetrievalBoundary["mode"];
    adapterId: string;
    fallbackReason: string | null;
  };
  traceStages: OrchestrationTraceStage[];
  agentSteps: AgentStep[];
};
