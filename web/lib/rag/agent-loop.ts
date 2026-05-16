import { generateText, type ModelMessage } from "ai";
import { z } from "zod";

import { resolveChatModels, shouldUseLocalGeneration } from "@/lib/ai/generation-adapter";
import type { KnowledgeBaseReadModel, RetrievalBoundary, RetrievalChunk, ToolCall } from "@/lib/contracts";
import { executeMcpRuntime } from "@/lib/mcp/runtime";
import { listMcpTools } from "@/lib/mcp/registry";
import type { MCPPlannedToolCall } from "@/lib/mcp/types";
import { buildRetrievalRequest } from "@/lib/rag/planner";
import { buildRetrievalPlan } from "@/lib/rag/retrieval-planner";
import { buildRewritePlan } from "@/lib/rag/rewrite-planner";
import { buildToolPlan } from "@/lib/rag/tool-planner";
import { assembleContext } from "@/lib/rag/context-assembler";
import { assemblePrompt } from "@/lib/rag/prompt-assembler";
import type {
  AgentAction,
  AgentStep,
  AssembledContext,
  PromptArtifact,
  RagOrchestrationInput,
  RagOrchestrationResult,
  RetrievalPlan,
  RewritePlan
} from "@/lib/rag/types";
import { executeResolvedRetrieval } from "@/lib/retrieval/resolve-retrieval-adapter";
import { intentRepository, settingRepository, traceRepository } from "@/lib/repositories/platform-repositories";
import { estimateMessagesTokens, estimateTokens } from "@/lib/rag/token-budget";

const MAX_STEPS = 5;
const MAX_RETRIEVAL_ROUNDS = 3;
const MAX_LOOP_TOKENS = 4000;
const GROUNDING_TOKEN_BUDGET = 6000;

