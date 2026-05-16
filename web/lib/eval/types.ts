export type EvalTestCase = {
  id: string;
  question: string;
  groundTruthChunks: string[];
  knowledgeBaseId?: string;
};

export type EvalMetrics = {
  faithfulness: number;
  answerRelevance: number;
  contextPrecision: number;
  contextRecall: number;
};

export type EvalCaseResult = {
  caseId: string;
  question: string;
  answer: string;
  retrievedChunks: string[];
  metrics: EvalMetrics;
  durationMs: number;
};

export type EvalRunResult = {
  timestamp: string;
  totalCases: number;
  passedCases: number;
  caseResults: EvalCaseResult[];
  aggregateMetrics: EvalMetrics;
};
