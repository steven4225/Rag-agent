import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  cleanupWindowsPorts,
  createRunContext,
  createSessionHeaders,
  ensureNextBuild,
  fetchJson,
  prepareRunWorkspace,
  startProcess,
  stopProcess,
  waitForHealthy,
  withJsonHeaders
} from "./_shared/e2e-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const runContext = createRunContext({ repoRoot, tempNamespace: "mcp-runtime-e2e" });
const { tempRoot, stateFilePath } = runContext;
const reportPath = path.join(tempRoot, "report.json");
const webPort = Number(process.env.MCP_RUNTIME_E2E_WEB_PORT ?? "3207");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

const adminHeaders = createSessionHeaders({
  role: "admin",
  userId: "mcp_admin_demo",
  userName: "MCP Admin",
  tenantId: "tenant_mcp_e2e",
  orgId: "org_mcp_e2e"
});

const userHeaders = createSessionHeaders({
  role: "user",
  userId: "mcp_user_demo",
  userName: "MCP User",
  tenantId: "tenant_mcp_e2e",
  orgId: "org_mcp_e2e"
});
const preconditions = {
  requiredEnv: ["MCP_RUNTIME_E2E_WEB_PORT"],
  session: {
    admin: adminHeaders,
    user: userHeaders
  },
  externalDependencies: ["Node.js/Next.js runtime"],
  blockedOrSkippedWhen: [
    "Unable to build Next app",
    "Configured web port occupied and cannot be reclaimed",
    "Session tenant/org scope is rejected by auth guard"
  ]
};

async function main() {
  await prepareRunWorkspace(runContext);
  await ensureNextBuild({ webRoot, nextCliPath, repoRoot });

  const nextStart = startProcess({
    command: process.execPath,
    args: [nextCliPath, "start", "--port", String(webPort)],
    cwd: webRoot,
    env: {
      AUTH_PROVIDER_MODE: "mock",
      AUTH_MOCK_FALLBACK_ENABLED: "true",
      AUTH_HEADER_AUTH_ENABLED: "true",
      AUTH_MOCK_DEFAULT_ROLE: "admin",
      AUTH_MOCK_DEFAULT_USER_ID: "mcp_admin_demo",
      AUTH_MOCK_DEFAULT_USER_NAME: "MCP Admin",
      AUTH_MOCK_DEFAULT_TENANT_ID: "tenant_mcp_e2e",
      AUTH_MOCK_DEFAULT_ORG_ID: "org_mcp_e2e",
      TS_PLATFORM_STATE_PATH: stateFilePath,
      RAGENT_FORCE_LOCAL_GENERATION: "true"
    },
    label: "next-start",
    logRoot: tempRoot
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/auth/session`, "next-start", [nextStart]);

    const report = await runVerification();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    assertVerification(report);
    printSummary(report);
  } finally {
    await cleanupWindowsPorts([webPort]);
    await stopProcess(nextStart);
  }
}

async function runVerification() {
  const createdTask = await createIngestionTask();
  const settingKey = await createSystemSetting();
  const scenarios = {};

  scenarios.A = await runChatScenario({
    id: "A",
    actor: "user",
    message: "Please list knowledge bases that are currently available.",
    expectedToolName: "list_knowledge_bases",
    expectedStatus: "succeeded",
    expectedArgs: {
      limit: 10
    },
    expectTraceStages: ["tool.plan", "tool.runtime.started", "tool.runtime.completed"]
  });

  scenarios.B = await runChatScenario({
    id: "B",
    actor: "admin",
    message: `Please check ingestion task status for ${createdTask.taskId}.`,
    expectedToolName: "get_ingestion_task",
    expectedStatus: "succeeded",
    expectedArgs: {
      taskId: createdTask.taskId
    },
    expectTraceStages: ["tool.plan", "tool.runtime.started", "tool.runtime.completed"]
  });

  scenarios.C = await runChatScenario({
    id: "C",
    actor: "user",
    message: `Please check ingestion task status for ${createdTask.taskId}.`,
    expectedToolName: "get_ingestion_task",
    expectedStatus: "failed",
    expectedArgs: {
      taskId: createdTask.taskId
    },
    expectErrorSummaryIncludes: "admin role required",
    expectTraceStages: ["tool.plan", "tool.runtime.failed"]
  });

  scenarios.D = await runChatScenario({
    id: "D",
    actor: "admin",
    message: `Please read system setting ${settingKey}.`,
    expectedToolName: "get_system_setting",
    expectedStatus: "succeeded",
    expectedArgs: {
      key: settingKey
    },
    expectTraceStages: ["tool.plan", "tool.runtime.started", "tool.runtime.completed"]
  });

  scenarios.E = await runStreamScenario({
    id: "E",
    actor: "admin",
    message: `Please read system setting ${settingKey}.`,
    expectedToolName: "get_system_setting",
    expectedArgs: {
      key: settingKey
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    preconditions,
    environment: {
      runId: runContext.runId,
      webPort,
      stateFilePath,
      reportPath
    },
    scope: {
      tools: ["list_knowledge_bases", "get_ingestion_task", "get_system_setting"],
      routes: ["/api/chat", "/api/chat/stream", "/api/trace"],
      permissions: ["signed-in user", "admin", "admin-only denial"],
      traceStages: ["tool.plan", "tool.runtime.started", "tool.runtime.completed", "tool.runtime.failed"]
    },
    setup: {
      createdIngestionTask: {
        taskId: createdTask.taskId,
        traceId: createdTask.traceId,
        status: createdTask.status
      },
      createdSetting: {
        key: settingKey
      }
    },
    scenarios
  };
}

async function createSystemSetting() {
  const key = `mcp.runtime.e2e.${Date.now()}`;
  await fetchJson(`http://127.0.0.1:${webPort}/api/admin/settings`, {
    method: "POST",
    headers: withJsonHeaders(adminHeaders),
    body: JSON.stringify({
      key,
      value: "enabled",
      description: "MCP runtime E2E seeded setting"
    })
  });
  return key;
}

