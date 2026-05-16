import { z } from "zod";

import { allowAdminWithScope } from "@/lib/mcp/guards";
import { MCPToolError, type MCPToolDefinition } from "@/lib/mcp/types";
import { ingestionRepository } from "@/lib/repositories/platform-repositories";

const argsSchema = z.object({
  taskId: z.string().trim().min(1, "taskId is required")
});

export const getIngestionTaskTool: MCPToolDefinition<typeof argsSchema> = {
  name: "get_ingestion_task",
  description: "Read one ingestion task by taskId from admin read model.",
  keywords: ["ingestion task", "task status", "task", "ingestion", "任务", "摄取"],
  argsSchema,
  guard: allowAdminWithScope,
  async execute(input) {
    const task = ingestionRepository.getById(input.args.taskId, {
      tenantId: input.context.actor.tenantId!,
      orgId: input.context.actor.orgId
    });
    if (!task) {
      throw new MCPToolError({
        code: "INGESTION_TASK_NOT_FOUND",
        message: `Ingestion task '${input.args.taskId}' not found.`,
        status: 404
      });
    }

    return {
      taskId: task.taskId,
      status: task.status,
      currentStage: task.currentStage,
      traceId: task.traceId,
      knowledgeBaseId: task.knowledgeBaseId,
      documentId: task.documentId,
      attemptCount: task.attemptCount,
      updatedAt: task.updatedAt,
      failureReason: task.failureReason,
      errorMessage: task.errorMessage
    };
  }
};
