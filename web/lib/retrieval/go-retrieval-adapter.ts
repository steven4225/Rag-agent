import type { RetrievalRequest, RetrievalResponse } from "@/lib/contracts";
import type { RetrievalAdapter, RetrievalExecutionInput, RetrievalExecutionResult } from "@/lib/retrieval/retrieval-adapter";

type GoRetrievalConfig = {
  endpoint: string;
};

function createGoRequestBody(request: RetrievalRequest) {
  return {
    traceId: request.traceId,
    query: request.query,
    conversationId: request.conversationId,
    userId: request.userId,
    role: request.role,
    tenantId: request.tenantId,
    orgId: request.orgId,
    knowledgeBaseIds: request.knowledgeBaseIds,
    topK: request.topK,
    filters: request.filters
  };
}

export class GoRetrievalAdapter implements RetrievalAdapter {
  readonly id = "go-http-retrieval-adapter";
  private readonly endpoint: string;

  constructor(config: GoRetrievalConfig) {
    this.endpoint = config.endpoint;
  }

  async execute(input: RetrievalExecutionInput): Promise<RetrievalExecutionResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(createGoRequestBody(input.request)),
      signal: AbortSignal.timeout(10_000)
    });

    const payload = (await response.json().catch(() => null)) as
      | RetrievalResponse
      | { code?: string; message?: string; traceId?: string }
      | null;

    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
          ? payload.message
          : `Go retrieval request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (!payload || typeof payload !== "object" || !("traceId" in payload) || !("chunks" in payload) || !("timing" in payload)) {
      throw new Error("Go retrieval response shape is invalid.");
    }

    return {
      response: {
        traceId: payload.traceId,
        chunks: payload.chunks,
        timing: payload.timing,
        source: typeof payload.source === "string" ? payload.source : this.id
      }
    };
  }
}
