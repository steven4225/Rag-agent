import type {
  ChunkReadModel,
  DocumentDetailReadModel,
  DocumentReadModel,
  IngestionTaskStatus,
  KnowledgeBaseDocumentsReadModel,
  TraceRun,
  TraceStatus
} from "@/lib/contracts";
import {
  conversationRepository,
  ingestionRepository,
  knowledgeRepository,
  mappingRepository,
  messageRepository,
  readPlatformState,
  sampleQuestionRepository,
  settingRepository,
  traceRepository,
  userRepository
} from "@/lib/repositories/platform-repositories";
import { readUnifiedMessageMetadata } from "@/lib/read-model/metadata-mapper";

const DOCUMENT_TASK_SELECTION_STRATEGY = "latest-succeeded-else-latest-updated" as const;

type ReadModelScope = {
  tenantId: string;
  orgId: string | null;
};

function toTimestamp(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareTaskPriority(left: IngestionTaskStatus, right: IngestionTaskStatus) {
  const leftSucceededPriority = left.status === "succeeded" ? 0 : 1;
  const rightSucceededPriority = right.status === "succeeded" ? 0 : 1;
  if (leftSucceededPriority !== rightSucceededPriority) {
    return leftSucceededPriority - rightSucceededPriority;
  }

  const updatedDiff = toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return toTimestamp(right.createdAt) - toTimestamp(left.createdAt);
}

function pickDocumentTask(tasks: IngestionTaskStatus[]) {
  if (tasks.length === 0) return null;
  return tasks.slice().sort(compareTaskPriority)[0] ?? null;
}

function parseRequestMetadata(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const request = raw as {
    traceId?: unknown;
    knowledgeBaseIds?: unknown;
    filters?: unknown;
    tenantId?: unknown;
    orgId?: unknown;
  };
  const knowledgeBaseIds = Array.isArray(request.knowledgeBaseIds)
    ? request.knowledgeBaseIds.filter((item): item is string => typeof item === "string")
    : [];
  const filters = request.filters && typeof request.filters === "object" ? (request.filters as Record<string, unknown>) : {};
  return {
    traceId: typeof request.traceId === "string" ? request.traceId : null,
    knowledgeBaseIds,
    filters,
    tenantId: typeof request.tenantId === "string" ? request.tenantId : null,
    orgId: typeof request.orgId === "string" ? request.orgId : null
  };
}

function inScope(scope: ReadModelScope, payload: { tenantId: string | null; orgId: string | null }) {
  if (payload.tenantId !== scope.tenantId) return false;
  if (scope.orgId && payload.orgId !== scope.orgId) return false;
  return true;
}

function resolveDocumentRetrievalEvidence(knowledgeBaseId: string, documentId: string, scope: ReadModelScope) {
  const messages = readPlatformState().messages;
  let retrievalAnnotatedMessageCount = 0;
  let documentFilterHitCount = 0;
  let latestRetrievedAt: string | null = null;
  let latestRetrievedTraceId: string | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const parsedRequest = parseRequestMetadata(message.metadata?.retrievalRequest);
    if (!parsedRequest) continue;

    const metadataTenantId = typeof message.metadata?.tenantId === "string" ? message.metadata.tenantId : null;
    const metadataOrgId = typeof message.metadata?.orgId === "string" ? message.metadata.orgId : null;
    const requestScope = {
      tenantId: parsedRequest.tenantId ?? metadataTenantId,
      orgId: parsedRequest.orgId ?? metadataOrgId
    };

    if (!inScope(scope, requestScope)) continue;
    if (!parsedRequest.knowledgeBaseIds.includes(knowledgeBaseId)) continue;

    retrievalAnnotatedMessageCount += 1;

    const documentFilter = parsedRequest.filters.documentId;
    const hitsDocument = documentFilter === documentId;
    if (hitsDocument) {
      documentFilterHitCount += 1;
      if (!latestRetrievedAt || toTimestamp(message.createdAt) > toTimestamp(latestRetrievedAt)) {
        latestRetrievedAt = message.createdAt;
        latestRetrievedTraceId = parsedRequest.traceId;
      }
    }
  }

  return {
    retrievalAnnotatedMessageCount,
    documentFilterHitCount,
    latestRetrievedAt,
    latestRetrievedTraceId
  };
}

function parserStatus(task: IngestionTaskStatus): "succeeded" | "failed" | "pending" {
  if (task.parserResult?.status === "succeeded") return "succeeded";
  if (task.parserResult?.status === "failed") return "failed";
  return "pending";
}

