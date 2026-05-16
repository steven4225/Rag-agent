import type {
  EmbeddingResult,
  IngestionTaskCreateRequest,
  IngestionTaskStatus,
  IndexWriteResult,
  ParsedChunk,
  ParserResult,
  ProcessingTraceEvent
} from "@/lib/contracts";

type GoIngestionConfig = {
  baseUrl: string;
  createEndpoint: string;
  fallbackEnabled: boolean;
};

export class GoIngestionClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | null;

  constructor(input: { code: string; message: string; status: number; traceId?: string | null }) {
    super(input.message);
    this.name = "GoIngestionClientError";
    this.code = input.code;
    this.status = input.status;
    this.traceId = input.traceId ?? null;
  }
}

function parseBool(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

function ingestionConfig(): GoIngestionConfig {
  const baseUrl = process.env.GO_INGESTION_BASE_URL ?? "http://localhost:8090";
  return {
    baseUrl,
    createEndpoint: `${baseUrl}/internal/ingestion/tasks`,
    fallbackEnabled: parseBool(process.env.GO_INGESTION_FALLBACK_ENABLED, true)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function buildTraceEvent(
  payload: IngestionTaskCreateRequest,
  taskId: string,
  stage: ProcessingTraceEvent["stage"],
  status: ProcessingTraceEvent["status"],
  message: string,
  metadata: Record<string, unknown> = {}
): ProcessingTraceEvent {
  return {
    traceId: payload.traceId,
    taskId,
    stage,
    level: status === "failed" ? "error" : "info",
    status,
    message,
    timestamp: nowIso(),
    tenantId: payload.tenantId ?? null,
    orgId: payload.orgId ?? null,
    metadata
  };
}

function buildMockChunks(payload: IngestionTaskCreateRequest): ParsedChunk[] {
  const baseText = `Mock parsed content for ${payload.source.filename}. This freezes the parser and chunk contract before the real parser lands.`;
  const chunks = baseText.split(". ").filter(Boolean);

  return chunks.map((text, index) => ({
    chunkId: `${payload.documentId}_chunk_${index + 1}`,
    documentId: payload.documentId,
    chunkIndex: index,
    text,
    charCount: text.length,
    tokenCount: null,
    metadata: {
      sectionPath: ["mock"],
      startOffset: index * 100,
      endOffset: index * 100 + text.length,
      pageNumber: 1
    }
  }));
}

function buildMockParserResult(payload: IngestionTaskCreateRequest): ParserResult {
  const chunks = buildMockChunks(payload);
  const fullText = chunks.map((chunk) => chunk.text).join("\n\n");

  return {
    parserName: "ts-fallback-mock-parser",
    parserVersion: "phase1",
    status: "succeeded",
    warnings: ["Using TS fallback parser result because Go ingestion service is unavailable."],
    parsedDocument: {
      documentId: payload.documentId,
      title: payload.source.filename,
      mimeType: payload.source.mimeType,
      language: null,
      charCount: fullText.length,
      pageCount: 1,
      metadata: {
        sourceUri: payload.source.uri,
        fallback: true
      },
      content: {
        text: fullText,
        sections: [
          {
            sectionId: "mock-section-1",
            title: "Mock Section",
            level: 1,
            text: fullText
          }
        ]
      }
    },
    chunks,
    metrics: {
      parseDurationMs: 5,
      chunkDurationMs: 3
    },
    errorMessage: null
  };
}

function buildMockEmbeddingResult(payload: IngestionTaskCreateRequest, chunks: ParsedChunk[]): EmbeddingResult {
  const model = payload.executionPlan.embedding.model ?? "ts-fallback-mock-embedding";
  const dimensions = 8;

  return {
    status: "succeeded",
    model,
    source: "ts-fallback-embedding",
    vectorCount: chunks.length,
    dimensions,
    artifacts: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      vector: Array.from({ length: dimensions }, (_, index) => Number((((chunk.chunkIndex + 1) * (index + 3)) % 10) / 10)),
      dimensions,
      contentHash: `${chunk.chunkId}-${chunk.charCount}`,
      embeddingRef: `embed_${chunk.chunkId}`,
      source: "ts-fallback-embedding",
      metadata: {
        placeholder: true
      }
    })),
    errorMessage: null,
    metadata: {
      placeholder: true
    }
  };
}

