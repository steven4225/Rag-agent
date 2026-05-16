import type { AgentStep, AssembledContext, OrchestrationTraceStage, PromptArtifact, RetrievalPlan, RewritePlan, ToolPlan } from "@/lib/rag/types";
import type { RetrievalBoundary, RetrievalRequest, ToolCall } from "@/lib/contracts";

export function buildOrchestrationTrace(input: {
  rewrite: RewritePlan;
  toolPlan: ToolPlan;
  toolCalls: ToolCall[];
  toolRuntimeStages: OrchestrationTraceStage[];
  retrieval: RetrievalPlan;
  retrievalRequest: RetrievalRequest | null;
  retrievalBoundary: RetrievalBoundary;
  context: AssembledContext;
  prompt: PromptArtifact;
  retrievalSource: string;
  retrievalExecution: {
    boundaryMode: "ts-local" | "go-executor";
    adapterId: string;
    fallbackReason: string | null;
  };
  agentSteps?: AgentStep[];
}): OrchestrationTraceStage[] {
  const agentStepStages: OrchestrationTraceStage[] = (input.agentSteps ?? []).map((step) => ({
    stage: `agent.step.${step.step}`,
    status: step.status,
    metadata: {
      thought: step.thought,
      actionType: step.action.type,
      actionReason: step.action.reason,
      toolName: step.action.toolName,
      query: step.action.query,
      observationPreview: step.observation.slice(0, 500),
      durationMs: step.durationMs,
    },
  }));

  return [
    {
      stage: "agent.loop.start",
      status: "succeeded",
      metadata: {
        totalSteps: (input.agentSteps ?? []).length,
        hasAgentLoop: (input.agentSteps ?? []).length > 0,
      },
    },
    ...agentStepStages,
    {
      stage: "rewrite.plan",
      status: "succeeded",
      metadata: {
        strategy: input.rewrite.strategy,
        rewrittenQuery: input.rewrite.rewrittenQuery,
        subQueries: input.rewrite.subQueries
      }
    },
    {
      stage: "tool.plan",
      status: "succeeded",
      metadata: {
        shouldUseTools: input.toolPlan.shouldUseTools,
        selectedToolIds: input.toolPlan.selectedToolIds,
        toolCallCount: input.toolCalls.length
      }
    },
    ...input.toolRuntimeStages,
    {
      stage: "retrieval.plan",
      status: "succeeded",
      metadata: {
        shouldRetrieve: input.retrieval.shouldRetrieve,
        knowledgeBaseIds: input.retrieval.selectedKnowledgeBaseIds,
        reason: input.retrieval.reason,
        knowledgeBaseReason: input.retrieval.knowledgeBaseReason
      }
    },
    {
      stage: "retrieval.execute",
      status: "succeeded",
      metadata: {
        request: input.retrievalRequest,
        retrievalBoundary: input.retrievalBoundary,
        retrievalSource: input.retrievalSource,
        boundaryMode: input.retrievalExecution.boundaryMode,
        adapterId: input.retrievalExecution.adapterId,
        fallbackReason: input.retrievalExecution.fallbackReason
      }
    },
    {
      stage: "context.assembly",
      status: "succeeded",
      metadata: {
        scene: input.context.scene,
        evidenceCount: input.context.evidence.length,
        hasKbContext: Boolean(input.context.kbContext),
        hasToolContext: Boolean(input.context.toolContext)
      }
    },
    {
      stage: "prompt.assembly",
      status: "succeeded",
      metadata: {
        scene: input.prompt.scene,
        sectionCount: input.prompt.sections.length
      }
    }
  ];
}