function indexingStatus(task: IngestionTaskStatus): "succeeded" | "failed" | "pending" {
  if (task.indexWriteResult?.status === "succeeded") return "succeeded";
  if (task.indexWriteResult?.status === "failed") return "failed";
  return "pending";
}

function buildChunkReadModels(task: IngestionTaskStatus): ChunkReadModel[] {
  const indexRecordByChunkId = new Map((task.indexWriteResult?.records ?? []).map((record) => [record.chunkId, record]));

  return task.chunks
    .slice()
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map((chunk) => {
      const indexRecord = indexRecordByChunkId.get(chunk.chunkId) ?? null;
      const preview = chunk.text.length > 180 ? `${chunk.text.slice(0, 180)}...` : chunk.text;
      return {
        chunkId: chunk.chunkId,
        knowledgeBaseId: task.knowledgeBaseId,
        documentId: task.documentId,
        chunkIndex: chunk.chunkIndex,
        textPreview: preview,
        charCount: chunk.charCount,
        sectionPath: chunk.metadata.sectionPath,
        offsets: {
          startOffset: chunk.metadata.startOffset,
          endOffset: chunk.metadata.endOffset,
          pageNumber: chunk.metadata.pageNumber
        },
        source: {
          ingestionSourceType: task.source.sourceType,
          ingestionFilename: task.source.filename,
          indexRecordSource: indexRecord?.source ?? null
        },
        embeddingIndex: {
          indexed: indexRecord !== null,
          indexRecordId: indexRecord?.recordId ?? null,
          embeddingRef: indexRecord?.embeddingRef ?? null,
          vectorDimensions: indexRecord ? indexRecord.vector.length : null,
          indexName: task.indexWriteResult?.indexName ?? task.executionPlan.indexing.indexName,
          indexStoreType: task.indexWriteResult?.storeType ?? task.executionPlan.indexing.storeType,
          indexingSource: task.indexWriteResult?.source ?? null,
          indexOperation: task.indexWriteResult?.operation ?? null
        }
      };
    });
}

function buildDocumentReadModel(task: IngestionTaskStatus, scope: ReadModelScope): DocumentReadModel {
  const retrievalEvidence = resolveDocumentRetrievalEvidence(task.knowledgeBaseId, task.documentId, scope);
  return {
    knowledgeBaseId: task.knowledgeBaseId,
    documentId: task.documentId,
    title: task.parserResult?.parsedDocument?.title ?? task.source.filename,
    filename: task.source.filename,
    mimeType: task.source.mimeType,
    sourceType: task.source.sourceType,
    taskId: task.taskId,
    traceId: task.traceId,
    status: task.status,
    currentStage: task.currentStage,
    parserStatus: parserStatus(task),
    indexingStatus: indexingStatus(task),
    chunkCount: task.chunks.length,
    indexRecordCount: task.indexWriteResult?.recordCount ?? 0,
    retrievalEvidenceCount: retrievalEvidence.documentFilterHitCount,
    latestRetrievedAt: retrievalEvidence.latestRetrievedAt,
    latestRetrievedTraceId: retrievalEvidence.latestRetrievedTraceId,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt
  };
}

function resolveKnowledgeBase(knowledgeBaseId: string, scope: ReadModelScope) {
  const knowledgeBase =
    knowledgeRepository
      .listReadModel(scope)
      .find((item) => item.knowledgeBaseId === knowledgeBaseId) ?? null;
  if (knowledgeBase) return knowledgeBase;
  return {
    knowledgeBaseId,
    name: knowledgeBaseId,
    tenantId: scope.tenantId,
    orgId: scope.orgId,
    documentCount: 0,
    updatedAt: new Date(0).toISOString()
  };
}

export function buildDashboardReadModel(scope: ReadModelScope) {
  const conversations = conversationRepository.list(scope);
  const conversationIds = new Set(conversations.map((item) => item.conversationId));
  const traces = traceRepository.list(scope);
  const messages = readPlatformState().messages.filter((item) => conversationIds.has(item.conversationId));
  const knowledgeBases = knowledgeRepository.listReadModel(scope);
  const ingestionTasks = ingestionRepository.list(scope);

  let toolCallCount = 0;
  let generationCount = 0;
  let retrievalMessageCount = 0;

  for (const message of messages) {
    const metadata = readUnifiedMessageMetadata(message);
    toolCallCount += metadata.toolCalls.length;
    if (metadata.generation) generationCount += 1;
    if (metadata.retrievalBoundary || metadata.retrievalSource) retrievalMessageCount += 1;
  }

  const activeUsers = new Set(conversations.map((item) => item.userId)).size;

  return {
    phase: "phase2" as const,
    metrics: {
      activeUsers,
      conversations: conversations.length,
      messages: messages.length,
      traces: traces.length,
      generatedMessages: generationCount,
      retrievalAnnotatedMessages: retrievalMessageCount,
      toolCalls: toolCallCount,
      knowledgeBases: knowledgeBases.length,
      ingestionTasks: ingestionTasks.length,
      ingestionSucceeded: ingestionTasks.filter((t) => t.status === "succeeded").length,
      ingestionFailed: ingestionTasks.filter((t) => t.status === "failed").length,
      ingestionRunning: ingestionTasks.filter((t) => t.status === "running").length
    }
  };
}

