import type {
  Conversation,
  IngestionTaskStatus,
  IntentReadModel,
  KnowledgeBaseReadModel,
  MappingReadModel,
  Message,
  ProcessingTraceEvent,
  SampleQuestionReadModel,
  SettingReadModel,
  TraceRecord,
  UserReadModel
} from "@/lib/contracts";
import type { StorageAdapter } from "@/lib/storage/storage-adapter";
import { resolvePlatformStateStorage } from "@/lib/storage/platform-state-storage-resolver";
import {
  createTraceId,
  createTraceRunId,
  durationFromIso,
  inferTraceNodeId,
  inferTraceParentNodeId,
  mapStageToNodeType
} from "@/lib/trace/trace";

type ScopedEntity = {
  tenantId?: string | null;
  orgId?: string | null;
};

type PlatformScope = {
  tenantId: string;
  orgId?: string | null;
};

type PlatformState = {
  conversations: Conversation[];
  messages: Message[];
  traces: TraceRecord[];
  ingestionTasks: IngestionTaskStatus[];
  knowledgeBases: KnowledgeBaseReadModel[];
  settings: SettingReadModel[];
  mappings: MappingReadModel[];
  sampleQuestions: SampleQuestionReadModel[];
  intents: IntentReadModel[];
  users: UserReadModel[];
};

const nowIso = () => new Date().toISOString();
const DEFAULT_TENANT_ID = process.env.AUTH_MOCK_DEFAULT_TENANT_ID?.trim() || "tenant_demo";
const DEFAULT_ORG_ID = process.env.AUTH_MOCK_DEFAULT_ORG_ID?.trim() || "org_demo";

