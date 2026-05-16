import type { IngestionTaskCreateRequest, IngestionTaskStatus } from "@/lib/contracts";
import { createGoIngestionTask } from "@/lib/clients/go-ingestion";
import { ingestionRepository, traceRepository } from "@/lib/repositories/platform-repositories";
import { createTraceRunId } from "@/lib/trace/trace";

export async function createIngestionTask(input: IngestionTaskCreateRequest): Promise<IngestionTaskStatus> {
  const task = await createGoIngestionTask(input);
  const runId = createTraceRunId(task.traceId);

  ingestionRepository.upsert(task);

  traceRepository.append({
    traceId: task.traceId,
    runId,
    nodeId: `node:${task.traceId}:ingestion:root`,
    conversationId: null,
    stage: "ingestion",
    status: task.status,
    startedAt: task.startedAt ?? task.createdAt,
    finishedAt: task.finishedAt ?? task.updatedAt,
    metadata: {
      taskId: task.taskId,
      knowledgeBaseId: task.knowledgeBaseId,
      documentId: task.documentId
    },
    scope: {
      tenantId: task.tenantId,
      orgId: task.orgId
    }
  });

  for (const event of task.trace) {
    traceRepository.append({
      traceId: event.traceId,
      runId,
      conversationId: null,
      stage: `ingestion:${event.stage}`,
      status: event.status,
      startedAt: event.timestamp,
      finishedAt: event.timestamp,
      metadata: {
        taskId: event.taskId,
        level: event.level,
        message: event.message,
        ...event.metadata
      },
      scope: {
        tenantId: event.tenantId ?? task.tenantId,
        orgId: event.orgId ?? task.orgId
      }
    });
  }

  return task;
}