export function buildKnowledgeReadModel(scope: ReadModelScope) {
  return {
    items: knowledgeRepository.listReadModel(scope)
  };
}

export function buildSettingReadModel(scope: ReadModelScope) {
  return {
    items: settingRepository.listReadModel(scope)
  };
}

export function buildMappingReadModel(scope: ReadModelScope) {
  return {
    items: mappingRepository.listReadModel(scope)
  };
}

export function buildSampleQuestionReadModel(scope: ReadModelScope) {
  return {
    items: sampleQuestionRepository.listReadModel(scope)
  };
}

export function buildUserReadModel(scope: ReadModelScope) {
  return {
    items: userRepository.listReadModel(scope)
  };
}

export function buildTraceReadModel(scope: ReadModelScope) {
  const traces = traceRepository.list(scope);
  const runMap = new Map<string, TraceRun>();

  const statusRank: Record<TraceStatus, number> = {
    failed: 5,
    cancelled: 4,
    running: 3,
    pending: 2,
    succeeded: 1
  };

  for (const trace of traces) {
    const runId = trace.runId ?? `run:${trace.traceId}`;
    const run = runMap.get(runId) ?? {
      runId,
      traceId: trace.traceId,
      conversationId: trace.conversationId ?? null,
      status: "succeeded",
      startedAt: trace.startedAt ?? null,
      finishedAt: trace.finishedAt ?? null,
      durationMs: trace.durationMs ?? null,
      metadata: {},
      nodes: []
    };

    const nodeStartedAt = trace.startedAt ?? null;
    const nodeFinishedAt = trace.finishedAt ?? null;
    const nodeDurationMs =
      trace.durationMs ??
      (nodeStartedAt && nodeFinishedAt
        ? Math.max(toTimestamp(nodeFinishedAt) - toTimestamp(nodeStartedAt), 0)
        : null);

    run.nodes.push({
      nodeId: trace.nodeId ?? `node:${trace.traceId}:${trace.stage}:${trace.startedAt ?? "na"}`,
      runId,
      traceId: trace.traceId,
      conversationId: trace.conversationId ?? null,
      stage: trace.stage,
      nodeType: trace.nodeType ?? "other",
      parentNodeId: trace.parentNodeId ?? null,
      status: trace.status,
      startedAt: nodeStartedAt,
      finishedAt: nodeFinishedAt,
      durationMs: nodeDurationMs,
      metadata: trace.metadata ?? {}
    });

    if (trace.conversationId && !run.conversationId) {
      run.conversationId = trace.conversationId;
    }
    if (run.startedAt === null || toTimestamp(trace.startedAt) < toTimestamp(run.startedAt)) {
      run.startedAt = trace.startedAt ?? run.startedAt;
    }
    if (run.finishedAt === null || toTimestamp(trace.finishedAt) > toTimestamp(run.finishedAt)) {
      run.finishedAt = trace.finishedAt ?? run.finishedAt;
    }
    if (statusRank[trace.status] > statusRank[run.status]) {
      run.status = trace.status;
    }

    run.metadata = {
      ...run.metadata,
      ...(trace.stage === "chat" || trace.stage === "ingestion" ? trace.metadata : {})
    };
    runMap.set(runId, run);
  }

  const items = Array.from(runMap.values())
    .map((run) => {
      run.nodes.sort((left, right) => toTimestamp(left.startedAt) - toTimestamp(right.startedAt));
      run.durationMs =
        run.startedAt && run.finishedAt ? Math.max(toTimestamp(run.finishedAt) - toTimestamp(run.startedAt), 0) : null;
      return run;
    })
    .sort((left, right) => toTimestamp(right.startedAt) - toTimestamp(left.startedAt));

  return {
    items,
    records: traces
  };
}