async function createIngestionTask() {
  const unique = Date.now();
  const markdown = `# MCP Runtime E2E ${unique}\n\nTool runtime verification payload.`;
  const payload = {
    traceId: `mcp_ingest_${unique}`,
    knowledgeBaseId: "kb_policy",
    documentId: `doc_mcp_${unique}`,
    requestedBy: "mcp-runtime-e2e",
    source: {
      sourceType: "upload",
      uri: `data:text/markdown;base64,${Buffer.from(markdown, "utf8").toString("base64")}`,
      filename: `mcp-runtime-${unique}.md`,
      mimeType: "text/markdown",
      sizeBytes: Buffer.byteLength(markdown, "utf8"),
      checksum: null
    },
    executionPlan: {
      parser: {
        parserType: "text-parser",
        mode: "adapter"
      },
      chunking: {
        strategy: "paragraph",
        targetSize: 1200,
        overlap: 120
      },
      embedding: {
        enabled: false,
        model: null,
        adapter: null
      },
      indexing: {
        enabled: false,
        indexName: null,
        storeType: null
      }
    },
    metadata: {
      initiatedFrom: "verify-mcp-runtime-e2e"
    }
  };

  return fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: withJsonHeaders(adminHeaders),
    body: JSON.stringify(payload)
  });
}

async function runChatScenario(input) {
  const headers = input.actor === "admin" ? adminHeaders : userHeaders;
  const response = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(headers),
    body: JSON.stringify({
      message: input.message
    })
  });

  const assistantMessage = response.assistantMessage;
  const metadataToolCalls = normalizeToolCalls(assistantMessage?.metadata?.toolCalls);
  const expectedCall = metadataToolCalls.find((call) => call.toolName === input.expectedToolName) ?? null;
  const traceItems = await getTraceItems(response.traceId);

  return {
    id: input.id,
    actor: input.actor,
    route: "/api/chat",
    traceId: response.traceId,
    plan: response.plan,
    verification: {
      toolName: expectedCall?.toolName ?? null,
      toolCallStatus: expectedCall?.status ?? null,
      args: expectedCall?.args ?? null,
      outputSummary: readOutputSummary(expectedCall),
      outputError: readOutputError(expectedCall),
      assistantMetadataToolCallsCount: metadataToolCalls.length,
      assistantMetadataToolCalls: metadataToolCalls,
      traceStages: traceItems.map((item) => ({
        stage: item.stage,
        status: item.status,
        metadata: item.metadata
      }))
    },
    assertions: {
      toolNameMatched: expectedCall?.toolName === input.expectedToolName,
      toolStatusMatched: expectedCall?.status === input.expectedStatus,
      argsMatched: partialDeepEqual(expectedCall?.args ?? null, input.expectedArgs),
      outputSummaryMatched:
        input.expectErrorSummaryIncludes && expectedCall
          ? readOutputSummary(expectedCall).toLowerCase().includes(input.expectErrorSummaryIncludes.toLowerCase())
          : Boolean(readOutputSummary(expectedCall)),
      assistantMetadataContainsToolCalls: metadataToolCalls.length > 0,
      traceStagesContainExpected: input.expectTraceStages.every((stage) => traceItems.some((item) => item.stage === stage))
    }
  };
}