function buildMockIndexWriteResult(
  payload: IngestionTaskCreateRequest,
  parserResult: ParserResult,
  embeddingResult: EmbeddingResult
): IndexWriteResult {
  const title = parserResult.parsedDocument?.title ?? payload.source.filename;
  const records = parserResult.chunks.map((chunk, index) => ({
    recordId: `${payload.knowledgeBaseId}::${chunk.chunkId}`,
    knowledgeBaseId: payload.knowledgeBaseId,
    documentId: payload.documentId,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    title,
    content: chunk.text,
    embeddingRef: embeddingResult.artifacts[index]?.embeddingRef ?? `embed_${chunk.chunkId}`,
    vector: embeddingResult.artifacts[index]?.vector ?? [],
    source: "ts-fallback-index-store",
    metadata: {
      placeholder: true,
      sectionPath: chunk.metadata.sectionPath
    }
  }));

  return {
    status: "succeeded",
    indexName: payload.executionPlan.indexing.indexName ?? payload.knowledgeBaseId,
    storeType: payload.executionPlan.indexing.storeType ?? "ts-fallback-store",
    source: "ts-fallback-index-store",
    operation: "upsert",
    recordCount: records.length,
    indexedChunkCount: records.length,
    skippedRecordCount: 0,
    replacedRecordCount: 0,
    deletedRecordCount: 0,
    records,
    errorMessage: null,
    metadata: {
      placeholder: true
    }
  };
}

function buildFallbackStatus(payload: IngestionTaskCreateRequest): IngestionTaskStatus {
  const taskId = `ingest_${Date.now()}`;
  const parserResult = buildMockParserResult(payload);
  const embeddingResult = payload.executionPlan.embedding.enabled
    ? buildMockEmbeddingResult(payload, parserResult.chunks)
    : null;
  const indexWriteResult =
    payload.executionPlan.indexing.enabled && embeddingResult
      ? buildMockIndexWriteResult(payload, parserResult, embeddingResult)
      : null;
  const createdAt = nowIso();
  const trace = [
    buildTraceEvent(payload, taskId, "task-created", "succeeded", "TS control plane created ingestion task.", {
      sourceType: payload.source.sourceType
    }),
    buildTraceEvent(payload, taskId, "accepted", "succeeded", "Mock Go ingestion adapter accepted task.", {
      adapter: "ts-fallback"
    }),
    buildTraceEvent(payload, taskId, "parsing", "succeeded", "Mock parser generated parsed document."),
    buildTraceEvent(payload, taskId, "chunking", "succeeded", "Mock chunker emitted chunk payloads.", {
      chunkCount: parserResult.chunks.length
    }),
    embeddingResult
      ? buildTraceEvent(payload, taskId, "embedding", "succeeded", "Mock embedding adapter generated deterministic placeholder vectors.", {
          vectorCount: embeddingResult.vectorCount,
          source: embeddingResult.source
        })
      : buildTraceEvent(payload, taskId, "embedding", "pending", "Embedding stage disabled by execution plan."),
    indexWriteResult
      ? buildTraceEvent(payload, taskId, "indexing", "succeeded", "Mock index store persisted placeholder records.", {
          recordCount: indexWriteResult.recordCount,
          source: indexWriteResult.source
        })
      : buildTraceEvent(payload, taskId, "indexing", "pending", "Indexing stage disabled by execution plan."),
    buildTraceEvent(payload, taskId, "completed", "succeeded", "Task reached succeeded status in fallback mode.")
  ];

  return {
    taskId,
    traceId: payload.traceId,
    knowledgeBaseId: payload.knowledgeBaseId,
    documentId: payload.documentId,
    requestedBy: payload.requestedBy,
    tenantId: payload.tenantId ?? null,
    orgId: payload.orgId ?? null,
    source: payload.source,
    status: "succeeded",
    currentStage: "completed",
    attemptCount: 1,
    maxAttempts: 1,
    retryable: false,
    nextRunAt: null,
    retryAfterSec: 0,
    failureReason: null,
    failureStage: null,
    createdAt,
    updatedAt: trace[trace.length - 1]?.timestamp ?? createdAt,
    startedAt: createdAt,
    finishedAt: trace[trace.length - 1]?.timestamp ?? createdAt,
    errorMessage: null,
    executionPlan: payload.executionPlan,
    parserResult,
    embeddingResult,
    indexWriteResult,
    chunks: parserResult.chunks,
    trace,
    metadata: {
      ...payload.metadata,
      tenantId: payload.tenantId ?? null,
      orgId: payload.orgId ?? null,
      executionBoundary: "ts-fallback",
      contractVersion: "embedding-indexing-boundary-phase1",
      idempotencyKey: payload.metadata?.idempotencyKey ?? `fallback-${taskId}`,
      indexOperation: indexWriteResult?.operation ?? "not-executed",
      embeddingSource: embeddingResult?.source ?? "not-executed",
      indexingSource: indexWriteResult?.source ?? "not-executed",
      indexedChunkCount: indexWriteResult?.indexedChunkCount ?? 0,
      indexedRecordCount: indexWriteResult?.recordCount ?? 0,
      skippedRecordCount: indexWriteResult?.skippedRecordCount ?? 0,
      replacedRecordCount: indexWriteResult?.replacedRecordCount ?? 0,
      retryable: false,
      failureStage: null,
      failureReason: null
    }
  };
}

