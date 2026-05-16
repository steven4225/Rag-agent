import type { RetrievalBoundary } from "@/lib/contracts";
import type { RetrievalExecutionInput, RetrievalExecutionResult } from "@/lib/retrieval/retrieval-adapter";
import { GoRetrievalAdapter } from "@/lib/retrieval/go-retrieval-adapter";
import { TsLocalRetrievalAdapter } from "@/lib/retrieval/ts-local-retrieval-adapter";

const tsLocalAdapter = new TsLocalRetrievalAdapter();

function parseBool(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

function goRetrievalConfig() {
  return {
    endpoint: process.env.GO_RETRIEVAL_ENDPOINT ?? "http://localhost:8090/internal/retrieval/search",
    fallbackEnabled: parseBool(process.env.GO_RETRIEVAL_FALLBACK_ENABLED, true)
  };
}

export type RetrievalExecutionTrace = {
  boundaryMode: RetrievalBoundary["mode"];
  adapterId: string;
  source: string;
  fallbackReason: string | null;
};

export type ResolvedRetrievalExecution = {
  result: RetrievalExecutionResult;
  trace: RetrievalExecutionTrace;
};

export async function executeResolvedRetrieval(
  boundary: RetrievalBoundary,
  input: RetrievalExecutionInput
): Promise<ResolvedRetrievalExecution> {
  if (boundary.mode !== "go-executor") {
    const result = await tsLocalAdapter.execute(input);
    return {
      result,
      trace: {
        boundaryMode: boundary.mode,
        adapterId: tsLocalAdapter.id,
        source: result.response.source,
        fallbackReason: null
      }
    };
  }

  const config = goRetrievalConfig();
  const goAdapter = new GoRetrievalAdapter({ endpoint: config.endpoint });

  try {
    const result = await goAdapter.execute(input);
    return {
      result,
      trace: {
        boundaryMode: boundary.mode,
        adapterId: goAdapter.id,
        source: result.response.source,
        fallbackReason: null
      }
    };
  } catch (error) {
    if (!config.fallbackEnabled) {
      throw error;
    }

    const fallbackReason = error instanceof Error ? error.message : "unknown go retrieval error";
    const fallback = await tsLocalAdapter.execute(input);
    fallback.response.source = "fallback-ts-local";
    return {
      result: fallback,
      trace: {
        boundaryMode: boundary.mode,
        adapterId: tsLocalAdapter.id,
        source: fallback.response.source,
        fallbackReason
      }
    };
  }
}
