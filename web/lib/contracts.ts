import { z } from "zod";

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  traceId: z.string().optional()
});

export const conversationSchema = z.object({
  conversationId: z.string(),
  userId: z.string(),
  orgId: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null),
  title: z.string(),
  summary: z.string().default(""),
  lastSummarizedMessageId: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const messageSchema = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});

export const toolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  args: z.record(z.string(), z.unknown()).default({}),
  output: z.unknown().optional()
});

export const retrievalBoundarySchema = z.object({
  mode: z.enum(["ts-local", "go-executor"]),
  endpoint: z.string().optional()
});

export const ingestionTaskSchema = z.object({
  taskId: z.string(),
  traceId: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  knowledgeBaseId: z.string(),
  documentId: z.string().nullable(),
  errorMessage: z.string().nullable()
});

export const ingestionSourceSchema = z.object({
  sourceType: z.enum(["upload", "object-storage", "external-url", "knowledge-import"]),
  uri: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().nullable().default(null)
});

export const ingestionExecutionPlanSchema = z.object({
  parser: z.object({
    parserType: z.string().default("mock-parser"),
    mode: z.enum(["mock", "adapter", "native"]).default("mock")
  }),
  chunking: z.object({
    strategy: z.enum(["sentence", "paragraph", "markdown", "recursive", "semantic"]).default("paragraph"),
    targetSize: z.number().int().positive().default(1200),
    overlap: z.number().int().nonnegative().default(120)
  }),
  embedding: z.object({
    enabled: z.boolean().default(false),
    model: z.string().nullable().default(null),
    adapter: z.string().nullable().default(null)
  }),
  indexing: z.object({
    enabled: z.boolean().default(false),
    indexName: z.string().nullable().default(null),
    storeType: z.string().nullable().default(null)
  })
});

export const ingestionTaskCreateRequestSchema = z.object({
  traceId: z.string(),
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  requestedBy: z.string(),
  tenantId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  source: ingestionSourceSchema,
  executionPlan: ingestionExecutionPlanSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const parsedChunkSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  charCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative().nullable().default(null),
  metadata: z.object({
    sectionPath: z.array(z.string()).default([]),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    pageNumber: z.number().int().positive().nullable().default(null)
  })
});

export const embeddingInputSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  charCount: z.number().int().nonnegative(),
  contentHash: z.string(),
  metadata: parsedChunkSchema.shape.metadata,
  knowledgeRef: z.record(z.string(), z.unknown()).default({})
});

