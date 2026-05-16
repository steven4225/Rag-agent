import type { ModelMessage } from "ai";

import type { SessionRole } from "@/lib/auth/session";
import type { RetrievalBoundary, ToolCall } from "@/lib/contracts";
import { buildModelMessages } from "@/lib/ai/message-builder";
import { ConversationMemoryManager } from "@/lib/rag/conversation-memory";
import type { OrchestrationTraceStage } from "@/lib/rag/types";
import { runRagOrchestration } from "@/lib/rag/orchestrator";
import { conversationRepository, knowledgeRepository, messageRepository } from "@/lib/repositories/platform-repositories";

export type PreparedChatTurn = {
  plan: {
    useRetrieval: boolean;
    useTools: boolean;
    retrievalReason: string;
  };
  toolCalls: ToolCall[];
  retrievalBoundary: RetrievalBoundary;
  traceStages: OrchestrationTraceStage[];
  metadata: Record<string, unknown>;
  messages: ModelMessage[];
  finalAnswerText?: string;
  finalAnswerModel?: string;
};

export async function prepareChatTurn(input: {
  conversationId: string;
  userId: string;
  userRole: SessionRole;
  tenantId: string;
  orgId: string | null;
  message: string;
  traceId: string;
  onToolCallUpdate?: (update: {
    toolCallId: string;
    toolName: string;
    status: "queued" | "running" | "succeeded" | "failed";
    args: Record<string, unknown>;
    output?: unknown;
  }) => void;
}): Promise<PreparedChatTurn> {
  const allMessages = messageRepository.listByConversationId(input.conversationId);
  const history = allMessages.map((message) => ({
    role: message.role,
    content: message.content
  }));

  const conversation = conversationRepository.getById(input.conversationId);
  const memory = new ConversationMemoryManager(
    conversation?.summary ?? "",
    conversation?.lastSummarizedMessageId ?? "",
    allMessages
  );
  const ctx = memory.buildContext();

  const orchestration = await runRagOrchestration({
    chat: {
      conversationId: input.conversationId,
      userId: input.userId,
      userRole: input.userRole,
      tenantId: input.tenantId,
      orgId: input.orgId,
      message: input.message,
      traceId: input.traceId,
      history: ctx.recentMessages.length > 0
        ? ctx.recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
        : history.slice(-6),
      summary: ctx.summaryText,
      lastSummarizedMessageId: memory.lastSummarizedMessageId(),
    },
    knowledgeBases: knowledgeRepository.listReadModel({
      tenantId: input.tenantId,
      orgId: input.orgId
    }),
    onToolCallUpdate: input.onToolCallUpdate
  });

  return {
    plan: orchestration.plan,
    toolCalls: orchestration.toolCalls,
    retrievalBoundary: orchestration.retrievalBoundary,
    traceStages: orchestration.traceStages,
    metadata: {
      rewrite: orchestration.rewrite,
      retrievalPlan: orchestration.retrieval,
      retrievalRequest: orchestration.retrievalRequest,
      retrievalSource: orchestration.retrievalSource,
      fallbackReason: orchestration.retrievalExecution.fallbackReason,
      retrievalExecution: orchestration.retrievalExecution,
      prompt: orchestration.prompt,
      context: {
        scene: orchestration.context.scene,
        evidenceCount: orchestration.context.evidence.length
      }
    },
    messages: buildModelMessages({
      prompt: orchestration.prompt,
      history: ctx.recentMessages.length > 0
        ? ctx.recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }))
        : history.slice(-6),
      summary: ctx.summaryText || undefined,
    }),
    finalAnswerText: orchestration.finalAnswerText,
    finalAnswerModel: orchestration.finalAnswerModel,
  };
}
