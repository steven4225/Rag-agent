import type {
  ChatStreamEvent,
  ChatTurnResponse,
  ChunkReadModel,
  Conversation,
  DashboardReadModel,
  DocumentDetailReadModel,
  IngestionTaskCreateRequest,
  IngestionTaskStatus,
  IntentReadModel,
  KnowledgeBaseDocumentsReadModel,
  KnowledgeBaseReadModel,
  MappingReadModel,
  Message,
  SampleQuestionReadModel,
  SettingReadModel,
  TraceRecord,
  TraceRun,
  UserReadModel
} from "@/lib/contracts";
import { requestJson } from "@/lib/client/request";

export async function getConversations() {
  return requestJson<{ items: Conversation[] }>("/api/conversations");
}

export async function createConversation(title?: string) {
  return requestJson<Conversation>("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });
}

export async function getMessages(conversationId: string) {
  const query = new URLSearchParams({ conversationId });
  return requestJson<{ items: Message[] }>(`/api/messages?${query.toString()}`);
}

export async function sendChat(payload: { conversationId: string; message: string }) {
  return requestJson<ChatTurnResponse>("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function sendChatStream(
  payload: { conversationId: string; message: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Streaming response body is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortHandler = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line) as ChatStreamEvent);
        } catch {
          console.warn("failed to parse stream line", line);
        }
      }
    }

    if (buffer.trim()) {
      try {
        onEvent(JSON.parse(buffer) as ChatStreamEvent);
      } catch {
        console.warn("failed to parse stream buffer", buffer);
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export async function getDashboardReadModel() {
  return requestJson<DashboardReadModel>("/api/admin/dashboard");
}

export async function getKnowledgeReadModel() {
  return requestJson<{ items: KnowledgeBaseReadModel[] }>("/api/admin/knowledge-bases");
}

export async function createKnowledgeBase(payload: { name: string }) {
  return requestJson<KnowledgeBaseReadModel>("/api/admin/knowledge-bases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function renameKnowledgeBase(payload: { knowledgeBaseId: string; name: string }) {
  return requestJson<{ knowledgeBaseId: string; name: string }>("/api/admin/knowledge-bases", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function deleteKnowledgeBase(knowledgeBaseId: string) {
  const query = new URLSearchParams({ knowledgeBaseId });
  return requestJson<{ knowledgeBaseId: string }>(`/api/admin/knowledge-bases?${query.toString()}`, {
    method: "DELETE"
  });
}

export async function getKnowledgeBaseDocumentsReadModel(kbId: string) {
  return requestJson<KnowledgeBaseDocumentsReadModel>(`/api/admin/knowledge-bases/${encodeURIComponent(kbId)}/documents`);
}

export async function getDocumentDetailReadModel(kbId: string, docId: string) {
  return requestJson<DocumentDetailReadModel>(
    `/api/admin/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`
  );
}

export async function getChunkReadModel(kbId: string, docId: string) {
  return requestJson<{
    knowledgeBaseId: string;
    documentId: string;
    strategy: "latest-succeeded-else-latest-updated";
    items: ChunkReadModel[];
  }>(`/api/admin/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/chunks`);
}

export async function getIngestionReadModel() {
  return requestJson<{ items: IngestionTaskStatus[] }>("/api/admin/ingestion/tasks");
}

export async function createIngestionTask(payload: IngestionTaskCreateRequest) {
  return requestJson<IngestionTaskStatus>("/api/admin/ingestion/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getIngestionTask(taskId: string) {
  return requestJson<IngestionTaskStatus>(`/api/admin/ingestion/tasks/${taskId}`);
}

export async function getTraceReadModel() {
  return requestJson<{ items: TraceRun[]; records: TraceRecord[] }>("/api/trace");
}

export async function getSettingReadModel() {
  return requestJson<{ items: SettingReadModel[] }>("/api/admin/settings");
}

export async function createSetting(payload: { key: string; value: string; description: string }) {
  return requestJson<SettingReadModel>("/api/admin/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateSetting(payload: { key: string; value: string; description: string }) {
  return requestJson<SettingReadModel>("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getMappingReadModel() {
  return requestJson<{ items: MappingReadModel[] }>("/api/admin/mappings");
}

export async function createMapping(payload: { sourceTerm: string; targetTerm: string; enabled: boolean }) {
  return requestJson<MappingReadModel>("/api/admin/mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateMapping(payload: {
  mappingId: string;
  sourceTerm: string;
  targetTerm: string;
  enabled: boolean;
}) {
  return requestJson<MappingReadModel>("/api/admin/mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getSampleQuestionReadModel() {
  return requestJson<{ items: SampleQuestionReadModel[] }>("/api/admin/sample-questions");
}

export async function createSampleQuestion(payload: {
  question: string;
  knowledgeBaseId: string | null;
  enabled: boolean;
}) {
  return requestJson<SampleQuestionReadModel>("/api/admin/sample-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateSampleQuestion(payload: {
  questionId: string;
  question: string;
  knowledgeBaseId: string | null;
  enabled: boolean;
}) {
  return requestJson<SampleQuestionReadModel>("/api/admin/sample-questions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getUserReadModel() {
  return requestJson<{ items: UserReadModel[] }>("/api/admin/users");
}

export async function createUser(payload: {
  userId: string;
  name: string;
  role: "user" | "admin";
  tenantId: string | null;
  orgId: string | null;
}) {
  return requestJson<UserReadModel>("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateUser(payload: {
  userId: string;
  name: string;
  role: "user" | "admin";
  tenantId: string | null;
  orgId: string | null;
}) {
  return requestJson<UserReadModel>("/api/admin/users", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getIntentReadModel() {
  return requestJson<{ items: IntentReadModel[] }>("/api/admin/intents");
}

export async function createIntent(payload: {
  name: string;
  description?: string;
  parentIntentId?: string | null;
  routeExpression?: string;
  knowledgeBaseIds?: string[];
  enabled?: boolean;
  priority?: number;
}) {
  return requestJson<IntentReadModel>("/api/admin/intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateIntent(payload: {
  intentId: string;
  name: string;
  description?: string;
  parentIntentId?: string | null;
  routeExpression?: string;
  knowledgeBaseIds?: string[];
  enabled?: boolean;
  priority?: number;
}) {
  return requestJson<{ intentId: string; name: string }>("/api/admin/intents", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function deleteIntent(intentId: string) {
  const query = new URLSearchParams({ intentId });
  return requestJson<{ intentId: string }>(`/api/admin/intents?${query.toString()}`, {
    method: "DELETE"
  });
}
