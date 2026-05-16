import { listMcpTools } from "@/lib/mcp/registry";
import type { MCPPlannedToolCall } from "@/lib/mcp/types";
import type { RewritePlan, ToolPlan } from "@/lib/rag/types";

function extractIngestionTaskId(message: string) {
  const match = message.match(/\b(task_[a-z0-9_-]{4,}|ing_[a-z0-9_-]{4,}|ingest_[a-z0-9_-]{4,})\b/i);
  return match?.[1];
}

function extractSettingKey(message: string) {
  const match = message.match(/\b([a-z][a-z0-9._-]{2,})\b/gi);
  if (!match || match.length === 0) return null;
  return match.find((token) => token.includes(".")) ?? null;
}

function buildToolArgs(toolName: string, input: { message: string; rewrite: RewritePlan }) {
  if (toolName === "list_knowledge_bases") {
    return {
      limit: 10
    };
  }

  if (toolName === "get_ingestion_task") {
    const taskId = extractIngestionTaskId(input.message);
    return taskId
      ? {
          taskId
        }
      : {};
  }

  if (toolName === "get_system_setting") {
    const key = extractSettingKey(input.message);
    return key
      ? {
          key
        }
      : {};
  }

  return {
    query: input.rewrite.rewrittenQuery
  };
}

export function buildToolPlan(message: string): ToolPlan {
  const lowered = message.toLowerCase();
  const tools = listMcpTools();
  const selectedTools = tools.filter((tool) => tool.keywords.some((keyword) => lowered.includes(keyword.toLowerCase())));

  return {
    shouldUseTools: selectedTools.length > 0,
    selectedToolIds: selectedTools.map((tool) => tool.name),
    reasons:
      selectedTools.length > 0
        ? [`tool hints detected for ${selectedTools.map((tool) => tool.name).join(", ")}`]
        : ["no real-time tool hint detected"]
  };
}

export function buildPlannedToolCalls(input: {
  message: string;
  traceId: string;
  toolPlan: ToolPlan;
  rewrite: RewritePlan;
}): MCPPlannedToolCall[] {
  if (!input.toolPlan.shouldUseTools) {
    return [];
  }

  const tools = listMcpTools();

  return input.toolPlan.selectedToolIds
    .map((toolId) => tools.find((tool) => tool.name === toolId))
    .filter((tool): tool is (typeof tools)[number] => Boolean(tool))
    .map((tool, index) => {
      const args = buildToolArgs(tool.name, input);

      return {
        toolCallId: `${input.traceId}_tool_${index + 1}`,
        toolName: tool.name,
        args
      };
    });
}
