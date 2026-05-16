import type { TraceNodeType } from "@/lib/contracts";

export function createTraceId(prefix = "trace") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createTraceRunId(traceId: string) {
  return `run:${traceId}`;
}

export function createTraceNodeId(traceId: string, nodeType: TraceNodeType, uniqueSeed?: string) {
  const seed = uniqueSeed?.trim() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `node:${traceId}:${nodeType}:${seed}`;
}

function mapIngestionStage(stage: string): TraceNodeType {
  const normalized = stage.toLowerCase();
  if (normalized === "parsing") return "parser";
  if (normalized === "chunking") return "chunking";
  if (normalized === "embedding") return "embedding";
  if (normalized === "indexing") return "indexing";
  return "ingestion";
}

export function mapStageToNodeType(stage: string): TraceNodeType {
  if (stage === "chat") return "chat";
  if (stage.startsWith("rewrite")) return "rewrite";
  if (stage === "tool.plan") return "tool.plan";
  if (stage.startsWith("tool.runtime")) return "tool.runtime";
  if (stage === "retrieval.plan") return "retrieval.plan";
  if (stage === "retrieval.request" || stage === "retrieval.execute") return "retrieval.execute";
  if (stage === "context.assembly") return "context.assembly";
  if (stage === "prompt.assembly") return "prompt.assembly";
  if (stage.startsWith("ingestion:")) return mapIngestionStage(stage.slice("ingestion:".length));
  if (stage === "ingestion") return "ingestion";
  if (stage.startsWith("generation")) return "generation";
  return "other";
}

function chatRootNodeId(traceId: string) {
  return `node:${traceId}:chat:root`;
}

function ingestionRootNodeId(traceId: string) {
  return `node:${traceId}:ingestion:root`;
}

export function inferTraceParentNodeId(input: {
  traceId: string;
  stage: string;
  nodeType: TraceNodeType;
}): string | null {
  if (input.stage === "chat" || input.stage === "ingestion" || input.stage === "ingestion:task-created") return null;
  if (input.nodeType === "tool.runtime") return `node:${input.traceId}:tool.plan:single`;
  if (input.nodeType === "retrieval.execute") return `node:${input.traceId}:retrieval.plan:single`;
  if (
    input.nodeType === "rewrite" ||
    input.nodeType === "tool.plan" ||
    input.nodeType === "retrieval.plan" ||
    input.nodeType === "context.assembly" ||
    input.nodeType === "prompt.assembly" ||
    input.nodeType === "generation"
  ) {
    return chatRootNodeId(input.traceId);
  }
  if (input.nodeType === "parser" || input.nodeType === "chunking" || input.nodeType === "embedding" || input.nodeType === "indexing") {
    return ingestionRootNodeId(input.traceId);
  }
  if (input.nodeType === "ingestion") {
    return ingestionRootNodeId(input.traceId);
  }
  return null;
}

export function inferTraceNodeId(input: {
  traceId: string;
  stage: string;
  nodeType: TraceNodeType;
  metadata?: Record<string, unknown>;
}): string {
  if (input.stage === "chat") return chatRootNodeId(input.traceId);
  if (input.stage === "ingestion" || input.stage === "ingestion:task-created") return ingestionRootNodeId(input.traceId);
  if (input.stage === "rewrite.plan") return `node:${input.traceId}:rewrite:single`;
  if (input.stage === "tool.plan") return `node:${input.traceId}:tool.plan:single`;
  if (input.stage === "retrieval.plan") return `node:${input.traceId}:retrieval.plan:single`;
  if (input.stage === "retrieval.execute" || input.stage === "retrieval.request") return `node:${input.traceId}:retrieval.execute:single`;
  if (input.stage === "context.assembly") return `node:${input.traceId}:context.assembly:single`;
  if (input.stage === "prompt.assembly") return `node:${input.traceId}:prompt.assembly:single`;
  if (input.stage.startsWith("tool.runtime")) {
    const toolCallId = typeof input.metadata?.toolCallId === "string" ? input.metadata.toolCallId : null;
    return createTraceNodeId(input.traceId, input.nodeType, toolCallId ?? undefined);
  }
  if (input.stage.startsWith("ingestion:")) {
    return `node:${input.traceId}:${input.stage.slice("ingestion:".length)}:single`;
  }
  return createTraceNodeId(input.traceId, input.nodeType);
}

export function durationFromIso(startedAt?: string | null, finishedAt?: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  if (Number.isNaN(startMs) || Number.isNaN(finishMs) || finishMs < startMs) return null;
  return finishMs - startMs;
}
