import type { ToolCall } from "@/lib/contracts";
import { mapToolFailureOutput, mapToolSuccessOutput } from "@/lib/mcp/result-mapper";
import { getMcpTool } from "@/lib/mcp/registry";
import type { MCPPlannedToolCall, MCPToolExecutionContext } from "@/lib/mcp/types";
import type { OrchestrationTraceStage } from "@/lib/rag/types";

type ToolStatus = ToolCall["status"];

type ToolRuntimeUpdate = {
  toolCallId: string;
  toolName: string;
  status: ToolStatus;
  args: Record<string, unknown>;
  output?: unknown;
};

function createTraceStage(stage: string, status: OrchestrationTraceStage["status"], metadata: Record<string, unknown>) {
  return {
    stage,
    status,
    metadata
  } satisfies OrchestrationTraceStage;
}

export async function executeMcpRuntime(input: {
  plannedCalls: MCPPlannedToolCall[];
  context: MCPToolExecutionContext;
  onUpdate?: (update: ToolRuntimeUpdate) => void;
}) {
  const toolCalls: ToolCall[] = [];
  const traceStages: OrchestrationTraceStage[] = [];

  for (const plannedCall of input.plannedCalls) {
    const baseCall = {
      toolCallId: plannedCall.toolCallId,
      toolName: plannedCall.toolName,
      args: plannedCall.args
    };

    input.onUpdate?.({
      ...baseCall,
      status: "queued"
    });

    const tool = getMcpTool(plannedCall.toolName);
    if (!tool) {
      const output = mapToolFailureOutput(new Error(`Tool '${plannedCall.toolName}' is not registered.`));
      const failedCall: ToolCall = {
        ...baseCall,
        status: "failed",
        output
      };
      toolCalls.push(failedCall);
      input.onUpdate?.(failedCall);
      traceStages.push(
        createTraceStage("tool.runtime.failed", "failed", {
          toolCallId: plannedCall.toolCallId,
          toolName: plannedCall.toolName,
          reason: "tool-not-registered"
        })
      );
      continue;
    }

    const guardResult = tool.guard(input.context);
    if (!guardResult.ok) {
      const output = mapToolFailureOutput(new Error(guardResult.reason ?? "tool guard denied"));
      const failedCall: ToolCall = {
        ...baseCall,
        status: "failed",
        output
      };
      toolCalls.push(failedCall);
      input.onUpdate?.(failedCall);
      traceStages.push(
        createTraceStage("tool.runtime.failed", "failed", {
          toolCallId: plannedCall.toolCallId,
          toolName: plannedCall.toolName,
          reason: guardResult.reason ?? "guard-denied"
        })
      );
      continue;
    }

    traceStages.push(
      createTraceStage("tool.runtime.started", "running", {
        toolCallId: plannedCall.toolCallId,
        toolName: plannedCall.toolName,
        args: plannedCall.args
      })
    );

    input.onUpdate?.({
      ...baseCall,
      status: "running"
    });

    try {
      const args = tool.argsSchema.parse(plannedCall.args);
      const result = await tool.execute({
        args,
        context: input.context
      });
      const output = mapToolSuccessOutput(plannedCall.toolName, result);
      const succeededCall: ToolCall = {
        ...baseCall,
        status: "succeeded",
        output
      };
      toolCalls.push(succeededCall);
      input.onUpdate?.(succeededCall);
      traceStages.push(
        createTraceStage("tool.runtime.completed", "succeeded", {
          toolCallId: plannedCall.toolCallId,
          toolName: plannedCall.toolName,
          outputSummary: output.summary
        })
      );
    } catch (error) {
      const output = mapToolFailureOutput(error);
      const failedCall: ToolCall = {
        ...baseCall,
        status: "failed",
        output
      };
      toolCalls.push(failedCall);
      input.onUpdate?.(failedCall);
      traceStages.push(
        createTraceStage("tool.runtime.failed", "failed", {
          toolCallId: plannedCall.toolCallId,
          toolName: plannedCall.toolName,
          error: output.error
        })
      );
    }
  }

  return {
    toolCalls,
    traceStages
  };
}