export const embeddingArtifactSchema = z.object({
  chunkId: z.string(),
  vector: z.array(z.number()).default([]),
  dimensions: z.number().int().nonnegative(),
  contentHash: z.string(),
  embeddingRef: z.string(),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const embeddingResultSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  model: z.string(),
  source: z.string(),
  vectorCount: z.number().int().nonnegative(),
  dimensions: z.number().int().nonnegative(),
  artifacts: z.array(embeddingArtifactSchema).default([]),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const indexRecordSchema = z.object({
  recordId: z.string(),
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  chunkId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  title: z.string(),
  content: z.string(),
  embeddingRef: z.string(),
  vector: z.array(z.number()).default([]),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const indexWriteResultSchema = z.object({
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  indexName: z.string(),
  storeType: z.string(),
  source: z.string(),
  operation: z.string().nullable().default(null),
  recordCount: z.number().int().nonnegative(),
  indexedChunkCount: z.number().int().nonnegative(),
  skippedRecordCount: z.number().int().nonnegative().default(0),
  replacedRecordCount: z.number().int().nonnegative().default(0),
  deletedRecordCount: z.number().int().nonnegative().default(0),
  records: z.array(indexRecordSchema).default([]),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const parsedDocumentSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  mimeType: z.string(),
  language: z.string().nullable().default(null),
  charCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  content: z.object({
    text: z.string(),
    sections: z.array(
      z.object({
        sectionId: z.string(),
        title: z.string(),
        level: z.number().int().positive(),
        text: z.string()
      })
    ).default([])
  })
});

export const parserResultSchema = z.object({
  parserName: z.string(),
  parserVersion: z.string(),
  status: z.enum(["succeeded", "failed"]),
  warnings: z.array(z.string()).default([]),
  parsedDocument: parsedDocumentSchema.nullable(),
  chunks: z.array(parsedChunkSchema).default([]),
  metrics: z.object({
    parseDurationMs: z.number().int().nonnegative(),
    chunkDurationMs: z.number().int().nonnegative()
  }),
  errorMessage: z.string().nullable().default(null)
});

export const processingTraceEventSchema = z.object({
  traceId: z.string(),
  taskId: z.string(),
  stage: z.enum([
    "task-created",
    "accepted",
    "queued",
    "worker-claimed",
    "parsing",
    "chunking",
    "embedding",
    "indexing",
    "completed",
    "failed",
    "retry-scheduled"
  ]),
  level: z.enum(["info", "warn", "error"]),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  message: z.string(),
  timestamp: z.string(),
  tenantId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const ingestionTaskStatusSchema = z.object({
  taskId: z.string(),
  traceId: z.string(),
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  requestedBy: z.string(),
  tenantId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  source: ingestionSourceSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  currentStage: z.enum(["queued", "parser", "chunker", "embedding", "indexing", "completed", "failed"]),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().default(3),
  retryable: z.boolean().default(false),
  nextRunAt: z.string().nullable().default(null),
  retryAfterSec: z.number().int().nonnegative().default(0),
  failureReason: z.string().nullable().default(null),
  failureStage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  executionPlan: ingestionExecutionPlanSchema,
  parserResult: parserResultSchema.nullable(),
  embeddingResult: embeddingResultSchema.nullable().default(null),
  indexWriteResult: indexWriteResultSchema.nullable().default(null),
  chunks: z.array(parsedChunkSchema).default([]),
  trace: z.array(processingTraceEventSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const retrievalRequestSchema = z.object({
  traceId: z.string(),
  query: z.string(),
  conversationId: z.string().optional(),
  userId: z.string().optional(),
  role: z.enum(["user", "admin"]).optional(),
  orgId: z.string().nullable().optional(),
  tenantId: z.string().nullable().optional(),
  knowledgeBaseIds: z.array(z.string()).default([]),
  topK: z.number().int().positive().max(20).default(6),
  filters: z.record(z.string(), z.unknown()).default({})
});

export const retrievalChunkSchema = z.object({
  chunkId: z.string(),
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  score: z.number(),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const retrievalResponseSchema = z.object({
  traceId: z.string(),
  chunks: z.array(retrievalChunkSchema),
  timing: z.object({
    totalMs: z.number().nonnegative()
  }),
  source: z.string()
});

export const traceNodeTypeSchema = z.enum([
  "chat",
  "rewrite",
  "tool.plan",
  "tool.runtime",
  "retrieval.plan",
  "retrieval.execute",
  "context.assembly",
  "prompt.assembly",
  "ingestion",
  "parser",
  "chunking",
  "embedding",
  "indexing",
  "generation",
  "other"
]);

export const traceStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);

export const traceNodeSchema = z.object({
  nodeId: z.string(),
  runId: z.string(),
  traceId: z.string(),
  conversationId: z.string().nullable().default(null),
  stage: z.string(),
  nodeType: traceNodeTypeSchema,
  parentNodeId: z.string().nullable().default(null),
  status: traceStatusSchema,
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const traceRunSchema = z.object({
  runId: z.string(),
  traceId: z.string(),
  conversationId: z.string().nullable().default(null),
  status: traceStatusSchema,
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  nodes: z.array(traceNodeSchema).default([])
});

export const traceRecordSchema = z.object({
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  nodeType: traceNodeTypeSchema.optional(),
  parentNodeId: z.string().nullable().optional(),
  traceId: z.string(),
  conversationId: z.string().nullable().default(null),
  stage: z.string(),
  status: traceStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const chatTurnResponseSchema = z.object({
  traceId: z.string(),
  conversation: conversationSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema,
  plan: z.object({
    useRetrieval: z.boolean(),
    useTools: z.boolean(),
    retrievalReason: z.string()
  })
});

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat.started"),
    traceId: z.string(),
    conversation: conversationSchema,
    userMessage: messageSchema
  }),
  z.object({
    type: z.literal("tool.call"),
    traceId: z.string(),
    toolCall: toolCallSchema
  }),
  z.object({
    type: z.literal("message.delta"),
    traceId: z.string(),
    delta: z.string()
  }),
  z.object({
    type: z.literal("message.completed"),
    traceId: z.string(),
    assistantMessage: messageSchema
  }),
  z.object({
    type: z.literal("chat.completed"),
    traceId: z.string(),
    plan: z.object({
      useRetrieval: z.boolean(),
      useTools: z.boolean(),
      retrievalReason: z.string()
    })
  }),
  z.object({
    type: z.literal("thinking.delta"),
    traceId: z.string(),
    delta: z.string()
  }),
  z.object({
    type: z.literal("thinking.completed"),
    traceId: z.string()
  }),
  z.object({
    type: z.literal("chat.error"),
    traceId: z.string(),
    code: z.string(),
    message: z.string()
  })
]);

export const dashboardReadModelSchema = z.object({
  phase: z.literal("phase2"),
  metrics: z.object({
    activeUsers: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    traces: z.number().int().nonnegative(),
    generatedMessages: z.number().int().nonnegative().default(0),
    retrievalAnnotatedMessages: z.number().int().nonnegative().default(0),
    toolCalls: z.number().int().nonnegative().default(0),
    knowledgeBases: z.number().int().nonnegative().default(0),
    ingestionTasks: z.number().int().nonnegative().default(0),
    ingestionSucceeded: z.number().int().nonnegative().default(0),
    ingestionFailed: z.number().int().nonnegative().default(0),
    ingestionRunning: z.number().int().nonnegative().default(0)
  })
});

export const knowledgeBaseReadModelSchema = z.object({
  knowledgeBaseId: z.string(),
  name: z.string(),
  orgId: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null),
  documentCount: z.number().int().nonnegative(),
  updatedAt: z.string()
});

export const settingReadModelSchema = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string(),
  orgId: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null)
});

export const settingUpsertSchema = z.object({
  key: z.string().trim().min(1, "key is required"),
  value: z.string(),
  description: z.string().default("")
});

export const mappingReadModelSchema = z.object({
  mappingId: z.string(),
  sourceTerm: z.string(),
  targetTerm: z.string(),
  enabled: z.boolean(),
  orgId: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null)
});

export const mappingUpsertSchema = z.object({
  mappingId: z.string().trim().min(1).optional(),
  sourceTerm: z.string().trim().min(1, "sourceTerm is required"),
  targetTerm: z.string().trim().min(1, "targetTerm is required"),
  enabled: z.boolean().default(true)
});

export const sampleQuestionReadModelSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  knowledgeBaseId: z.string().nullable(),
  enabled: z.boolean(),
  orgId: z.string().nullable().default(null),
  tenantId: z.string().nullable().default(null)
});

export const sampleQuestionUpsertSchema = z.object({
  questionId: z.string().trim().min(1).optional(),
  question: z.string().trim().min(1, "question is required"),
  knowledgeBaseId: z.string().trim().min(1).nullable().optional().default(null),
  enabled: z.boolean().default(true)
});

export const intentReadModelSchema = z.object({
  intentId: z.string(),
  name: z.string(),
  description: z.string(),
  parentIntentId: z.string().nullable().default(null),
  routeExpression: z.string().default(""),
  knowledgeBaseIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(0),
  tenantId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const intentUpsertSchema = z.object({
  intentId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1, "name is required"),
  description: z.string().default(""),
  parentIntentId: z.string().trim().min(1).nullable().optional().default(null),
  routeExpression: z.string().default(""),
  knowledgeBaseIds: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(0)
});

export const userRoleSchema = z.enum(["user", "admin"]);

export const userReadModelSchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: userRoleSchema,
  tenantId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const userUpsertSchema = z.object({
  userId: z.string().trim().min(1, "userId is required"),
  name: z.string().trim().min(1, "name is required"),
  role: userRoleSchema,
  tenantId: z.string().trim().min(1).nullable().optional().default(null),
  orgId: z.string().trim().min(1).nullable().optional().default(null)
});

export const chunkReadModelSchema = z.object({
  chunkId: z.string(),
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  textPreview: z.string(),
  charCount: z.number().int().nonnegative(),
  sectionPath: z.array(z.string()).default([]),
  offsets: z.object({
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    pageNumber: z.number().int().positive().nullable().default(null)
  }),
  source: z.object({
    ingestionSourceType: z.string(),
    ingestionFilename: z.string(),
    indexRecordSource: z.string().nullable().default(null)
  }),
  embeddingIndex: z.object({
    indexed: z.boolean(),
    indexRecordId: z.string().nullable().default(null),
    embeddingRef: z.string().nullable().default(null),
    vectorDimensions: z.number().int().nonnegative().nullable().default(null),
    indexName: z.string().nullable().default(null),
    indexStoreType: z.string().nullable().default(null),
    indexingSource: z.string().nullable().default(null),
    indexOperation: z.string().nullable().default(null)
  })
});

export const documentReadModelSchema = z.object({
  knowledgeBaseId: z.string(),
  documentId: z.string(),
  title: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sourceType: z.string(),
  taskId: z.string(),
  traceId: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  currentStage: z.enum(["queued", "parser", "chunker", "embedding", "indexing", "completed", "failed"]),
  parserStatus: z.enum(["succeeded", "failed", "pending"]),
  indexingStatus: z.enum(["succeeded", "failed", "pending"]),
  chunkCount: z.number().int().nonnegative(),
  indexRecordCount: z.number().int().nonnegative(),
  retrievalEvidenceCount: z.number().int().nonnegative(),
  latestRetrievedAt: z.string().nullable().default(null),
  latestRetrievedTraceId: z.string().nullable().default(null),
  updatedAt: z.string(),
  createdAt: z.string()
});

export const knowledgeBaseDocumentsReadModelSchema = z.object({
  knowledgeBaseId: z.string(),
  knowledgeBaseName: z.string(),
  strategy: z.literal("latest-succeeded-else-latest-updated"),
  items: z.array(documentReadModelSchema)
});

export const documentDetailReadModelSchema = z.object({
  knowledgeBaseId: z.string(),
  knowledgeBaseName: z.string(),
  strategy: z.literal("latest-succeeded-else-latest-updated"),
  document: documentReadModelSchema,
  retrievalEvidence: z.object({
    retrievalAnnotatedMessageCount: z.number().int().nonnegative(),
    documentFilterHitCount: z.number().int().nonnegative(),
    latestRetrievedAt: z.string().nullable().default(null),
    latestRetrievedTraceId: z.string().nullable().default(null),
    evidenceChunkKeys: z.array(
      z.object({
        chunkId: z.string(),
        documentId: z.string(),
        knowledgeBaseId: z.string()
      })
    )
  }),
  chunks: z.array(chunkReadModelSchema)
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type IngestionTask = z.infer<typeof ingestionTaskSchema>;
export type IngestionTaskCreateRequest = z.infer<typeof ingestionTaskCreateRequestSchema>;
export type IngestionTaskStatus = z.infer<typeof ingestionTaskStatusSchema>;
export type IngestionSource = z.infer<typeof ingestionSourceSchema>;
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;
export type ParsedChunk = z.infer<typeof parsedChunkSchema>;
export type EmbeddingInput = z.infer<typeof embeddingInputSchema>;
export type EmbeddingArtifact = z.infer<typeof embeddingArtifactSchema>;
export type EmbeddingResult = z.infer<typeof embeddingResultSchema>;
export type IndexRecord = z.infer<typeof indexRecordSchema>;
export type IndexWriteResult = z.infer<typeof indexWriteResultSchema>;
export type ParserResult = z.infer<typeof parserResultSchema>;
export type ProcessingTraceEvent = z.infer<typeof processingTraceEventSchema>;
export type RetrievalRequest = z.infer<typeof retrievalRequestSchema>;
export type RetrievalChunk = z.infer<typeof retrievalChunkSchema>;
export type RetrievalResponse = z.infer<typeof retrievalResponseSchema>;
export type TraceNodeType = z.infer<typeof traceNodeTypeSchema>;
export type TraceStatus = z.infer<typeof traceStatusSchema>;
export type TraceNode = z.infer<typeof traceNodeSchema>;
export type TraceRun = z.infer<typeof traceRunSchema>;
export type TraceRecord = z.infer<typeof traceRecordSchema>;
export type ChatTurnResponse = z.infer<typeof chatTurnResponseSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type RetrievalBoundary = z.infer<typeof retrievalBoundarySchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type DashboardReadModel = z.infer<typeof dashboardReadModelSchema>;
export type KnowledgeBaseReadModel = z.infer<typeof knowledgeBaseReadModelSchema>;
export type SettingReadModel = z.infer<typeof settingReadModelSchema>;
export type SettingUpsert = z.infer<typeof settingUpsertSchema>;
export type MappingReadModel = z.infer<typeof mappingReadModelSchema>;
export type MappingUpsert = z.infer<typeof mappingUpsertSchema>;
export type SampleQuestionReadModel = z.infer<typeof sampleQuestionReadModelSchema>;
export type SampleQuestionUpsert = z.infer<typeof sampleQuestionUpsertSchema>;
export type IntentReadModel = z.infer<typeof intentReadModelSchema>;
export type IntentUpsert = z.infer<typeof intentUpsertSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type UserReadModel = z.infer<typeof userReadModelSchema>;
export type UserUpsert = z.infer<typeof userUpsertSchema>;
export type ChunkReadModel = z.infer<typeof chunkReadModelSchema>;
export type DocumentReadModel = z.infer<typeof documentReadModelSchema>;
export type KnowledgeBaseDocumentsReadModel = z.infer<typeof knowledgeBaseDocumentsReadModelSchema>;
export type DocumentDetailReadModel = z.infer<typeof documentDetailReadModelSchema>;
