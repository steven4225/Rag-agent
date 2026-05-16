import { z } from "zod";

import { allowSignedIn } from "@/lib/mcp/guards";
import type { MCPToolDefinition } from "@/lib/mcp/types";
import { knowledgeRepository } from "@/lib/repositories/platform-repositories";

const argsSchema = z
  .object({
    limit: z.number().int().positive().max(20).default(10)
  })
  .default({ limit: 10 });

export const listKnowledgeBasesTool: MCPToolDefinition<typeof argsSchema> = {
  name: "list_knowledge_bases",
  description: "List available knowledge bases in the current control plane read model.",
  keywords: ["knowledge base", "knowledge bases", "kb list", "知识库", "kb"],
  argsSchema,
  guard: allowSignedIn,
  async execute(input) {
    const items = knowledgeRepository
      .listReadModel({
        tenantId: input.context.actor.tenantId!,
        orgId: input.context.actor.orgId
      })
      .slice(0, input.args.limit);
    return {
      total: items.length,
      items: items.map((item) => ({
        knowledgeBaseId: item.knowledgeBaseId,
        name: item.name,
        documentCount: item.documentCount,
        updatedAt: item.updatedAt
      }))
    };
  }
};
