import { NextResponse } from "next/server";

import { streamAssistantText } from "@/lib/ai/generation-adapter";
import { requireSignedInApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { conversationRepository, messageRepository, traceRepository } from "@/lib/repositories/platform-repositories";
import { prepareChatTurn } from "@/lib/server/chat-turn";
import { createTraceId, createTraceRunId } from "@/lib/trace/trace";

type StreamEvent =
  | {
      type: "chat.started";
      traceId: string;
      conversation: unknown;
      userMessage: unknown;
    }
  | {
      type: "tool.call";
      traceId: string;
      toolCall: unknown;
    }
  | {
      type: "message.delta";
      traceId: string;
      delta: string;
    }
  | {
      type: "message.completed";
      traceId: string;
      assistantMessage: unknown;
    }
  | {
      type: "chat.completed";
      traceId: string;
      plan: unknown;
    }
  | {
      type: "chat.error";
      traceId: string;
      code: string;
      message: string;
    };

function toNdjson(event: StreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(request: Request) {
  let conversationId: string | null = null;

  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const body = (await request.json().catch(() => ({}))) as { message?: string; conversationId?: string };
    const rawMessage = body.message?.trim();
    const traceId = createTraceId("chat");
    const runId = createTraceRunId(traceId);
    const runStartedAt = new Date().toISOString();

    if (!rawMessage) {
      return NextResponse.json(
        {
          code: "BAD_REQUEST",
          message: "`message` is required.",
          traceId
        },
        { status: 400 }
      );
    }

    const conversation = body.conversationId
      ? conversationRepository.getByIdForUser(body.conversationId, user.userId, { tenantId: user.tenantId, orgId: user.orgId ?? null })
      : conversationRepository.create({
          title: "Untitled conversation",
          userId: user.userId,
          tenantId: user.tenantId,
          orgId: user.orgId ?? null
        });
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

    conversationId = conversation.conversationId;
    const toolCallUpdates: Array<{
      toolCallId: string;
      toolName: string;
      status: "queued" | "running" | "succeeded" | "failed";
      args: Record<string, unknown>;
      output?: unknown;
    }> = [];
    const prepared = await prepareChatTurn({
      conversationId: conversation.conversationId,
      userId: conversation.userId,
      userRole: user.role,
      tenantId: user.tenantId,
      orgId: user.orgId ?? null,
      message: rawMessage,
      traceId,
      onToolCallUpdate: (update) => {
        toolCallUpdates.push(update);
      }
    });

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

    const generation = streamAssistantText({
      messages: prepared.messages
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let assistantText = "";

        try {
          controller.enqueue(
            encoder.encode(
              toNdjson({
                type: "chat.started",
                traceId,
                conversation,
                userMessage
              })
            )
          );

          for (const toolCall of toolCallUpdates) {
            controller.enqueue(
              encoder.encode(
                toNdjson({
                  type: "tool.call",
                  traceId,
                  toolCall
                })
              )
            );
          }

          for await (const chunk of generation.result.textStream) {
            assistantText += chunk;
            controller.enqueue(
              encoder.encode(
                toNdjson({
                  type: "message.delta",
                  traceId,
                  delta: chunk
                })
              )
            );
          }

          const assistantMessage = messageRepository.append({
            conversationId: conversation.conversationId,
            role: "assistant",
            content: assistantText.trim(),
            metadata: {
              traceId,
              source: "ts-ai-sdk",
              toolCalls: prepared.toolCalls,
              retrievalBoundary: prepared.retrievalBoundary,
              generation: {
                provider: "ai-sdk",
                mode: "streamText",
                model: generation.model
              },
              tenantId: user.tenantId,
              orgId: user.orgId ?? null,
              userId: user.userId,
              ...prepared.metadata
            }
          });

          for (const stage of prepared.traceStages) {
            traceRepository.append({
              traceId,
              runId,
              conversationId: conversation.conversationId,
              stage: stage.stage,
              status: stage.status,
              metadata: {
                ...stage.metadata,
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

          traceRepository.append({
            traceId,
            runId,
            conversationId: conversation.conversationId,
            stage: "generation.completed",
            status: "succeeded",
            metadata: {
              provider: "ai-sdk",
              mode: "streamText",
              model: generation.model,
              outputLength: assistantText.trim().length
            },
            scope: {
              tenantId: user.tenantId,
              orgId: user.orgId ?? null,
              userId: user.userId,
              role: user.role
            }
          });

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

          controller.enqueue(
            encoder.encode(
              toNdjson({
                type: "message.completed",
                traceId,
                assistantMessage
              })
            )
          );

          controller.enqueue(
            encoder.encode(
              toNdjson({
                type: "chat.completed",
                traceId,
                plan: prepared.plan
              })
            )
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown stream error";
          traceRepository.append({
            traceId,
            runId,
            conversationId: conversation.conversationId,
            stage: "generation.failed",
            status: "failed",
            metadata: {
              provider: "ai-sdk",
              mode: "streamText",
              model: generation.model,
              error: message
            },
            scope: {
              tenantId: user.tenantId,
              orgId: user.orgId ?? null,
              userId: user.userId,
              role: user.role
            }
          });
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
          controller.enqueue(
            encoder.encode(
              toNdjson({
                type: "chat.error",
                traceId,
                code: "STREAM_ERROR",
                message
              })
            )
          );
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    const authResponse = toAuthErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      {
        code: "STREAM_PREPARATION_FAILED",
        message: error instanceof Error ? error.message : "Stream preparation failed.",
        conversationId
      },
      { status: 500 }
    );
  }
}
