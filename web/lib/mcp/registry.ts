import type { MCPToolDefinition } from "@/lib/mcp/types";
import { getIngestionTaskTool } from "@/lib/mcp/tools/get-ingestion-task";
import { getSystemSettingTool } from "@/lib/mcp/tools/get-system-setting";
import { listKnowledgeBasesTool } from "@/lib/mcp/tools/list-knowledge-bases";

const tools = [listKnowledgeBasesTool, getIngestionTaskTool, getSystemSettingTool] as const;

const toolByName = new Map<string, MCPToolDefinition>(tools.map((tool) => [tool.name, tool]));

export function listMcpTools() {
  return tools.slice();
}

export function getMcpTool(name: string) {
  return toolByName.get(name) ?? null;
}
