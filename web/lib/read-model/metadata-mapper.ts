import type { Message, RetrievalBoundary, ToolCall } from "@/lib/contracts";

export type GenerationMetadata = {
  provider: string;
  mode: string;
  model: string;
};

export type UnifiedMessageMetadata = {
  retrievalBoundary: RetrievalBoundary | null;
  retrievalSource: string | null;
  fallbackReason: string | null;
  toolCalls: ToolCall[];
  generation: GenerationMetadata | null;
};

export function readUnifiedMessageMetadata(message: Message): UnifiedMessageMetadata {
  const rawBoundary = message.metadata?.retrievalBoundary;
  const rawToolCalls = message.metadata?.toolCalls;
  const rawGeneration = message.metadata?.generation;
  const rawRetrievalSource = message.metadata?.retrievalSource;
  const rawFallbackReason = message.metadata?.fallbackReason;

  const retrievalBoundary = rawBoundary && typeof rawBoundary === "object" ? (rawBoundary as RetrievalBoundary) : null;
  const toolCalls = Array.isArray(rawToolCalls) ? (rawToolCalls as ToolCall[]) : [];
  const generation =
    rawGeneration && typeof rawGeneration === "object"
      ? ({
          provider: String((rawGeneration as { provider?: unknown }).provider ?? "unknown"),
          mode: String((rawGeneration as { mode?: unknown }).mode ?? "unknown"),
          model: String((rawGeneration as { model?: unknown }).model ?? "unknown")
        } as GenerationMetadata)
      : null;

  return {
    retrievalBoundary,
    retrievalSource: typeof rawRetrievalSource === "string" ? rawRetrievalSource : null,
    fallbackReason: typeof rawFallbackReason === "string" ? rawFallbackReason : null,
    toolCalls,
    generation
  };
}