export function buildIngestionReadModel(scope: ReadModelScope) {
  const tasks = ingestionRepository.list(scope);

  return {
    items: tasks.map((task) => ({
      ...task,
      summary: {
        traceEvents: (task.trace ?? []).length,
        chunkCount: (task.chunks ?? []).length,
        parserReady: task.parserResult?.status === "succeeded",
        embeddingReady: task.embeddingResult?.status === "succeeded",
        indexingReady: task.indexWriteResult?.status === "succeeded",
        indexedChunkCount: task.indexWriteResult?.indexedChunkCount ?? 0,
        indexedRecordCount: task.indexWriteResult?.recordCount ?? 0,
        skippedRecordCount: task.indexWriteResult?.skippedRecordCount ?? 0,
        replacedRecordCount: task.indexWriteResult?.replacedRecordCount ?? 0,
        deletedRecordCount: task.indexWriteResult?.deletedRecordCount ?? 0,
        indexOperation:
          typeof task.indexWriteResult?.operation === "string"
            ? task.indexWriteResult.operation
            : typeof task.metadata?.indexOperation === "string"
              ? task.metadata.indexOperation
              : "unknown",
        idempotencyKey: typeof task.metadata?.idempotencyKey === "string" ? task.metadata.idempotencyKey : null,
        retryable: typeof task.metadata?.retryable === "boolean" ? task.metadata.retryable : null,
        failureStage: typeof task.metadata?.failureStage === "string" ? task.metadata.failureStage : null,
        failureReason: typeof task.metadata?.failureReason === "string" ? task.metadata.failureReason : null,
        executionSource:
          typeof task.metadata?.executionSource === "string" ? task.metadata.executionSource : "unknown"
      }
    }))
  };
}

export function buildKnowledgeBaseDocumentsReadModel(
  knowledgeBaseId: string,
  scope: ReadModelScope
): KnowledgeBaseDocumentsReadModel {
  const knowledgeBase = resolveKnowledgeBase(knowledgeBaseId, scope);
  const tasks = ingestionRepository.listByKnowledgeBaseId(knowledgeBaseId, scope);
  const grouped = new Map<string, IngestionTaskStatus[]>();

  for (const task of tasks) {
    const current = grouped.get(task.documentId) ?? [];
    current.push(task);
    grouped.set(task.documentId, current);
  }

  const items = Array.from(grouped.values())
    .map((taskGroup) => pickDocumentTask(taskGroup))
    .filter((task): task is IngestionTaskStatus => task !== null)
    .map((task) => buildDocumentReadModel(task, scope))
    .sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt));

  return {
    knowledgeBaseId,
    knowledgeBaseName: knowledgeBase.name,
    strategy: DOCUMENT_TASK_SELECTION_STRATEGY,
    items
  };
}

export function buildChunkReadModel(knowledgeBaseId: string, documentId: string, scope: ReadModelScope): ChunkReadModel[] {
  const tasks = ingestionRepository.listByDocumentId(knowledgeBaseId, documentId, scope);
  const selectedTask = pickDocumentTask(tasks);
  if (!selectedTask) return [];
  return buildChunkReadModels(selectedTask);
}

export function buildDocumentDetailReadModel(
  knowledgeBaseId: string,
  documentId: string,
  scope: ReadModelScope
): DocumentDetailReadModel | null {
  const knowledgeBase = resolveKnowledgeBase(knowledgeBaseId, scope);
  const tasks = ingestionRepository.listByDocumentId(knowledgeBaseId, documentId, scope);
  const selectedTask = pickDocumentTask(tasks);
  if (!selectedTask) return null;

  const chunks = buildChunkReadModels(selectedTask);
  const retrievalEvidence = resolveDocumentRetrievalEvidence(knowledgeBaseId, documentId, scope);

  return {
    knowledgeBaseId,
    knowledgeBaseName: knowledgeBase.name,
    strategy: DOCUMENT_TASK_SELECTION_STRATEGY,
    document: buildDocumentReadModel(selectedTask, scope),
    retrievalEvidence: {
      ...retrievalEvidence,
      evidenceChunkKeys: chunks.slice(0, 20).map((chunk) => ({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        knowledgeBaseId: chunk.knowledgeBaseId
      }))
    },
    chunks
  };
}

export function buildConversationReadModel(userId: string, scope: ReadModelScope) {
  return {
    items: conversationRepository.listByUserId(userId, scope)
  };
}

export function buildMessageReadModel(conversationId: string) {
  return {
    items: messageRepository.listByConversationId(conversationId)
  };
}
