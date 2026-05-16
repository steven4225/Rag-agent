import { z } from "zod";

import { allowAdminWithScope } from "@/lib/mcp/guards";
import { MCPToolError, type MCPToolDefinition } from "@/lib/mcp/types";
import { settingRepository } from "@/lib/repositories/platform-repositories";

const argsSchema = z.object({
  key: z.string().trim().min(1, "key is required")
});

export const getSystemSettingTool: MCPToolDefinition<typeof argsSchema> = {
  name: "get_system_setting",
  description: "Read one system setting by key from admin settings read model.",
  keywords: ["setting", "settings", "system setting", "配置", "参数"],
  argsSchema,
  guard: allowAdminWithScope,
  async execute(input) {
    const item =
      settingRepository
        .listReadModel({
          tenantId: input.context.actor.tenantId!,
          orgId: input.context.actor.orgId
        })
        .find((setting) => setting.key === input.args.key) ?? null;
    if (!item) {
      throw new MCPToolError({
        code: "SETTING_NOT_FOUND",
        message: `System setting '${input.args.key}' not found.`,
        status: 404
      });
    }

    return {
      key: item.key,
      value: item.value,
      description: item.description
    };
  }
};
