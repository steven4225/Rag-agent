import { MCPToolError } from "@/lib/mcp/types";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = toJsonValue(item);
    }
    return record;
  }
  return String(value);
}

export function mapToolSuccessOutput(toolName: string, result: unknown) {
  const data = toJsonValue(result);
  const summary =
    typeof data === "object" && data && "total" in data
      ? `${toolName} succeeded (total=${String((data as { total: unknown }).total)})`
      : `${toolName} succeeded`;

  return {
    summary,
    data
  };
}

export function mapToolFailureOutput(error: unknown) {
  if (error instanceof MCPToolError) {
    return {
      summary: `${error.code}: ${error.message}`,
      error: {
        code: error.code,
        message: error.message,
        status: error.status
      }
    };
  }

  const message = error instanceof Error ? error.message : "Tool execution failed.";
  return {
    summary: message,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message,
      status: 500
    }
  };
}