export async function createGoIngestionTask(payload: IngestionTaskCreateRequest): Promise<IngestionTaskStatus> {
  const config = ingestionConfig();

  try {
    const response = await fetch(config.createEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const parsed = (await response.json().catch(() => null)) as
      | IngestionTaskStatus
      | { code?: string; message?: string; traceId?: string }
      | null;

    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message
        : `Go ingestion request failed with status ${response.status}`;
      const code = parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string"
        ? parsed.code
        : "GO_INGESTION_REQUEST_FAILED";
      const traceId =
        parsed && typeof parsed === "object" && "traceId" in parsed && typeof parsed.traceId === "string"
          ? parsed.traceId
          : payload.traceId;
      throw new GoIngestionClientError({
        code,
        message,
        status: response.status,
        traceId
      });
    }

    if (!parsed || typeof parsed !== "object" || !("taskId" in parsed) || !("traceId" in parsed) || !("source" in parsed)) {
      throw new GoIngestionClientError({
        code: "GO_INGESTION_BAD_RESPONSE",
        message: "Go ingestion response shape is invalid.",
        status: 502,
        traceId: payload.traceId
      });
    }

    return parsed;
  } catch (error) {
    if (!config.fallbackEnabled) {
      if (error instanceof GoIngestionClientError) {
        throw error;
      }
      throw new GoIngestionClientError({
        code: "GO_INGESTION_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Go ingestion request failed.",
        status: 502,
        traceId: payload.traceId
      });
    }

    try {
      return buildFallbackStatus(payload);
    } catch (fallbackError) {
      throw new GoIngestionClientError({
        code: "TS_FALLBACK_BUILD_FAILED",
        message: fallbackError instanceof Error ? fallbackError.message : "TS fallback ingestion failed.",
        status: 500,
        traceId: payload.traceId
      });
    }
  }
}

export async function getGoIngestionTask(taskId: string): Promise<IngestionTaskStatus | null> {
  const config = ingestionConfig();
  const response = await fetch(`${config.baseUrl}/internal/ingestion/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (response.status === 404) {
    return null;
  }

  const parsed = (await response.json().catch(() => null)) as
    | IngestionTaskStatus
    | { code?: string; message?: string; traceId?: string }
    | null;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message
        : `Go ingestion get request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (!parsed || typeof parsed !== "object" || !("taskId" in parsed) || !("traceId" in parsed) || !("source" in parsed)) {
    throw new Error("Go ingestion task response shape is invalid.");
  }

  return parsed;
}
