import type { KnowledgeBaseReadModel, RetrievalBoundary } from "@/lib/contracts";

import { runAgentLoop } from "@/lib/rag/agent-loop";
import { buildOrchestrationTrace } from "@/lib/rag/orchestration-trace";
import type { RagOrchestrationInput, RagOrchestrationResult } from "@/lib/rag/types";

export type AgentOrchestrationResult = RagOrchestrationResult & {
  finalAnswerText: string;
  finalAnswerModel: string;
};

export async function runRagOrchestration(input: {
  chat: RagOrchestrationInput;
  knowledgeBases: KnowledgeBaseReadModel[];
  onToolCallUpdate?: (update: {
    toolCallId: string;
    toolName: string;
    status: "queued" | "running" | "succeeded" | "failed";
    args: Record<string, unknown>;
    output?: unknown;
  }) => void;
}): Promise<AgentOrchestrationResult> {
  const loopOutput = await runAgentLoop(input);

  const traceStages = buildOrchestrationTrace({
    rewrite: loopOutput.orchestration.rewrite,
    toolPlan: {
      shouldUseTools: loopOutput.orchestration.toolCalls.length > 0,
      selectedToolIds: loopOutput.orchestration.toolCalls.map((tc) => tc.toolName),
      reasons: [],
    },
    toolCalls: loopOutput.orchestration.toolCalls,
    toolRuntimeStages: [],
    retrieval: loopOutput.orchestration.retrieval,
    retrievalRequest: loopOutput.orchestration.retrievalRequest,
    retrievalBoundary: loopOutput.orchestration.retrievalBoundary,
    context: loopOutput.orchestration.context,
    prompt: loopOutput.orchestration.prompt,
    retrievalSource: loopOutput.orchestration.retrievalSource,
    retrievalExecution: loopOutput.orchestration.retrievalExecution,
    agentSteps: loopOutput.orchestration.agentSteps,
  });

  return {
    ...loopOutput.orchestration,
    traceStages,
    finalAnswerText: loopOutput.finalAnswerText,
    finalAnswerModel: loopOutput.finalAnswerModel,
  };
}
