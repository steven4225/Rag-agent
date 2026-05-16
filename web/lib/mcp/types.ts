import type { z } from "zod";

import type { SessionRole } from "@/lib/auth/session";

export type MCPToolExecutionContext = {
  traceId: string;
  actor: {
    userId: string;
    role: SessionRole;
    tenantId: string | null;
    orgId: string | null;
  };
};

export type MCPToolGuardResult = {
  ok: boolean;
  reason?: string;
};

export type MCPToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> = {
  name: string;
  description: string;
  keywords: string[];
  argsSchema: TArgs;
  guard: (context: MCPToolExecutionContext) => MCPToolGuardResult;
  execute: (input: { args: z.infer<TArgs>; context: MCPToolExecutionContext }) => Promise<TResult>;
};

export type MCPPlannedToolCall = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export class MCPToolError extends Error {
  code: string;
  status: number;

  constructor(input: { code: string; message: string; status?: number }) {
    super(input.message);
    this.code = input.code;
    this.status = input.status ?? 400;
  }
}