function normalizeScopeValue(value: string | null | undefined, fallback: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function normalizeScopedEntity<T extends ScopedEntity>(item: T, fallbackTenant = DEFAULT_TENANT_ID, fallbackOrg = DEFAULT_ORG_ID) {
  return {
    ...item,
    tenantId: normalizeScopeValue(item.tenantId, fallbackTenant),
    orgId: normalizeScopeValue(item.orgId, fallbackOrg)
  };
}

function matchesScope(item: ScopedEntity, scope?: PlatformScope): boolean {
  if (!scope) return true;
  if ((item.tenantId ?? null) !== scope.tenantId) return false;
  if (scope.orgId && (item.orgId ?? null) !== scope.orgId) return false;
  return true;
}

function buildSeedState(): PlatformState {
  const createdAt = nowIso();
  return {
    conversations: [
      {
        conversationId: "conv_demo",
        userId: "user_demo",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        title: "Welcome session",
        summary: "",
        lastSummarizedMessageId: "",
        createdAt,
        updatedAt: createdAt
      }
    ],
    messages: [
      {
        messageId: "msg_demo_1",
        conversationId: "conv_demo",
        role: "assistant",
        content: "Welcome to the TS platform. This state is backed by local repository storage.",
        metadata: {
          tenantId: DEFAULT_TENANT_ID,
          orgId: DEFAULT_ORG_ID
        },
        createdAt
      }
    ],
    traces: [],
    ingestionTasks: [],
    knowledgeBases: [
      {
        knowledgeBaseId: "kb_policy",
        name: "Policy Base",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        documentCount: 12,
        updatedAt: createdAt
      },
      {
        knowledgeBaseId: "kb_ops",
        name: "Ops Handbook",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        documentCount: 8,
        updatedAt: createdAt
      },
      {
        knowledgeBaseId: "kb_product",
        name: "Product Notes",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        documentCount: 16,
        updatedAt: createdAt
      }
    ],
    settings: [
      {
        key: "chat.defaultModel",
        value: "gpt-5.4-mini",
        description: "Default chat model in TS shell.",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        key: "retrieval.adapter",
        value: "ts-local-retrieval-adapter",
        description: "Current retrieval adapter id.",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        key: "trace.retentionDays",
        value: "7",
        description: "Trace read model retention window.",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      }
    ],
    mappings: [
      {
        mappingId: "map_1",
        sourceTerm: "SLA",
        targetTerm: "service level agreement",
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        mappingId: "map_2",
        sourceTerm: "prod",
        targetTerm: "production",
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        mappingId: "map_3",
        sourceTerm: "oncall",
        targetTerm: "on-call",
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      }
    ],
    sampleQuestions: [
      {
        questionId: "sample_1",
        question: "How do I upload a document and track ingestion progress?",
        knowledgeBaseId: null,
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        questionId: "sample_2",
        question: "Show me trace stages for the latest failed ingestion task.",
        knowledgeBaseId: "kb_ops",
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      },
      {
        questionId: "sample_3",
        question: "What are the current chat and retrieval settings?",
        knowledgeBaseId: null,
        enabled: true,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID
      }
    ],
    intents: [
      {
        intentId: "intent_root",
        name: "Agent Root",
        description: "Top-level agent routing node.",
        parentIntentId: null,
        routeExpression: "/",
        knowledgeBaseIds: [],
        enabled: true,
        priority: 0,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      },
      {
        intentId: "intent_qa",
        name: "Question Answering",
        description: "Route for factual Q&A over knowledge bases.",
        parentIntentId: "intent_root",
        routeExpression: "/qa",
        knowledgeBaseIds: ["kb_policy", "kb_ops"],
        enabled: true,
        priority: 10,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      },
      {
        intentId: "intent_summary",
        name: "Document Summarization",
        description: "Summarize long documents or document sets.",
        parentIntentId: "intent_root",
        routeExpression: "/summary",
        knowledgeBaseIds: ["kb_product"],
        enabled: true,
        priority: 20,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      },
      {
        intentId: "intent_compare",
        name: "Product Comparison",
        description: "Compare products across knowledge bases.",
        parentIntentId: "intent_summary",
        routeExpression: "/summary/compare",
        knowledgeBaseIds: ["kb_product", "kb_policy"],
        enabled: true,
        priority: 10,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      },
      {
        intentId: "intent_ops",
        name: "Operational Lookup",
        description: "Look up operational procedures and runbooks.",
        parentIntentId: "intent_qa",
        routeExpression: "/qa/ops",
        knowledgeBaseIds: ["kb_ops"],
        enabled: false,
        priority: 5,
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      }
    ],
    users: [
      {
        userId: "admin_demo",
        name: "Demo Admin",
        role: "admin",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      },
      {
        userId: "user_demo",
        name: "Demo User",
        role: "user",
        tenantId: DEFAULT_TENANT_ID,
        orgId: DEFAULT_ORG_ID,
        createdAt,
        updatedAt: createdAt
      }
    ]
  };
}

const resolvedStorage = resolvePlatformStateStorage<PlatformState>({
  seedFactory: buildSeedState
});
const storage: StorageAdapter<PlatformState> = resolvedStorage.storage;

function normalizeTask(task: IngestionTaskStatus): IngestionTaskStatus {
  const metadata = task.metadata ?? {};
  const tenantId = normalizeScopeValue(
    task.tenantId,
    typeof metadata.tenantId === "string" ? metadata.tenantId : DEFAULT_TENANT_ID
  );
  const orgId = normalizeScopeValue(task.orgId, typeof metadata.orgId === "string" ? metadata.orgId : DEFAULT_ORG_ID);

  return {
    ...task,
    tenantId,
    orgId,
    parserResult: task.parserResult ?? null,
    embeddingResult: task.embeddingResult ?? null,
    indexWriteResult: task.indexWriteResult ?? null,
    chunks: task.chunks ?? [],
    metadata: {
      ...metadata,
      tenantId,
      orgId
    },
    trace: (task.trace ?? []).map((event) => ({
      ...event,
      tenantId: normalizeScopeValue(event.tenantId, tenantId),
      orgId: normalizeScopeValue(event.orgId, orgId)
    }))
  };
}

function readState(): PlatformState {
  const state = storage.read() as Partial<PlatformState>;
  const seed = buildSeedState();
  return {
    conversations: (state.conversations ?? seed.conversations).map((item) => normalizeScopedEntity(item)),
    messages: state.messages ?? seed.messages,
    traces: state.traces ?? seed.traces,
    ingestionTasks: (state.ingestionTasks ?? seed.ingestionTasks).map((item) => normalizeTask(item)),
    knowledgeBases: (state.knowledgeBases ?? seed.knowledgeBases).map((item) => normalizeScopedEntity(item)),
    settings: (state.settings ?? seed.settings).map((item) => normalizeScopedEntity(item)),
    mappings: (state.mappings ?? seed.mappings).map((item) => normalizeScopedEntity(item)),
    sampleQuestions: (state.sampleQuestions ?? seed.sampleQuestions).map((item) => normalizeScopedEntity(item)),
    intents: (state.intents ?? seed.intents).map((item) => ({
      ...normalizeScopedEntity(item),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    })),
    users: (state.users ?? seed.users).map((item) => ({
      ...normalizeScopedEntity(item),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))
  };
}

function readScopeFromMetadata(metadata: Record<string, unknown> | undefined): ScopedEntity {
  return {
    tenantId: typeof metadata?.tenantId === "string" ? metadata.tenantId : null,
    orgId: typeof metadata?.orgId === "string" ? metadata.orgId : null
  };
}

class ConversationRepository {
  list(scope?: PlatformScope) {
    return readState()
      .conversations.filter((item) => matchesScope(item, scope))
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  listByUserId(userId: string, scope?: PlatformScope) {
    return this.list(scope).filter((item) => item.userId === userId);
  }

  getById(conversationId: string, scope?: PlatformScope) {
    return this.list(scope).find((item) => item.conversationId === conversationId) ?? null;
  }

  getByIdForUser(conversationId: string, userId: string, scope?: PlatformScope) {
    return this.list(scope).find((item) => item.conversationId === conversationId && item.userId === userId) ?? null;
  }

  create(input?: { title?: string; userId?: string; tenantId?: string | null; orgId?: string | null }) {
    const createdAt = nowIso();
    const next: Conversation = {
      conversationId: `conv_${Date.now()}`,
      userId: input?.userId ?? "user_demo",
      tenantId: normalizeScopeValue(input?.tenantId, DEFAULT_TENANT_ID),
      orgId: normalizeScopeValue(input?.orgId, DEFAULT_ORG_ID),
      title: input?.title?.trim() || "New conversation",
      summary: "",
      lastSummarizedMessageId: "",
      createdAt,
      updatedAt: createdAt
    };

    storage.update((state) => ({
      ...state,
      conversations: [next, ...state.conversations]
    }));
    return next;
  }

  touch(conversationId: string) {
    storage.update((state) => ({
      ...state,
      conversations: state.conversations.map((item) =>
        item.conversationId === conversationId
          ? {
              ...item,
              updatedAt: nowIso()
            }
          : item
      )
    }));
  }

  updateSummary(conversationId: string, summary: string, lastSummarizedMessageId: string) {
    storage.update((state) => ({
      ...state,
      conversations: state.conversations.map((item) =>
        item.conversationId === conversationId
          ? {
              ...item,
              summary,
              lastSummarizedMessageId,
              updatedAt: nowIso()
            }
          : item
      )
    }));
  }
}

class MessageRepository {
  listByConversationId(conversationId: string) {
    return readState()
      .messages.filter((item) => item.conversationId === conversationId)
      .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
  }

  append(input: {
    conversationId: string;
    role: Message["role"];
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    const next: Message = {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: nowIso()
    };

    storage.update((state) => ({
      ...state,
      messages: [...state.messages, next],
      conversations: state.conversations.map((item) =>
        item.conversationId === input.conversationId
          ? {
              ...item,
              updatedAt: nowIso()
            }
          : item
      )
    }));
    return next;
  }

  updateFeedback(messageId: string, feedback: "like" | "dislike" | null) {
    storage.update((state) => ({
      ...state,
      messages: state.messages.map((item) =>
        item.messageId === messageId
          ? {
              ...item,
              metadata: {
                ...item.metadata,
                feedback,
                feedbackUpdatedAt: nowIso()
              }
            }
          : item
      )
    }));
  }
}

class TraceRepository {
  list(scope?: PlatformScope) {
    return readState()
      .traces.filter((item) => matchesScope(readScopeFromMetadata(item.metadata), scope))
      .slice()
      .sort((a, b) => ((a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1));
  }

  append(input: {
    traceId?: string;
    runId?: string;
    nodeId?: string;
    nodeType?: TraceRecord["nodeType"];
    parentNodeId?: string | null;
    conversationId: string | null;
    stage: string;
    status: TraceRecord["status"];
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
    scope?: {
      userId?: string;
      role?: string;
      tenantId?: string | null;
      orgId?: string | null;
    };
  }) {
    const traceId = input.traceId ?? createTraceId("trace");
    const startedAt = input.startedAt ?? nowIso();
    const finishedAt = input.finishedAt ?? nowIso();
    const nodeType = input.nodeType ?? mapStageToNodeType(input.stage);
    const nodeId =
      input.nodeId ??
      inferTraceNodeId({
        traceId,
        stage: input.stage,
        nodeType,
        metadata: input.metadata
      });
    const parentNodeId =
      input.parentNodeId ??
      inferTraceParentNodeId({
        traceId,
        stage: input.stage,
        nodeType
      });
    const scopeMetadata: Record<string, unknown> = {
      tenantId: normalizeScopeValue(input.scope?.tenantId, DEFAULT_TENANT_ID),
      orgId: normalizeScopeValue(input.scope?.orgId, DEFAULT_ORG_ID)
    };
    if (input.scope?.userId) scopeMetadata.userId = input.scope.userId;
    if (input.scope?.role) scopeMetadata.role = input.scope.role;

    const next: TraceRecord = {
      runId: input.runId ?? createTraceRunId(traceId),
      nodeId,
      nodeType,
      parentNodeId,
      traceId,
      conversationId: input.conversationId,
      stage: input.stage,
      status: input.status,
      startedAt,
      finishedAt,
      durationMs: input.durationMs ?? durationFromIso(startedAt, finishedAt),
      metadata: {
        ...input.metadata,
        ...scopeMetadata
      }
    };

    storage.update((state) => ({
      ...state,
      traces: [next, ...state.traces]
    }));
    return next;
  }
}

class IngestionRepository {
  list(scope?: PlatformScope) {
    return readState()
      .ingestionTasks.filter((item) => matchesScope(item, scope))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  listByKnowledgeBaseId(knowledgeBaseId: string, scope?: PlatformScope) {
    return this.list(scope).filter((item) => item.knowledgeBaseId === knowledgeBaseId);
  }

  listByDocumentId(knowledgeBaseId: string, documentId: string, scope?: PlatformScope) {
    return this.listByKnowledgeBaseId(knowledgeBaseId, scope).filter((item) => item.documentId === documentId);
  }

  getById(taskId: string, scope?: PlatformScope) {
    return this.list(scope).find((item) => item.taskId === taskId) ?? null;
  }

  upsert(task: IngestionTaskStatus) {
    const normalized = normalizeTask(task);
    storage.update((state) => {
      const tasks = state.ingestionTasks ?? [];
      const existing = tasks.find((item) => item.taskId === normalized.taskId);
      if (!existing) {
        return {
          ...state,
          ingestionTasks: [normalized, ...tasks]
        };
      }

      return {
        ...state,
        ingestionTasks: tasks.map((item) => (item.taskId === normalized.taskId ? normalized : item))
      };
    });
    return normalized;
  }

  appendTrace(taskId: string, event: ProcessingTraceEvent) {
    storage.update((state) => ({
      ...state,
      ingestionTasks: state.ingestionTasks.map((item) =>
        item.taskId === taskId
          ? {
              ...item,
              updatedAt: event.timestamp,
              trace: [
                ...item.trace,
                {
                  ...event,
                  tenantId: normalizeScopeValue(event.tenantId, item.tenantId),
                  orgId: normalizeScopeValue(event.orgId, item.orgId)
                }
              ]
            }
          : item
      )
    }));
  }
}

class KnowledgeRepository {
  listReadModel(scope?: PlatformScope) {
    return readState().knowledgeBases.filter((item) => matchesScope(item, scope)).slice();
  }

  create(input: { name: string; tenantId?: string | null; orgId?: string | null }) {
    const now = nowIso();
    const next: KnowledgeBaseReadModel = {
      knowledgeBaseId: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: input.name.trim(),
      tenantId: normalizeScopeValue(input.tenantId, DEFAULT_TENANT_ID),
      orgId: normalizeScopeValue(input.orgId, DEFAULT_ORG_ID),
      documentCount: 0,
      updatedAt: now
    };
    storage.update((state) => ({
      ...state,
      knowledgeBases: [...state.knowledgeBases, next]
    }));
    return next;
  }

  rename(knowledgeBaseId: string, name: string, scope?: PlatformScope) {
    const trimmed = name.trim();
    storage.update((state) => ({
      ...state,
      knowledgeBases: state.knowledgeBases.map((item) =>
        item.knowledgeBaseId === knowledgeBaseId && matchesScope(item, scope)
          ? { ...item, name: trimmed, updatedAt: nowIso() }
          : item
      )
    }));
  }

  delete(knowledgeBaseId: string, scope?: PlatformScope) {
    storage.update((state) => ({
      ...state,
      knowledgeBases: state.knowledgeBases.filter(
        (item) => !(item.knowledgeBaseId === knowledgeBaseId && matchesScope(item, scope))
      )
    }));
  }
}

class SettingRepository {
  listReadModel(scope?: PlatformScope) {
    return readState().settings.filter((item) => matchesScope(item, scope)).slice();
  }

  getValue(key: string, fallback: string | null = null, scope?: PlatformScope) {
    return this.listReadModel(scope).find((item) => item.key === key)?.value ?? fallback;
  }

  upsert(item: SettingReadModel, scope?: PlatformScope) {
    const nextItem: SettingReadModel = normalizeScopedEntity(
      item,
      scope?.tenantId ?? DEFAULT_TENANT_ID,
      scope?.orgId ?? DEFAULT_ORG_ID
    );
    storage.update((state) => {
      const settings = state.settings ?? [];
      const existing = settings.find(
        (current) => current.key === nextItem.key && matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
      );
      if (!existing) {
        return {
          ...state,
          settings: [nextItem, ...settings]
        };
      }
      return {
        ...state,
        settings: settings.map((current) =>
          current.key === nextItem.key && matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
            ? nextItem
            : current
        )
      };
    });
    return nextItem;
  }
}

class MappingRepository {
  listReadModel(scope?: PlatformScope) {
    return readState().mappings.filter((item) => matchesScope(item, scope)).slice();
  }

  upsert(item: MappingReadModel, scope?: PlatformScope) {
    const nextItem: MappingReadModel = normalizeScopedEntity(
      item,
      scope?.tenantId ?? DEFAULT_TENANT_ID,
      scope?.orgId ?? DEFAULT_ORG_ID
    );
    storage.update((state) => {
      const mappings = state.mappings ?? [];
      const existing = mappings.find(
        (current) =>
          current.mappingId === nextItem.mappingId &&
          matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
      );
      if (!existing) {
        return {
          ...state,
          mappings: [nextItem, ...mappings]
        };
      }
      return {
        ...state,
        mappings: mappings.map((current) =>
          current.mappingId === nextItem.mappingId &&
          matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
            ? nextItem
            : current
        )
      };
    });
    return nextItem;
  }
}

class SampleQuestionRepository {
  listReadModel(scope?: PlatformScope) {
    return readState().sampleQuestions.filter((item) => matchesScope(item, scope)).slice();
  }

  listEnabledForChatStarters(scope?: PlatformScope) {
    return this.listReadModel(scope).filter((item) => item.enabled);
  }

  upsert(item: SampleQuestionReadModel, scope?: PlatformScope) {
    const nextItem: SampleQuestionReadModel = normalizeScopedEntity(
      item,
      scope?.tenantId ?? DEFAULT_TENANT_ID,
      scope?.orgId ?? DEFAULT_ORG_ID
    );
    storage.update((state) => {
      const sampleQuestions = state.sampleQuestions ?? [];
      const existing = sampleQuestions.find(
        (current) =>
          current.questionId === nextItem.questionId &&
          matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
      );
      if (!existing) {
        return {
          ...state,
          sampleQuestions: [nextItem, ...sampleQuestions]
        };
      }
      return {
        ...state,
        sampleQuestions: sampleQuestions.map((current) =>
          current.questionId === nextItem.questionId &&
          matchesScope(current, { tenantId: nextItem.tenantId!, orgId: nextItem.orgId })
            ? nextItem
            : current
        )
      };
    });
    return nextItem;
  }
}

class IntentRepository {
  listReadModel(scope?: PlatformScope) {
    return readState().intents.filter((item) => matchesScope(item, scope)).slice();
  }

  create(input: {
    name: string;
    description?: string;
    parentIntentId?: string | null;
    routeExpression?: string;
    knowledgeBaseIds?: string[];
    enabled?: boolean;
    priority?: number;
    tenantId?: string | null;
    orgId?: string | null;
  }) {
    const now = nowIso();
    const next: IntentReadModel = {
      intentId: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: input.name.trim(),
      description: input.description ?? "",
      parentIntentId: input.parentIntentId ?? null,
      routeExpression: input.routeExpression ?? "",
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      tenantId: normalizeScopeValue(input.tenantId, DEFAULT_TENANT_ID),
      orgId: normalizeScopeValue(input.orgId, DEFAULT_ORG_ID),
      createdAt: now,
      updatedAt: now
    };
    storage.update((state) => ({
      ...state,
      intents: [...state.intents, next]
    }));
    return next;
  }

  update(intentId: string, input: {
    name: string;
    description?: string;
    parentIntentId?: string | null;
    routeExpression?: string;
    knowledgeBaseIds?: string[];
    enabled?: boolean;
    priority?: number;
  }, scope?: PlatformScope) {
    storage.update((state) => ({
      ...state,
      intents: state.intents.map((item) =>
        item.intentId === intentId && matchesScope(item, scope)
          ? {
              ...item,
              name: input.name.trim(),
              description: input.description ?? item.description,
              parentIntentId: input.parentIntentId !== undefined ? input.parentIntentId : item.parentIntentId,
              routeExpression: input.routeExpression ?? item.routeExpression,
              knowledgeBaseIds: input.knowledgeBaseIds ?? item.knowledgeBaseIds,
              enabled: input.enabled ?? item.enabled,
              priority: input.priority ?? item.priority,
              updatedAt: nowIso()
            }
          : item
      )
    }));
  }

  delete(intentId: string, scope?: PlatformScope) {
    storage.update((state) => ({
      ...state,
      intents: state.intents.filter(
        (item) => !(item.intentId === intentId && matchesScope(item, scope))
      )
    }));
  }
}

class UserRepository {
  listReadModel(scope?: PlatformScope) {
    return readState()
      .users.filter((item) => matchesScope(item, scope))
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  listByRole(role: UserReadModel["role"], scope?: PlatformScope) {
    return this.listReadModel(scope).filter((item) => item.role === role);
  }

  getByUserId(userId: string) {
    return readState().users.find((item) => item.userId === userId) ?? null;
  }

  upsert(input: {
    userId: string;
    name: string;
    role: UserReadModel["role"];
    tenantId?: string | null;
    orgId?: string | null;
  }) {
    const currentState = readState();
    const existing = currentState.users.find((item) => item.userId === input.userId) ?? null;
    const createdAt = existing?.createdAt ?? nowIso();
    const next: UserReadModel = {
      userId: input.userId,
      name: input.name,
      role: input.role,
      tenantId: normalizeScopeValue(input.tenantId, DEFAULT_TENANT_ID),
      orgId: normalizeScopeValue(input.orgId, DEFAULT_ORG_ID),
      createdAt,
      updatedAt: nowIso()
    };

    storage.update((state) => {
      const users = state.users ?? [];
      if (!users.some((item) => item.userId === next.userId)) {
        return {
          ...state,
          users: [next, ...users]
        };
      }

      return {
        ...state,
        users: users.map((item) => (item.userId === next.userId ? next : item))
      };
    });

    return next;
  }
}

export const conversationRepository = new ConversationRepository();
export const messageRepository = new MessageRepository();
export const traceRepository = new TraceRepository();
export const ingestionRepository = new IngestionRepository();
export const knowledgeRepository = new KnowledgeRepository();
export const settingRepository = new SettingRepository();
export const mappingRepository = new MappingRepository();
export const sampleQuestionRepository = new SampleQuestionRepository();
export const intentRepository = new IntentRepository();
export const userRepository = new UserRepository();

export function readPlatformState() {
  return readState();
}

export const platformStatePersistenceBackend = resolvedStorage.backend;
