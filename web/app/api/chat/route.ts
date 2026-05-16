import { NextResponse } from "next/server";

import { generateText } from "ai";
import { generateAssistantText, resolveChatModel } from "@/lib/ai/generation-adapter";
import { requireSignedInApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { ConversationMemoryManager } from "@/lib/rag/conversation-memory";
import { conversationRepository, messageRepository, traceRepository } from "@/lib/repositories/platform-repositories";
import { prepareChatTurn } from "@/lib/server/chat-turn";
import { createTraceId, createTraceRunId } from "@/lib/trace/trace";

export async function POST(request: Request) {
  try {
    // Chat 入口第一道门：先确认登录身份，再确认租户边界，避免未授权请求进入编排链。
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const body = (await request.json().catch(() => ({}))) as { message?: string; conversationId?: string };
    const rawMessage = body.message?.trim();

    // 参数合法性先挡住；没有用户消息就没有后续 RAG/生成意义。
    if (!rawMessage) {
      return NextResponse.json(
        {
          code: "BAD_REQUEST",
          message: "`message` is required."
        },
        { status: 400 }
      );
    }

    // 每轮 chat 都创建独立 trace/run，后续 retrieval、tool、generation 都挂到这次运行上。
    const traceId = createTraceId("chat");
    const runId = createTraceRunId(traceId);
    const runStartedAt = new Date().toISOString();
    // 已有 conversation 必须按 user + tenant/org 查，防止跨用户或跨租户读取会话。
    const conversation = body.conversationId
      ? conversationRepository.getByIdForUser(body.conversationId, user.userId, { tenantId: user.tenantId, orgId: user.orgId ?? null })
      : conversationRepository.create({
          title: "Untitled conversation",
          userId: user.userId,
          tenantId: user.tenantId,
          orgId: user.orgId ?? null
        });

    // conversationId 存在但不属于当前用户/租户时，也统一表现为不存在。
    if (!conversation) {
      return NextResponse.json(
        {
          code: "NOT_FOUND",
          message: "Conversation does not exist.",
          traceId
        },
        { status: 404 }
      );
    }

    // 控制面编排准备：读取历史、可见知识库，决定 retrieval/tool，并组装模型输入。
    const prepared = await prepareChatTurn({
      conversationId: conversation.conversationId,
      userId: conversation.userId,
      userRole: user.role,
      tenantId: user.tenantId,
      orgId: user.orgId ?? null,
      message: rawMessage,
      traceId
    });

    // 用户消息先落库：即使后续模型生成失败，本轮用户输入也不会丢。
    const userMessage = messageRepository.append({
      conversationId: conversation.conversationId,
      role: "user",
      content: rawMessage,
      metadata: {
        tenantId: user.tenantId,
        orgId: user.orgId ?? null,
        userId: user.userId
      }
    });

    try {
      // Agent loop 已在编排阶段生成答案，跳过二次模型调用。
      const generation = prepared.finalAnswerText
        ? { text: prepared.finalAnswerText, model: prepared.finalAnswerModel ?? "agent-loop" }
        : await generateAssistantText({ messages: prepared.messages });

      // assistant 消息不只存文本，也保留工具、检索边界和模型信息，便于回放与排障。
      const assistantMessage = messageRepository.append({
        conversationId: conversation.conversationId,
        role: "assistant",
        content: generation.text,
        metadata: {
          traceId,
          source: "ts-ai-sdk",
          toolCalls: prepared.toolCalls,
          retrievalBoundary: prepared.retrievalBoundary,
          generation: {
            provider: "ai-sdk",
            mode: "generateText",
            model: generation.model
          },
          tenantId: user.tenantId,
          orgId: user.orgId ?? null,
          userId: user.userId,
          ...prepared.metadata
        }
      });

      // 非阻塞增量摘要：旧轮次溢出时压缩新增部分，合并进已有摘要。
      setTimeout(async () => {
        try {
          const allMessages = messageRepository.listByConversationId(conversation.conversationId);
          const memory = new ConversationMemoryManager(
            conversation.summary ?? "",
            conversation.lastSummarizedMessageId ?? "",
            allMessages
          );
          if (!memory.needsSummarization()) return;

          const summaryInput = memory.buildIncrementalSummaryInput();
          if (!summaryInput) return;

          const result = await generateText({
            model: resolveChatModel(),
            messages: [{
              role: "system",
              content: "你是一个对话摘要器。将以下对话片段压缩为简短的中文摘要，保留关键事实和上下文。不超过200字。"
            }, {
              role: "user",
              content: `已有摘要：${summaryInput.existingSummary || "无"}\n\n新对话：\n${summaryInput.newMessages.map(m => `${m.role}: ${m.content}`).join("\n")}`
            }],
            temperature: 0.1,
            maxOutputTokens: 400,
          });
          const newSummary = summaryInput.existingSummary
            ? `${summaryInput.existingSummary}\n${result.text.trim()}`
            : result.text.trim();
          conversationRepository.updateSummary(conversation.conversationId, newSummary, assistantMessage.messageId);
        } catch {
          // 静默失败，下一轮继续尝试
        }
      }, 0);

      // 写入 orchestration 阶段 trace：记录 retrieval/tool/prompt 等编排过程。
      for (const stage of prepared.traceStages) {
        traceRepository.append({
          traceId,
          runId,
          conversationId: conversation.conversationId,
          stage: stage.stage,
          status: stage.status,
          metadata: stage.metadata
            ? {
                ...stage.metadata,
                tenantId: user.tenantId,
                orgId: user.orgId ?? null,
                userId: user.userId,
                role: user.role
              }
            : {
                tenantId: user.tenantId,
                orgId: user.orgId ?? null,
                userId: user.userId,
                role: user.role
              },
          scope: {
            tenantId: user.tenantId,
            orgId: user.orgId ?? null,
            userId: user.userId,
            role: user.role
          }
        });
      }

      // 单独记录模型生成完成，便于区分“编排成功但生成失败/变慢”等问题。
      traceRepository.append({
        traceId,
        runId,
        conversationId: conversation.conversationId,
        stage: "generation.completed",
        status: "succeeded",
        metadata: {
          provider: "ai-sdk",
          mode: "generateText",
          model: generation.model,
          outputLength: generation.text.length
        },
        scope: {
          tenantId: user.tenantId,
          orgId: user.orgId ?? null,
          userId: user.userId,
          role: user.role
        }
      });

      // 写 chat root node：把本轮 chat 的整体结果和关键计划摘要收口。
      traceRepository.append({
        traceId,
        runId,
        nodeId: `node:${traceId}:chat:root`,
        conversationId: conversation.conversationId,
        stage: "chat",
        status: "succeeded",
        startedAt: runStartedAt,
        finishedAt: new Date().toISOString(),
        metadata: {
          useRetrieval: prepared.plan.useRetrieval,
          useTools: prepared.plan.useTools
        },
        scope: {
          tenantId: user.tenantId,
          orgId: user.orgId ?? null,
          userId: user.userId,
          role: user.role
        }
      });

      // 返回回答的同时带回 traceId 和 plan，方便前端/admin 后续定位与解释。
      return NextResponse.json({
        traceId,
        conversation,
        userMessage,
        assistantMessage,
        plan: prepared.plan
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI generation failed.";
      // 生成失败也要落 trace，否则线上只看到 500，无法定位是哪轮 chat 出问题。
      traceRepository.append({
        traceId,
        runId,
        conversationId: conversation.conversationId,
        stage: "generation.failed",
        status: "failed",
        metadata: {
          provider: "ai-sdk",
          mode: "generateText",
          error: message
        },
        scope: {
          tenantId: user.tenantId,
          orgId: user.orgId ?? null,
          userId: user.userId,
          role: user.role
        }
      });

      // root node 也标失败，保证整轮 chat 的总状态和具体 generation 失败能关联起来。
      traceRepository.append({
        traceId,
        runId,
        nodeId: `node:${traceId}:chat:root`,
        conversationId: conversation.conversationId,
        stage: "chat",
        status: "failed",
        startedAt: runStartedAt,
        finishedAt: new Date().toISOString(),
        metadata: {
          useRetrieval: prepared.plan.useRetrieval,
          useTools: prepared.plan.useTools,
          error: message
        },
        scope: {
          tenantId: user.tenantId,
          orgId: user.orgId ?? null,
          userId: user.userId,
          role: user.role
        }
      });

      return NextResponse.json(
        {
          code: "AI_GENERATION_FAILED",
          message,
          traceId
        },
        { status: 500 }
      );
    }
  } catch (error) {
    // 外层只兜鉴权类错误和未知异常；鉴权错误会被统一转换成稳定 JSON。
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