async function runStreamScenario(input) {
  const headers = input.actor === "admin" ? adminHeaders : userHeaders;
  const events = await fetchNdjson(`http://127.0.0.1:${webPort}/api/chat/stream`, {
    method: "POST",
    headers: withJsonHeaders(headers),
    body: JSON.stringify({
      message: input.message
    })
  });

  const started = events.find((event) => event.type === "chat.started") ?? null;
  const completed = events.find((event) => event.type === "chat.completed") ?? null;
  const messageCompleted = events.find((event) => event.type === "message.completed") ?? null;
  const toolCallEvents = events.filter((event) => event.type === "tool.call");
  const targetedToolEvents = toolCallEvents.filter((event) => event.toolCall?.toolName === input.expectedToolName);
  const finalToolCall =
    targetedToolEvents.find((event) => event.toolCall?.status === "succeeded")?.toolCall ??
    targetedToolEvents[targetedToolEvents.length - 1]?.toolCall ??
    null;

  const metadataToolCalls = normalizeToolCalls(messageCompleted?.assistantMessage?.metadata?.toolCalls);
  const traceItems = started?.traceId ? await getTraceItems(started.traceId) : [];

  return {
    id: input.id,
    actor: input.actor,
    route: "/api/chat/stream",
    traceId: started?.traceId ?? null,
    streamEvents: {
      total: events.length,
      types: events.map((event) => event.type),
      toolCallStatuses: targetedToolEvents.map((event) => event.toolCall?.status ?? null)
    },
    verification: {
      toolName: finalToolCall?.toolName ?? null,
      toolCallStatus: finalToolCall?.status ?? null,
      args: finalToolCall?.args ?? null,
      outputSummary: readOutputSummary(finalToolCall),
      outputError: readOutputError(finalToolCall),
      assistantMetadataToolCallsCount: metadataToolCalls.length,
      assistantMetadataToolCalls: metadataToolCalls,
      traceStages: traceItems.map((item) => ({
        stage: item.stage,
        status: item.status,
        metadata: item.metadata
      }))
    },
    assertions: {
      streamHasStartedAndCompleted: Boolean(started && completed && messageCompleted),
      streamHasToolCallChain:
        targetedToolEvents.some((event) => event.toolCall?.status === "queued") &&
        targetedToolEvents.some((event) => event.toolCall?.status === "running") &&
        targetedToolEvents.some((event) => event.toolCall?.status === "succeeded"),
      argsMatched: partialDeepEqual(finalToolCall?.args ?? null, input.expectedArgs),
      assistantMetadataContainsToolCalls: metadataToolCalls.length > 0,
      traceStagesContainExpected: ["tool.plan", "tool.runtime.started", "tool.runtime.completed"].every((stage) =>
        traceItems.some((item) => item.stage === stage)
      )
    }
  };
}

function normalizeToolCalls(raw) {
  return Array.isArray(raw) ? raw : [];
}

function readOutputSummary(call) {
  if (!call || typeof call !== "object") return "";
  if (!call.output || typeof call.output !== "object") return "";
  return typeof call.output.summary === "string" ? call.output.summary : "";
}

function readOutputError(call) {
  if (!call || typeof call !== "object") return null;
  if (!call.output || typeof call.output !== "object") return null;
  return call.output.error ?? null;
}

function partialDeepEqual(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual === expected;
  }

  if (typeof expected !== "object" || Array.isArray(expected)) {
    return actual === expected;
  }

  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }

  return Object.entries(expected).every(([key, value]) => partialDeepEqual(actual[key], value));
}

async function getTraceItems(traceId) {
  const trace = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, {
    headers: {
      ...adminHeaders
    }
  });
  const records = trace.records ?? trace.items ?? [];
  return records.filter((item) => item.traceId === traceId);
}

function assertVerification(report) {
  const failures = [];

  for (const key of ["A", "B", "C", "D"]) {
    const scenario = report.scenarios[key];
    if (!scenario.assertions.toolNameMatched) failures.push(`scenario ${key} tool name mismatch`);
    if (!scenario.assertions.toolStatusMatched) failures.push(`scenario ${key} tool status mismatch`);
    if (!scenario.assertions.argsMatched) failures.push(`scenario ${key} args mismatch`);
    if (!scenario.assertions.outputSummaryMatched) failures.push(`scenario ${key} output summary/error mismatch`);
    if (!scenario.assertions.assistantMetadataContainsToolCalls) failures.push(`scenario ${key} assistant metadata missing toolCalls`);
    if (!scenario.assertions.traceStagesContainExpected) failures.push(`scenario ${key} trace missing required tool stages`);
  }

  const streamScenario = report.scenarios.E;
  if (!streamScenario.assertions.streamHasStartedAndCompleted) failures.push("scenario E stream chain incomplete");
  if (!streamScenario.assertions.streamHasToolCallChain) failures.push("scenario E tool.call status chain missing queued/running/succeeded");
  if (!streamScenario.assertions.argsMatched) failures.push("scenario E args mismatch");
  if (!streamScenario.assertions.assistantMetadataContainsToolCalls) failures.push("scenario E assistant metadata missing toolCalls");
  if (!streamScenario.assertions.traceStagesContainExpected) failures.push("scenario E trace missing required tool stages");

  const cStages = new Set((report.scenarios.C.verification.traceStages ?? []).map((item) => item.stage));
  if (cStages.has("tool.runtime.completed")) {
    failures.push("scenario C should not include tool.runtime.completed");
  }

  if (failures.length > 0) {
    throw new Error(`MCP runtime E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

async function fetchNdjson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed for ${url}: ${response.status} ${text}`);
  }

  if (!response.body) {
    throw new Error(`Streaming response body is empty for ${url}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }

  if (buffer.trim()) {
    events.push(JSON.parse(buffer));
  }

  return events;
}

function printSummary(report) {
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
