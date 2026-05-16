import type { RetrievalRequest, RetrievalResponse } from "@/lib/contracts";
import type { RetrievalPlan, RewritePlan } from "@/lib/rag/types";

export type RetrievalExecutionInput = {
  traceId: string;
  request: RetrievalRequest;
  rewrite: RewritePlan;
  retrieval: RetrievalPlan;
};

export type RetrievalExecutionResult = {
  response: RetrievalResponse;
};

export interface RetrievalAdapter {
  id: string;
  execute(input: RetrievalExecutionInput): Promise<RetrievalExecutionResult>;
}
