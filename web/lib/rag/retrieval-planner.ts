import type { IntentReadModel, KnowledgeBaseReadModel } from "@/lib/contracts";
import type { RetrievalPlan, RewritePlan, ToolPlan } from "@/lib/rag/types";

const KB_KEYWORDS: Array<{
  knowledgeBaseId: string;
  keywords: string[];
  reason: string;
}> = [
  {
    knowledgeBaseId: "kb_policy",
    keywords: [
      "policy", "policies", "compliance", "benefit", "leave", "hr",
      "薪资", "制度", "政策",
      "请假", "报销", "入职", "离职", "转正", "调岗", "考勤",
      "加班", "年假", "病假", "事假", "婚假", "产假", "差旅",
      "社保", "公积金", "工资", "绩效", "合同", "续签",
      "请假流程", "报销流程", "入职流程", "离职流程",
      "onboarding", "offboarding", "reimbursement", "attendance",
      "overtime", "payroll", "contract",
    ],
    reason: "question maps to policy / HR vocabulary"
  },
  {
    knowledgeBaseId: "kb_ops",
    keywords: [
      "ops", "incident", "runbook", "ticket", "sla", "support",
      "运维", "故障", "值班",
      "报警", "告警", "监控", "部署", "发布", "回滚", "扩容",
      "缩容", "重启", "日志", "排查", "on-call", "pagerduty",
      "服务", "接口", "超时", "报错", "异常", "崩溃",
      "权限", "账号", "VPN", "服务器", "数据库", "缓存",
      "deploy", "rollback", "outage", "downtime", "monitor",
      "alert", "restart", "server", "database", "cache",
    ],
    reason: "question maps to ops / support vocabulary"
  },
  {
    knowledgeBaseId: "kb_product",
    keywords: [
      "product", "feature", "roadmap", "release", "spec",
      "产品", "功能", "版本",
      "需求", "PRD", "原型", "设计", "评审", "排期", "迭代",
      "上线", "灰度", "AB测试", "用户反馈", "埋点", "数据",
      "竞品", "调研", "规划", "路线图",
      "requirement", "design", "sprint", "iteration", "launch",
      "feedback", "analytics", "competitor",
    ],
    reason: "question maps to product vocabulary"
  }
];

function unique(values: string[]) {
  return [...new Set(values)];
}

export function buildRetrievalPlan(input: {
  message: string;
  rewrite: RewritePlan;
  toolPlan: ToolPlan;
  knowledgeBases: KnowledgeBaseReadModel[];
  intents: IntentReadModel[];
}): RetrievalPlan {
  const lowered = `${input.message} ${input.rewrite.rewrittenQuery}`.toLowerCase();

  const matchedIntents = input.intents
    .filter((intent) => intent.enabled && intent.routeExpression.trim() !== "")
    .filter((intent) => {
      const expr = intent.routeExpression.trim().toLowerCase();
      if (expr.startsWith("/") && expr.lastIndexOf("/") > 0) {
        try {
          const lastSlash = expr.lastIndexOf("/");
          const pattern = expr.slice(1, lastSlash);
          const flags = expr.slice(lastSlash + 1);
          return new RegExp(pattern, flags).test(lowered);
        } catch {
          return false;
        }
      }
      return lowered.includes(expr);
    })
    .sort((a, b) => b.priority - a.priority);

  const intentKnowledgeBaseIds = unique(
    matchedIntents.flatMap((intent) => intent.knowledgeBaseIds)
  );

  const selectedByKeyword = KB_KEYWORDS.filter((candidate) =>
    candidate.keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))
  );
  const selectedKnowledgeBaseIds =
    intentKnowledgeBaseIds.length > 0
      ? intentKnowledgeBaseIds.filter((id) =>
          input.knowledgeBases.some((kb) => kb.knowledgeBaseId === id)
        )
      : unique(
          selectedByKeyword
            .map((candidate) => candidate.knowledgeBaseId)
            .filter((knowledgeBaseId) => input.knowledgeBases.some((item) => item.knowledgeBaseId === knowledgeBaseId))
        );

  const explicitlyKnowledgeBacked =
    selectedKnowledgeBaseIds.length > 0 ||
    /knowledge|document|docs|wiki|manual|handbook|policy|流程|文档|知识库/i.test(input.message);
  const shouldRetrieve = explicitlyKnowledgeBacked || input.rewrite.subQueries.length > 1;

  return {
    shouldRetrieve,
    mode: shouldRetrieve ? "go-executor" : "ts-local",
    reason: shouldRetrieve
      ? "TS planner decided the answer should be grounded with knowledge context before generation"
      : "question can be handled without external retrieval context",
    topK: input.toolPlan.shouldUseTools && selectedKnowledgeBaseIds.length === 0 ? 4 : 6,
    selectedKnowledgeBaseIds,
    filters: {},
    knowledgeBaseReason:
      matchedIntents.length > 0
        ? `intent tree matched: ${matchedIntents.map((i) => `${i.name}(${i.intentId})`).join(", ")}`
        : selectedByKeyword.length > 0
          ? selectedByKeyword.map((item) => `${item.knowledgeBaseId}: ${item.reason}`).join("; ")
          : "no explicit knowledge base signal, keep boundary open for future Go executor"
  };
}
