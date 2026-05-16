import { retrievalRequestSchema, type RetrievalRequest } from "@/lib/contracts";

export function buildRetrievalRequest(input: {
  traceId: string;
  query: string;
  conversationId?: string;
  userId?: string;
  role?: "user" | "admin";
  tenantId?: string | null;
  orgId?: string | null;
  knowledgeBaseIds?: string[];
  filters?: Record<string, unknown>;
  topK?: number;
}): RetrievalRequest {
  return retrievalRequestSchema.parse({
    traceId: input.traceId,
    query: input.query,
    conversationId: input.conversationId,
    userId: input.userId,
    role: input.role,
    tenantId: input.tenantId,
    orgId: input.orgId,
    knowledgeBaseIds: input.knowledgeBaseIds ?? [],
    topK: input.topK ?? 6,
    filters: input.filters ?? {}
  });
}