async function generateWithFallback<T>(
  models: string[],
  generate: (model: string) => Promise<T>,
): Promise<{ result: T; usedModel: string }> {
  let lastError: unknown;
  for (const model of models) {
    try {
      const result = await generate(model);
      return { result, usedModel: model };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function parseBool(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : defaultValue;
}

function buildRetrievalBoundary(
  useRetrieval: boolean,
  scope: { tenantId: string; orgId: string | null }
): RetrievalBoundary {
  const configuredAdapter = settingRepository.getValue(
    "retrieval.adapter",
    "ts-local-retrieval-adapter",
    scope
  );
  const defaultGoEnabled = configuredAdapter === "go-http-retrieval-adapter";
  const goEnabled = parseBool(process.env.GO_RETRIEVAL_ENABLED, defaultGoEnabled);
  const goEndpoint =
    settingRepository.getValue(
      "retrieval.goEndpoint",
      process.env.GO_RETRIEVAL_ENDPOINT,
      scope
    ) ?? "http://localhost:8090/internal/retrieval/search";
  return useRetrieval && goEnabled
    ? { mode: "go-executor", endpoint: goEndpoint }
    : { mode: "ts-local" };
}

const AGENT_SYSTEM_PROMPT = `You are a RAG agent. Your job is to gather evidence before answering.

Available tools:
- search_knowledge: Search knowledge bases for relevant documents. Use a clear, specific query.
- call_mcp_tool: Get live data from external tools.

Workflow:
1. If the user's question needs factual grounding, call search_knowledge first.
2. Review the results. If they're insufficient, try a different query formulation (max ${MAX_RETRIEVAL_ROUNDS} searches).
3. If real-time data is needed, call call_mcp_tool.
4. Once you have enough evidence, respond without calling any tools.

Rules:
- Answer ONLY based on the provided search results. Do NOT use your own knowledge to fill gaps.
- If the search results don't contain enough information to answer accurately, explicitly tell the user: "当前知识库暂未覆盖该问题" and suggest they rephrase or contact the knowledge base owner.
- If search returns results but they're only tangentially related, say so honestly rather than stretching the evidence.
- Prefer search over guessing.
- A single well-formulated search query is better than multiple sloppy ones.`;

// AI SDK v6 tool definitions — use plain schema objects to avoid Tool<never,never> inference issues
const searchKnowledgeTool = {
  description:
    "Search knowledge bases for documents relevant to the user's question. Returns ranked document chunks.",
  parameters: z.object({
    query: z.string().describe("The search query, phrased for optimal retrieval"),
  }),
};

const callMcpToolToolDef = {
  description: "Call an MCP tool to get live data or perform an action. Check the system prompt for available tools and their parameters.",
  parameters: z.object({
    toolName: z.string().describe("Name of the MCP tool to call"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments matching the tool's parameter schema — see system prompt for required params"),
  }),
};

type AgentLoopState = {
  steps: AgentStep[];
  accumulatedChunks: RetrievalChunk[];
  accumulatedToolCalls: ToolCall[];
  finalRewrite: RewritePlan | null;
  finalRetrieval: RetrievalPlan | null;
  retrievalRounds: number;
  retrievalSource: string;
  retrievalTrace: {
    boundaryMode: RetrievalBoundary["mode"];
    adapterId: string;
    fallbackReason: string | null;
  };
};

function createEmptyState(): AgentLoopState {
  return {
    steps: [],
    accumulatedChunks: [],
    accumulatedToolCalls: [],
    finalRewrite: null,
    finalRetrieval: null,
    retrievalRounds: 0,
    retrievalSource: "ts-no-retrieval",
    retrievalTrace: {
      boundaryMode: "ts-local",
      adapterId: "none",
      fallbackReason: null,
    },
  };
}

function recordStep(
  state: AgentLoopState,
  step: number,
  thought: string,
  action: AgentAction,
  observation: string,
  status: "succeeded" | "failed",
  durationMs: number,
) {
  state.steps.push({ step, thought, action, observation, status, durationMs });
}

async function executeSearch(
  state: AgentLoopState,
  query: string,
  input: {
    chat: RagOrchestrationInput;
    knowledgeBases: KnowledgeBaseReadModel[];
  },
): Promise<{ observation: string; chunks: RetrievalChunk[] }> {
  state.retrievalRounds += 1;

  const rewrite = buildRewritePlan({
    message: query,
    history: input.chat.history,
  });
  state.finalRewrite = rewrite;

  const toolPlan = buildToolPlan(query);
  const intents = intentRepository.listReadModel({
    tenantId: input.chat.tenantId,
    orgId: input.chat.orgId ?? null,
  });
  const retrieval = buildRetrievalPlan({
    message: query,
    rewrite,
    toolPlan,
    knowledgeBases: input.knowledgeBases,
    intents,
  });
  state.finalRetrieval = retrieval;

  if (!retrieval.shouldRetrieve) {
    return {
      observation: "No knowledge bases matched the query. The question may not require document retrieval.",
      chunks: [],
    };
  }

  const retrievalBoundary = buildRetrievalBoundary(true, {
    tenantId: input.chat.tenantId,
    orgId: input.chat.orgId,
  });

  const retrievalRequest = buildRetrievalRequest({
    traceId: input.chat.traceId,
    query: rewrite.rewrittenQuery,
    conversationId: input.chat.conversationId,
    userId: input.chat.userId,
    role: input.chat.userRole,
    tenantId: input.chat.tenantId,
    orgId: input.chat.orgId,
    knowledgeBaseIds: retrieval.selectedKnowledgeBaseIds,
    filters: retrieval.filters,
    topK: retrieval.topK,
  });

  const execution = await executeResolvedRetrieval(retrievalBoundary, {
    traceId: input.chat.traceId,
    request: retrievalRequest,
    rewrite,
    retrieval,
  });

  const chunks = execution.result.response.chunks;
  state.retrievalSource = execution.result.response.source;
  state.retrievalTrace = execution.trace;

  if (chunks.length === 0) {
    traceRepository.append({
      conversationId: input.chat.conversationId,
      stage: "retrieval.no-results",
      status: "succeeded",
      metadata: {
        query,
        rewrittenQuery: rewrite.rewrittenQuery,
        reason: "no chunks returned",
      },
    });
    return {
      observation: `Search for "${query}" returned no results. The knowledge base may not contain relevant information on this topic.`,
      chunks: [],
    };
  }

  const maxScore = chunks.reduce((max, c) => Math.max(max, c.score), 0);
  if (maxScore < 0.3) {
    traceRepository.append({
      conversationId: input.chat.conversationId,
      stage: "retrieval.low-quality",
      status: "succeeded",
      metadata: {
        query,
        rewrittenQuery: rewrite.rewrittenQuery,
        maxScore,
        chunkCount: chunks.length,
        reason: "all chunks below quality threshold",
      },
    });
  }

  const preview = chunks
    .slice(0, 3)
    .map((c, i) => `${i + 1}. [${c.title}] ${c.content.slice(0, 200)}... (score: ${c.score.toFixed(2)})`)
    .join("\n");

  return {
    observation: `Search returned ${chunks.length} results. Top matches:\n${preview}`,
    chunks,
  };
}

async function executeToolCall(
  state: AgentLoopState,
  toolName: string,
  args: Record<string, unknown>,
  chat: RagOrchestrationInput,
  onToolCallUpdate?: (update: {
    toolCallId: string;
    toolName: string;
    status: "queued" | "running" | "succeeded" | "failed";
    args: Record<string, unknown>;
    output?: unknown;
  }) => void,
): Promise<string> {
  const plannedCalls: MCPPlannedToolCall[] = [
    {
      toolCallId: `${chat.traceId}_agent_${toolName}_${state.steps.length}`,
      toolName,
      args,
    },
  ];

  const runtime = await executeMcpRuntime({
    plannedCalls,
    context: {
      traceId: chat.traceId,
      actor: {
        userId: chat.userId,
        role: chat.userRole,
        tenantId: chat.tenantId,
        orgId: chat.orgId,
      },
    },
    onUpdate: onToolCallUpdate,
  });

  state.accumulatedToolCalls.push(...runtime.toolCalls);

  const succeeded = runtime.toolCalls.filter((tc) => tc.status === "succeeded");
  const failed = runtime.toolCalls.filter((tc) => tc.status === "failed");

  const parts: string[] = [];
  if (succeeded.length > 0) {
    parts.push(
      succeeded
        .map((tc) => {
          const summary =
            typeof tc.output === "object" && tc.output && "summary" in tc.output
              ? String(tc.output.summary)
              : JSON.stringify(tc.output).slice(0, 300);
          return `${tc.toolName}: ${summary}`;
        })
        .join("\n")
    );
  }
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.map((tc) => tc.toolName).join(", ")}`);
  }
  return parts.join("\n") || `Tool ${toolName} executed but returned no output.`;
}

function trimConversationMessages(messages: ModelMessage[]): void {
  // Keep system + as many recent messages as fit in the loop token budget
  while (estimateMessagesTokens(messages) > MAX_LOOP_TOKENS && messages.length > 3) {
    messages.splice(1, 1);
  }
}

function describeTool(tool: { name: string; description: string; argsSchema: z.ZodTypeAny }): string {
  const params = describeZodSchema(tool.argsSchema);
  return `- ${tool.name}: ${tool.description}${params ? ` Params: ${params}` : ""}`;
}

function describeZodSchema(schema: z.ZodTypeAny): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inner: any = schema;
  if (inner._def?.typeName === "ZodDefault") {
    inner = inner._def.innerType;
  }
  if (inner._def?.typeName !== "ZodObject") return "";
  const shape = inner._def.shape as Record<string, z.ZodTypeAny> | undefined;
  if (!shape) return "";
  const entries = Object.entries(shape).map(([key, type]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defType = (type as any)._def?.typeName;
    const typeName = defType === "ZodString" ? "string"
      : defType === "ZodNumber" ? "number"
      : defType === "ZodBoolean" ? "boolean"
      : "unknown";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const optional = (type as any).isOptional?.() ? "?" : "";
    return `${key}${optional}: ${typeName}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function buildConversationMessages(chat: RagOrchestrationInput): ModelMessage[] {
  const tools = listMcpTools();
  const toolLines = tools.map((t) => describeTool(t));
  const toolSection = toolLines.length > 0
    ? `\n\nAvailable MCP tools (call via call_mcp_tool with toolName + args):\n${toolLines.join("\n")}`
    : "";

  const systemContent = (chat.summary
    ? `${AGENT_SYSTEM_PROMPT}\n\n${chat.summary}`
    : AGENT_SYSTEM_PROMPT) + toolSection;

  const messages: ModelMessage[] = [
    { role: "system", content: systemContent },
  ];

  for (const m of chat.history) {
    messages.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  messages.push({ role: "user", content: chat.message });

  return messages;
}

export type AgentLoopOutput = {
  orchestration: RagOrchestrationResult;
  finalAnswerText: string;
  finalAnswerModel: string;
  agentMessages: ModelMessage[];
};

export async function runAgentLoop(input: {
  chat: RagOrchestrationInput;
  knowledgeBases: KnowledgeBaseReadModel[];
  onToolCallUpdate?: (update: {
    toolCallId: string;
    toolName: string;
    status: "queued" | "running" | "succeeded" | "failed";
    args: Record<string, unknown>;
    output?: unknown;
  }) => void;
}): Promise<AgentLoopOutput> {
  const chat = input.chat;
  const models = resolveChatModels();
  const state = createEmptyState();
  const conversationMessages = buildConversationMessages(chat);

  // Main ReACT loop
  for (let stepNumber = 0; stepNumber < MAX_STEPS; stepNumber++) {
    const stepStart = Date.now();

    if (shouldUseLocalGeneration()) {
      const localText = `[Local debug] Agent loop step ${stepNumber + 1}: processed "${chat.message}". No remote model available.`;
      recordStep(
        state,
        stepNumber + 1,
        "Local debug mode — no LLM decision available",
        { type: "final_answer", reason: "local debug fallback" },
        localText,
        "succeeded",
        Date.now() - stepStart,
      );

      const finalContext = assembleContext({
        evidence: state.accumulatedChunks,
        toolCalls: state.accumulatedToolCalls,
      });
      const finalPrompt = assemblePrompt({
        scene: finalContext.scene,
        userMessage: chat.message,
        rewrittenQuery: state.finalRewrite?.rewrittenQuery ?? chat.message,
        kbContext: finalContext.kbContext,
        toolContext: finalContext.toolContext,
      });

      return {
        orchestration: buildOrchestrationResult(chat, state, finalContext, finalPrompt),
        finalAnswerText: localText,
        finalAnswerModel: "local-debug-generator",
        agentMessages: conversationMessages,
      };
    }

    let result;
    try {
      const fallbackResult = await generateWithFallback(models, (m) =>
        generateText({
          model: m,
          messages: conversationMessages,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: { search_knowledge: searchKnowledgeTool, call_mcp_tool: callMcpToolToolDef } as any,
          toolChoice: "auto",
          temperature: 0.2,
          maxOutputTokens: 4096,
        })
      );
      result = fallbackResult.result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordStep(
        state,
        stepNumber + 1,
        `Agent loop error at step ${stepNumber + 1}: ${errMsg}`,
        { type: "final_answer", reason: `generateText failed: ${errMsg}` },
        `Model call failed: ${errMsg}. Falling back to available evidence.`,
        "failed",
        Date.now() - stepStart,
      );
      break;
    }

    const thought = result.text?.trim() ?? "";

    // No tool calls — model is ready to answer
    if (!result.toolCalls || result.toolCalls.length === 0) {
      recordStep(
        state,
        stepNumber + 1,
        thought || "Evidence gathered, ready to answer",
        { type: "final_answer", reason: "sufficient evidence gathered" },
        `Agent decided to answer after ${stepNumber + 1} step(s)`,
        "succeeded",
        Date.now() - stepStart,
      );
      break;
    }

    // Process tool calls
    for (const tc of result.toolCalls) {
      let action: AgentAction;
      let observation: string;

      if (tc.toolName === "search_knowledge") {
        const toolInput = tc.input as { query?: string };
        const query = toolInput?.query ?? chat.message;

        if (state.retrievalRounds >= MAX_RETRIEVAL_ROUNDS) {
          observation = `Search skipped: maximum retrieval rounds (${MAX_RETRIEVAL_ROUNDS}) reached. You must answer with available evidence.`;
          action = { type: "search", query, reason: "blocked by round limit" };
        } else {
          const searchResult = await executeSearch(state, query, input);
          state.accumulatedChunks.push(...searchResult.chunks);
          observation = searchResult.observation;
          action = { type: "search", query, reason: thought || "searching for relevant evidence" };
        }
      } else if (tc.toolName === "call_mcp_tool") {
        const toolInput = tc.input as { toolName?: string; args?: Record<string, unknown> };
        const toolName = toolInput?.toolName ?? "";
        const toolArgs = toolInput?.args ?? {};
        observation = await executeToolCall(state, toolName, toolArgs, chat, input.onToolCallUpdate);
        action = { type: "call_tool", toolName, reason: thought || "calling MCP tool for live data" };
      } else {
        observation = `Unknown tool: ${tc.toolName}`;
        action = { type: "final_answer", reason: `unknown tool requested: ${tc.toolName}` };
      }

      recordStep(state, stepNumber + 1, thought, action, observation, "succeeded", Date.now() - stepStart);

      conversationMessages.push({
        role: "assistant",
        content: [
          ...(thought ? [{ type: "text" as const, text: thought }] : []),
          {
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          },
        ],
      } as ModelMessage);
      conversationMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: { type: "text" as const, value: observation },
          },
        ],
      } as ModelMessage);
    }

    trimConversationMessages(conversationMessages);
  }

  // Force final answer if loop exhausted without conclusion
  const lastStep = state.steps[state.steps.length - 1];
  if (lastStep && lastStep.action.type !== "final_answer") {
    recordStep(
      state,
      state.steps.length + 1,
      "Maximum steps reached",
      { type: "final_answer", reason: "max steps reached, generating answer with available evidence" },
      "Forcing final answer generation.",
      "succeeded",
      0,
    );
  }

  const finalContext = assembleContext({
    evidence: state.accumulatedChunks,
    toolCalls: state.accumulatedToolCalls,
  });
  const finalPrompt = assemblePrompt({
    scene: finalContext.scene,
    userMessage: chat.message,
    rewrittenQuery: state.finalRewrite?.rewrittenQuery ?? chat.message,
    kbContext: finalContext.kbContext,
    toolContext: finalContext.toolContext,
  });

  // Final generation with full grounding context (no tools)
  const finalMessages: ModelMessage[] = [];
  if (finalPrompt.systemPrompt.trim()) {
    finalMessages.push({ role: "system", content: finalPrompt.systemPrompt });
  }
  if (finalPrompt.sections.length > 0) {
    finalMessages.push({
      role: "system",
      content: `Grounding context for this answer:\n\n${finalPrompt.sections.join("\n\n")}`,
    });
  }
  for (const m of chat.history) {
    finalMessages.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  finalMessages.push({ role: "user", content: finalPrompt.userPrompt });

  // Trim grounding context if final messages exceed token budget
  if (estimateMessagesTokens(finalMessages) > GROUNDING_TOKEN_BUDGET && finalMessages.length > 1) {
    const groundingMsg = finalMessages[1];
    if (typeof groundingMsg.content === "string") {
      let chars = groundingMsg.content.length;
      while (estimateTokens(groundingMsg.content.slice(0, chars)) > 2000 && chars > 100) {
        chars = Math.floor(chars * 0.8);
      }
      groundingMsg.content = groundingMsg.content.slice(0, chars) +
        "\n\n[Context truncated to fit model limits]";
    }
  }

  let finalAnswerText: string;
  let finalAnswerModel: string;

  if (shouldUseLocalGeneration()) {
    finalAnswerText = `[Local debug] Agent processed ${state.steps.length} step(s) with ${state.accumulatedChunks.length} evidence chunks and ${state.accumulatedToolCalls.length} tool call(s).`;
    finalAnswerModel = "local-debug-generator";
  } else {
    try {
      const { result: generation, usedModel } = await generateWithFallback(models, (m) =>
        generateText({
          model: m,
          messages: finalMessages,
          temperature: 0.2,
          maxOutputTokens: 4096,
        })
      );
      finalAnswerText = generation.text.trim();
      finalAnswerModel = usedModel;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      finalAnswerText =
        `I encountered an error while generating the answer. Based on the evidence I gathered:\n\n` +
        finalPrompt.sections.join("\n\n").slice(0, 1000) +
        `\n\nPlease try again or rephrase your question.`;
      finalAnswerModel = `fallback-after-error: ${errMsg}`;
    }
  }

  return {
    orchestration: buildOrchestrationResult(chat, state, finalContext, finalPrompt),
    finalAnswerText,
    finalAnswerModel,
    agentMessages: finalMessages,
  };
}

function buildOrchestrationResult(
  chat: RagOrchestrationInput,
  state: AgentLoopState,
  context: AssembledContext,
  prompt: PromptArtifact,
): RagOrchestrationResult {
  return {
    plan: {
      useRetrieval: state.accumulatedChunks.length > 0,
      useTools: state.accumulatedToolCalls.length > 0,
      retrievalReason:
        state.retrievalRounds > 0
          ? `Agent searched ${state.retrievalRounds} time(s) across ${state.steps.length} step(s)`
          : "Agent determined no retrieval was needed",
    },
    toolCalls: state.accumulatedToolCalls,
    retrievalBoundary: state.retrievalTrace.boundaryMode === "go-executor"
      ? { mode: "go-executor" as const }
      : { mode: "ts-local" as const },
    retrievalRequest: null,
    rewrite: state.finalRewrite ?? {
      strategy: "passthrough" as const,
      originalQuery: chat.message,
      rewrittenQuery: chat.message,
      subQueries: [chat.message],
      reasons: ["agent loop did not trigger rewrite"],
    },
    retrieval: state.finalRetrieval ?? {
      shouldRetrieve: false,
      mode: "ts-local" as const,
      reason: "agent loop did not trigger retrieval",
      topK: 6,
      selectedKnowledgeBaseIds: [],
      filters: {},
      knowledgeBaseReason: "",
    },
    context,
    prompt,
    retrievalSource: state.retrievalSource,
    retrievalExecution: state.retrievalTrace,
    traceStages: [],
    agentSteps: state.steps,
  };
}
