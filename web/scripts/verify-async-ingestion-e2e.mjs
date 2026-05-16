import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanupWindowsPorts,
  createRunContext,
  createSessionHeaders,
  ensureNextBuild,
  fetchJson,
  fetchText,
  prepareRunWorkspace,
  sleep,
  startProcess,
  stopProcess,
  waitForHealthy,
  withJsonHeaders
} from "./_shared/e2e-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const goRoot = path.join(repoRoot, "go", "retrievalexecutor");

const runContext = createRunContext({ repoRoot, tempNamespace: "async-ingestion-e2e" });
const { tempRoot, stateFilePath } = runContext;
const goTaskStorePath = path.join(tempRoot, "go-ingestion-task-store.json");
const goIndexStorePath = path.join(tempRoot, "go-index-store.json");
const goFailureTaskStorePath = path.join(tempRoot, "go-ingestion-task-store.failure.json");
const goFailureIndexPath = path.join(tempRoot, "go-broken-index-store");
const reportPath = path.join(tempRoot, "report.json");
const taskStoreBackend = String(process.env.GO_INGESTION_TASK_STORE_BACKEND ?? "json").trim().toLowerCase();

const goPort = Number(process.env.ASYNC_INGESTION_E2E_GO_PORT ?? "8295");
const goFailurePort = Number(process.env.ASYNC_INGESTION_E2E_GO_FAILURE_PORT ?? "8296");
const goRestartPort = Number(process.env.ASYNC_INGESTION_E2E_GO_RESTART_PORT ?? "8297");
const webPort = Number(process.env.ASYNC_INGESTION_E2E_WEB_PORT ?? "3301");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const adminHeaders = createSessionHeaders({
  role: "admin",
  userId: "async_ingestion_admin",
  userName: "Async Ingestion Admin",
  tenantId: "tenant_async_e2e",
  orgId: "org_async_e2e"
});
const userHeaders = createSessionHeaders({
  role: "user",
  userId: "async_ingestion_user",
  userName: "Async Ingestion User",
  tenantId: "tenant_async_e2e",
  orgId: "org_async_e2e"
});
const preconditions = {
  requiredEnv: [
    "ASYNC_INGESTION_E2E_GO_PORT",
    "ASYNC_INGESTION_E2E_GO_FAILURE_PORT",
    "ASYNC_INGESTION_E2E_GO_RESTART_PORT",
    "ASYNC_INGESTION_E2E_WEB_PORT"
  ],
  session: {
    admin: adminHeaders,
    user: userHeaders
  },
  externalDependencies: ["Go toolchain (build retrieval-service-e2e binary)", "Node.js/Next.js runtime"],
  blockedOrSkippedWhen: [
    "Unable to build Next app",
    "Unable to build Go retrieval-service binary",
    "Configured ports already occupied and cannot be reclaimed",
    "Session tenant/org scope is rejected by auth guard"
  ]
};

async function main() {
  await prepareRunWorkspace(runContext);
  await fs.mkdir(goFailureIndexPath, { recursive: true });
  await ensureNextBuild({ webRoot, nextCliPath, repoRoot });
  let goPrimary = null;
  let goFailure = null;
  let webApp = null;
  const children = [];

  try {
    goPrimary = startGoService({
      label: "go-primary",
      port: goPort,
      taskStorePath: goTaskStorePath,
      indexStorePath: goIndexStorePath,
      runnerEnabled: false,
      runnerInterval: "500ms"
    });
    children.push(goPrimary);

    webApp = startNextApp({
      label: "next-start",
      webPort,
      goPort
    });
    children.push(webApp);

    await waitForHealthy(`http://127.0.0.1:${goPort}/healthz`, "go-primary", children);
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/auth/session`, "next-start", children);

    const report = {
      environment: {
        runId: runContext.runId,
        goPort,
        goFailurePort,
        goRestartPort,
        webPort,
        stateFilePath,
        goTaskStorePath,
        goIndexStorePath,
        goFailureTaskStorePath,
        reportPath
      },
      preconditions,
      scenarios: {}
    };

    const scenarioA = await verifyScenarioA();
    report.scenarios.A = scenarioA;

    const scenarioB = await verifyScenarioB(scenarioA.taskId);
    report.scenarios.B = scenarioB;

    const scenarioC = await verifyScenarioC();
    report.scenarios.C = scenarioC;

    const scenarioD = await verifyScenarioD({
      knowledgeBaseId: scenarioA.knowledgeBaseId,
      documentId: scenarioA.documentId,
      token: scenarioA.queryToken
    });
    report.scenarios.D = scenarioD;

    const scenarioE = await verifyScenarioE({
      queryToken: scenarioA.queryToken,
      knowledgeBaseId: scenarioA.knowledgeBaseId
    });
    report.scenarios.E = scenarioE;

    goFailure = startGoService({
      label: "go-failure",
      port: goFailurePort,
      taskStorePath: goFailureTaskStorePath,
      indexStorePath: goFailureIndexPath,
      runnerEnabled: false,
      runnerInterval: "500ms"
    });
    children.push(goFailure);
    await waitForHealthy(`http://127.0.0.1:${goFailurePort}/healthz`, "go-failure", children);

    const scenarioF = await verifyScenarioF();
    report.scenarios.F = scenarioF;

    const scenarioG = await verifyRestartRecovery({
      restartPort: goRestartPort,
      goCommand: resolveGoRunCommand()
    });
    report.scenarios.G = scenarioG.report;
    children.push(scenarioG.newGoHandle);

    assertVerification(report);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    printSummary(report);
  } finally {
    await cleanupWindowsPorts([goPort, goFailurePort, goRestartPort, webPort]);
    await Promise.all(children.map(stopProcess));
  }
}
function startGoService({ label, port, taskStorePath, indexStorePath, runnerEnabled, runnerInterval }) {
  const goCommand = resolveGoRunCommand();
  const sqlitePath = deriveSqlitePath(taskStorePath);
  return startProcess({
    label,
    command: goCommand.command,
    args: goCommand.args,
    cwd: goRoot,
    env: {
      PORT: String(port),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      ...(sqlitePath ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: sqlitePath } : {}),
      GO_INGESTION_RUNNER_ENABLED: runnerEnabled ? "true" : "false",
      GO_INGESTION_RUNNER_INTERVAL: runnerInterval,
      GO_INGESTION_RUNNER_LIMIT: "2",
      GO_INGESTION_RUNNER_LEASE: "3s"
    },
    logRoot: tempRoot
  });
}

function startNextApp({ label, webPort, goPort }) {
  return startProcess({
    label,
    command: process.execPath,
    args: [nextCliPath, "start", "--port", String(webPort)],
    cwd: webRoot,
    env: {
      AUTH_PROVIDER_MODE: "mock",
      AUTH_MOCK_FALLBACK_ENABLED: "true",
      AUTH_HEADER_AUTH_ENABLED: "true",
      AUTH_MOCK_DEFAULT_ROLE: "admin",
      AUTH_MOCK_DEFAULT_USER_ID: "async_ingestion_admin",
      AUTH_MOCK_DEFAULT_USER_NAME: "Async Ingestion Admin",
      AUTH_MOCK_DEFAULT_TENANT_ID: "tenant_async_e2e",
      AUTH_MOCK_DEFAULT_ORG_ID: "org_async_e2e",
      TS_PLATFORM_STATE_PATH: stateFilePath,
      GO_INGESTION_BASE_URL: `http://127.0.0.1:${goPort}`,
      GO_RETRIEVAL_ENABLED: "true",
      GO_RETRIEVAL_ENDPOINT: `http://127.0.0.1:${goPort}/internal/retrieval/search`,
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      RAGENT_FORCE_LOCAL_GENERATION: "true"
    },
    logRoot: tempRoot
  });
}

async function verifyScenarioA() {
  const token = uniqueToken("async-a");
  const payload = buildIngestionPayload({
    traceId: uniqueToken("trace-a"),
    documentId: uniqueToken("doc-a"),
    queryToken: token
  });

  const startedAt = Date.now();
  const created = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: withJsonHeaders(adminHeaders),
    body: JSON.stringify(payload)
  });
  const elapsedMs = Date.now() - startedAt;
  const fetched = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);

  return {
    taskId: created.taskId,
    knowledgeBaseId: payload.knowledgeBaseId,
    documentId: payload.documentId,
    queryToken: token,
    initialStatus: created.status,
    initialStage: created.currentStage,
    finalStatus: fetched.status,
    finalStage: fetched.currentStage,
    attemptCount: fetched.attemptCount,
    traceStages: fetched.trace.map((event) => event.stage),
    indexedRecordCount: fetched.indexWriteResult?.recordCount ?? 0,
    retrievalSource: "not-yet-run",
    chatEvidenceCount: 0,
    createLatencyMs: elapsedMs
  };
}

async function verifyScenarioB(taskId) {
  const initial = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(taskId)}`);
  const runResult = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST"
  });
  const fetched = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(taskId)}`);

  return {
    taskId,
    initialStatus: initial.status,
    initialStage: initial.currentStage,
    finalStatus: fetched.status,
    finalStage: fetched.currentStage,
    attemptCount: fetched.attemptCount,
    traceStages: fetched.trace.map((event) => event.stage),
    indexedRecordCount: fetched.indexWriteResult?.recordCount ?? 0,
    retrievalSource: "not-yet-run",
    chatEvidenceCount: 0,
    runResponseStatus: runResult.status
  };
}

async function verifyScenarioC() {
  const token = uniqueToken("async-c");
  const payload = buildIngestionPayload({
    traceId: uniqueToken("trace-c"),
    documentId: uniqueToken("doc-c"),
    queryToken: token
  });
  const created = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const summary = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/worker/run?limit=2`, {
    method: "POST"
  });
  const fetched = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);

  return {
    taskId: created.taskId,
    initialStatus: created.status,
    initialStage: created.currentStage,
    finalStatus: fetched.status,
    finalStage: fetched.currentStage,
    attemptCount: fetched.attemptCount,
    traceStages: fetched.trace.map((event) => event.stage),
    indexedRecordCount: fetched.indexWriteResult?.recordCount ?? 0,
    retrievalSource: "not-yet-run",
    chatEvidenceCount: 0,
    workerRunSummary: summary
  };
}

async function verifyScenarioD({ knowledgeBaseId, documentId, token }) {
  const retrieval = await fetchJson(`http://127.0.0.1:${goPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: uniqueToken("trace-d"),
      query: `${token} asynchronous ingestion evidence`,
      knowledgeBaseIds: [knowledgeBaseId],
      topK: 3,
      filters: {}
    })
  });

  const storePayload = JSON.parse(await fs.readFile(goIndexStorePath, "utf8"));
  const storeRecords = Array.isArray(storePayload.records) ? storePayload.records : [];
  const matchingRecords = storeRecords.filter((record) => readRecordField(record, "documentId") === documentId);

  return {
    taskId: "n/a",
    initialStatus: "n/a",
    initialStage: "n/a",
    finalStatus: "n/a",
    finalStage: "n/a",
    attemptCount: 0,
    traceStages: [],
    indexedRecordCount: matchingRecords.length,
    retrievalSource: retrieval.source,
    chatEvidenceCount: 0,
    retrievalChunkCount: retrieval.chunks.length,
    topChunkDocumentId: retrieval.chunks[0]?.documentId ?? null
  };
}

async function verifyScenarioE({ queryToken }) {
  const chat = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: `According to the policy document, what approval does ${queryToken} require?`
    })
  });
  const traces = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, {
    headers: adminHeaders
  });
  const traceRecords = traces.records ?? traces.items ?? [];
  const chatTraceItems = traceRecords.filter((item) => item.traceId === chat.traceId);
  const contextStage = chatTraceItems.find((item) => item.stage === "context.assembly");
  const chatEvidenceCount = Number(contextStage?.metadata?.evidenceCount ?? 0);

  const streamResponse = await fetchText(`http://127.0.0.1:${webPort}/api/chat/stream`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: `Please confirm again from the policy document what ${queryToken} requires.`
    })
  });
  const streamEvents = parseNdjson(streamResponse);
  const streamCompleted = streamEvents.find((event) => event.type === "message.completed");
  const streamTraceId = streamCompleted?.traceId ?? null;
  const streamTraceResponse = streamTraceId
    ? await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, {
        headers: adminHeaders
      })
    : null;
  const streamTraceRecords = streamTraceResponse ? streamTraceResponse.records ?? streamTraceResponse.items ?? [] : [];
  const streamTraces = streamTraceRecords.filter((item) => item.traceId === streamTraceId);
  const streamContextStage = streamTraces.find((item) => item.stage === "context.assembly");
  const streamEvidenceCount = Number(streamContextStage?.metadata?.evidenceCount ?? 0);

  return {
    taskId: "n/a",
    initialStatus: "n/a",
    initialStage: "n/a",
    finalStatus: "n/a",
    finalStage: "n/a",
    attemptCount: 0,
    traceStages: chatTraceItems.map((item) => item.stage),
    indexedRecordCount: 0,
    retrievalSource: chat.assistantMessage?.metadata?.retrievalSource ?? null,
    chatEvidenceCount,
    streamRetrievalSource: streamCompleted?.assistantMessage?.metadata?.retrievalSource ?? null,
    streamEvidenceCount
  };
}

async function verifyScenarioF() {
  const retryPayload = buildIngestionPayload({
    traceId: uniqueToken("trace-f-retry"),
    documentId: uniqueToken("doc-f-retry"),
    queryToken: uniqueToken("failure-retry"),
    metadata: {
      initiatedFrom: "verify-async-ingestion-e2e-retry"
    }
  });
  const retryTask = await fetchJson(`http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(retryPayload)
  });
  await fetchJson(`http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks/${encodeURIComponent(retryTask.taskId)}/run`, {
    method: "POST"
  });
  const retryResult = await fetchJson(
    `http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks/${encodeURIComponent(retryTask.taskId)}`
  );

  const terminalPayload = buildIngestionPayload({
    traceId: uniqueToken("trace-f-terminal"),
    documentId: uniqueToken("doc-f-terminal"),
    queryToken: uniqueToken("failure-terminal"),
    metadata: {
      initiatedFrom: "verify-async-ingestion-e2e-terminal",
      maxAttempts: 1
    }
  });
  const terminalTask = await fetchJson(`http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(terminalPayload)
  });
  await fetchJson(`http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks/${encodeURIComponent(terminalTask.taskId)}/run`, {
    method: "POST"
  });
  const terminalResult = await fetchJson(
    `http://127.0.0.1:${goFailurePort}/internal/ingestion/tasks/${encodeURIComponent(terminalTask.taskId)}`
  );

  return {
    taskId: retryTask.taskId,
    initialStatus: retryTask.status,
    initialStage: retryTask.currentStage,
    finalStatus: retryResult.status,
    finalStage: retryResult.currentStage,
    attemptCount: retryResult.attemptCount,
    traceStages: retryResult.trace.map((event) => event.stage),
    indexedRecordCount: retryResult.indexWriteResult?.recordCount ?? 0,
    retrievalSource: "not-yet-run",
    chatEvidenceCount: 0,
    retryCase: {
      taskId: retryTask.taskId,
      finalStatus: retryResult.status,
      finalStage: retryResult.currentStage,
      retryable: retryResult.retryable,
      retryAfterSec: retryResult.retryAfterSec,
      failureStage: retryResult.failureStage,
      failureReason: retryResult.failureReason,
      traceStages: retryResult.trace.map((event) => event.stage)
    },
    terminalCase: {
      taskId: terminalTask.taskId,
      finalStatus: terminalResult.status,
      finalStage: terminalResult.currentStage,
      retryable: terminalResult.retryable,
      retryAfterSec: terminalResult.retryAfterSec,
      failureStage: terminalResult.failureStage,
      failureReason: terminalResult.failureReason,
      traceStages: terminalResult.trace.map((event) => event.stage)
    }
  };
}

async function verifyRestartRecovery({ restartPort, goCommand }) {
  const pendingPayload = buildIngestionPayload({
    traceId: uniqueToken("trace-g-pending"),
    documentId: uniqueToken("doc-g-pending"),
    queryToken: uniqueToken("restart-pending")
  });
  const runningPayload = buildIngestionPayload({
    traceId: uniqueToken("trace-g-running"),
    documentId: uniqueToken("doc-g-running"),
    queryToken: uniqueToken("restart-running")
  });

  const pendingTask = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pendingPayload)
  });
  const runningTask = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(runningPayload)
  });

  await mutateTaskToExpiredRunning(goTaskStorePath, runningTask.taskId);
  const newGoHandle = startGoService({
    label: "go-primary-restarted",
    port: restartPort,
    taskStorePath: goTaskStorePath,
    indexStorePath: goIndexStorePath,
    runnerEnabled: true,
    runnerInterval: "500ms"
  });
  await waitForHealthy(`http://127.0.0.1:${restartPort}/healthz`, "go-primary-restarted", [newGoHandle]);

  const recoveredPending = await waitForTaskStatus(restartPort, pendingTask.taskId, (task) => task.status === "succeeded");
  const recoveredRunning = await waitForTaskStatus(restartPort, runningTask.taskId, (task) => task.status === "succeeded");

  return {
    newGoHandle,
    report: {
      taskId: pendingTask.taskId,
      initialStatus: pendingTask.status,
      initialStage: pendingTask.currentStage,
      finalStatus: recoveredPending.status,
      finalStage: recoveredPending.currentStage,
      attemptCount: recoveredPending.attemptCount,
      traceStages: recoveredPending.trace.map((event) => event.stage),
      indexedRecordCount: recoveredPending.indexWriteResult?.recordCount ?? 0,
      retrievalSource: "not-yet-run",
      chatEvidenceCount: 0,
      pendingRecovery: {
        taskId: pendingTask.taskId,
        finalStatus: recoveredPending.status,
        finalStage: recoveredPending.currentStage,
        attemptCount: recoveredPending.attemptCount
      },
      runningRecovery: {
        taskId: runningTask.taskId,
        finalStatus: recoveredRunning.status,
        finalStage: recoveredRunning.currentStage,
        attemptCount: recoveredRunning.attemptCount
      }
    }
  };
}

function assertVerification(report) {
  const failures = [];
  const { A, B, C, D, E, F, G } = report.scenarios;

  if (!A.taskId) failures.push("scenario A: taskId missing");
  if (A.initialStatus !== "pending" || A.initialStage !== "queued") {
    failures.push(`scenario A: expected pending/queued, got ${A.initialStatus}/${A.initialStage}`);
  }
  if (A.createLatencyMs > 3000) failures.push(`scenario A: create latency too high (${A.createLatencyMs}ms)`);

  if (B.finalStatus !== "succeeded" || B.finalStage !== "completed") {
    failures.push(`scenario B: expected succeeded/completed, got ${B.finalStatus}/${B.finalStage}`);
  }
  if (B.indexedRecordCount <= 0) failures.push("scenario B: expected indexed records > 0");

  if (!C.workerRunSummary || Number(C.workerRunSummary.claimed ?? 0) < 1) {
    failures.push(`scenario C: worker run did not claim task (${JSON.stringify(C.workerRunSummary)})`);
  }
  if (C.finalStatus !== "succeeded" || C.finalStage !== "completed") {
    failures.push(`scenario C: expected succeeded/completed, got ${C.finalStatus}/${C.finalStage}`);
  }

  if (D.retrievalSource !== "indexed-store") failures.push(`scenario D: expected indexed-store, got ${D.retrievalSource}`);
  if (D.retrievalChunkCount <= 0) failures.push("scenario D: expected retrieval chunks > 0");

  if (E.retrievalSource !== "indexed-store") failures.push(`scenario E: /api/chat retrieval source is ${E.retrievalSource}`);
  if (E.chatEvidenceCount <= 0) failures.push("scenario E: /api/chat evidenceCount <= 0");
  if (E.streamRetrievalSource !== "indexed-store") {
    failures.push(`scenario E: /api/chat/stream retrieval source is ${E.streamRetrievalSource}`);
  }
  if (E.streamEvidenceCount <= 0) failures.push("scenario E: /api/chat/stream evidenceCount <= 0");

  if (F.retryCase.finalStatus !== "pending" || F.retryCase.finalStage !== "queued" || !F.retryCase.retryable) {
    failures.push(
      `scenario F retry: expected pending/queued and retryable=true, got ${F.retryCase.finalStatus}/${F.retryCase.finalStage} retryable=${F.retryCase.retryable}`
    );
  }
  if (!F.retryCase.traceStages.includes("retry-scheduled")) {
    failures.push("scenario F retry: trace missing retry-scheduled");
  }
  if (F.terminalCase.finalStatus !== "failed" || F.terminalCase.finalStage !== "failed" || F.terminalCase.retryable) {
    failures.push(
      `scenario F terminal: expected failed/failed and retryable=false, got ${F.terminalCase.finalStatus}/${F.terminalCase.finalStage} retryable=${F.terminalCase.retryable}`
    );
  }
  if (!F.terminalCase.failureReason || !F.terminalCase.failureStage) {
    failures.push("scenario F terminal: failure metadata missing");
  }

  if (G.pendingRecovery.finalStatus !== "succeeded" || G.runningRecovery.finalStatus !== "succeeded") {
    failures.push(`scenario G: restart recovery failed (${JSON.stringify(G)})`);
  }

  if (failures.length > 0) {
    throw new Error(`Async ingestion E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function buildIngestionPayload({ traceId, documentId, queryToken, metadata = {} }) {
  const markdown = [
    `# Async Ingestion Evidence ${queryToken}`,
    "",
    `${queryToken} requires manager approval within two business days.`,
    "",
    "## Worker Notes",
    "",
    "Include trace stages, attempt counts, and indexed retrieval diagnostics."
  ].join("\n");

  return {
    traceId,
    knowledgeBaseId: "kb_policy",
    documentId,
    requestedBy: "async-ingestion-e2e-script",
    source: {
      sourceType: "upload",
      uri: `data:text/markdown;base64,${Buffer.from(markdown, "utf8").toString("base64")}`,
      filename: `async-${queryToken}.md`,
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
        enabled: true,
        model: "mock-embedding-v1",
        adapter: "deterministic"
      },
      indexing: {
        enabled: true,
        indexName: "kb_policy",
        storeType: "json-file"
      }
    },
    metadata: {
      initiatedFrom: "verify-async-ingestion-e2e",
      ...metadata
    }
  };
}

async function mutateTaskToExpiredRunning(taskStorePath, taskId) {
  if (taskStoreBackend === "sqlite") {
    const sqlitePath = deriveSqlitePath(taskStorePath);
    if (!sqlitePath) {
      throw new Error("sqlite backend selected but sqlite path is not configured");
    }
    await mutateTaskToExpiredRunningSqlite(sqlitePath, taskId);
    return;
  }

  const payload = JSON.parse(await fs.readFile(taskStorePath, "utf8"));
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const now = new Date();
  const expired = new Date(now.getTime() - 60_000).toISOString();
  const updated = now.toISOString();

  let found = false;
  for (const task of tasks) {
    const storedTaskId = readRecordField(task, "taskId");
    if (storedTaskId !== taskId) continue;
    found = true;
    const statusKey = "status" in task ? "status" : "Status";
    const currentStageKey = "currentStage" in task ? "currentStage" : "CurrentStage";
    const attemptCountKey = "attemptCount" in task ? "attemptCount" : "AttemptCount";
    const updatedAtKey = "updatedAt" in task ? "updatedAt" : "UpdatedAt";
    const startedAtKey = "startedAt" in task ? "startedAt" : "StartedAt";
    const finishedAtKey = "finishedAt" in task ? "finishedAt" : "FinishedAt";
    const retryableKey = "retryable" in task ? "retryable" : "Retryable";
    const nextRunAtKey = "nextRunAt" in task ? "nextRunAt" : "NextRunAt";
    const retryAfterSecKey = "retryAfterSec" in task ? "retryAfterSec" : "RetryAfterSec";
    const metadataKey = "metadata" in task ? "metadata" : "Metadata";

    task[statusKey] = "running";
    task[currentStageKey] = "parser";
    task[attemptCountKey] = Math.max(Number(task[attemptCountKey] ?? 0), 1);
    task[updatedAtKey] = updated;
    task[startedAtKey] = task[startedAtKey] ?? updated;
    task[finishedAtKey] = "";
    task[retryableKey] = false;
    task[nextRunAtKey] = "";
    task[retryAfterSecKey] = 0;
    task[metadataKey] = {
      ...(task[metadataKey] ?? {}),
      claimedBy: "manual-restart-fixture",
      leaseExpiresAt: expired,
      lastClaimedAt: expired,
      executionSource: "go-ingestion-worker"
    };
  }

  if (!found) {
    throw new Error(`task ${taskId} not found when mutating running recovery fixture`);
  }

  await fs.writeFile(taskStorePath, JSON.stringify(payload, null, 2), "utf8");
}

async function mutateTaskToExpiredRunningSqlite(sqlitePath, taskId) {
  const now = new Date();
  const expired = new Date(now.getTime() - 60_000).toISOString();
  const updated = now.toISOString();

  const taskJSONRaw = (await runSqlite(sqlitePath, `SELECT task_json FROM ingestion_tasks WHERE task_id='${sqlEscape(taskId)}' LIMIT 1;`)).trim();
  if (!taskJSONRaw) {
    throw new Error(`task ${taskId} not found when mutating sqlite recovery fixture`);
  }
  const task = JSON.parse(taskJSONRaw);
  task.status = "running";
  task.currentStage = "parser";
  task.attemptCount = Math.max(Number(task.attemptCount ?? 0), 1);
  task.updatedAt = updated;
  task.startedAt = task.startedAt || updated;
  task.finishedAt = "";
  task.retryable = false;
  task.nextRunAt = "";
  task.retryAfterSec = 0;
  task.metadata = {
    ...(task.metadata ?? {}),
    claimedBy: "manual-restart-fixture",
    leaseExpiresAt: expired,
    lastClaimedAt: expired,
    executionSource: "go-ingestion-worker"
  };

  const taskJSON = JSON.stringify(task);
  const sql = [
    "BEGIN TRANSACTION;",
    `UPDATE ingestion_tasks SET
      status='running',
      current_stage='parser',
      attempt_count=${Math.max(Number(task.attemptCount ?? 1), 1)},
      retryable=0,
      next_run_at='',
      updated_at='${sqlEscape(updated)}',
      lease_expires_at='${sqlEscape(expired)}',
      task_json='${sqlEscape(taskJSON)}'
      WHERE task_id='${sqlEscape(taskId)}';`,
    "COMMIT;"
  ].join("\n");
  await runSqlite(sqlitePath, sql);
}

function deriveSqlitePath(taskStorePath) {
  if (taskStoreBackend !== "sqlite") {
    return "";
  }
  // Prefer run-scoped sqlite path so smoke remains isolated from parent shell env.
  if (taskStorePath) {
    if (taskStorePath.endsWith(".json")) {
      return taskStorePath.slice(0, -".json".length) + ".db";
    }
    return `${taskStorePath}.db`;
  }

  const explicit = String(process.env.GO_INGESTION_TASK_STORE_SQLITE_PATH ?? "").trim();
  if (explicit) {
    return explicit;
  }
  return "";
}

async function runSqlite(sqlitePath, sql) {
  const sqliteCommand = process.env.SQLITE3_BIN || "sqlite3";
  return new Promise((resolve, reject) => {
    execFile(sqliteCommand, [sqlitePath, sql], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`sqlite command failed (${sqlitePath}): ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function waitForTaskStatus(port, taskId, predicate, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = await fetchJson(`http://127.0.0.1:${port}/internal/ingestion/tasks/${encodeURIComponent(taskId)}`);
    if (predicate(task)) {
      return task;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for task ${taskId} on port ${port}`);
}

function parseNdjson(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readRecordField(record, camelCaseName) {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  if (camelCaseName in record) {
    return record[camelCaseName];
  }
  const pascalCaseName = camelCaseName[0].toUpperCase() + camelCaseName.slice(1);
  if (pascalCaseName in record) {
    return record[pascalCaseName];
  }
  return record[pascalCaseName.replace(/Id$/, "ID")];
}

function uniqueToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveGoRunCommand() {
  if (process.platform === "win32") {
    return {
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-Command", "go run ./cmd/retrieval-service"]
    };
  }
  return {
    command: "go",
    args: ["run", "./cmd/retrieval-service"]
  };
}


function printSummary(report) {
  const summary = {
    reportPath,
    A: {
      taskId: report.scenarios.A.taskId,
      initialStatus: report.scenarios.A.initialStatus,
      initialStage: report.scenarios.A.initialStage,
      finalStatus: report.scenarios.A.finalStatus,
      finalStage: report.scenarios.A.finalStage,
      attemptCount: report.scenarios.A.attemptCount,
      traceStages: report.scenarios.A.traceStages,
      indexedRecordCount: report.scenarios.A.indexedRecordCount,
      retrievalSource: report.scenarios.A.retrievalSource,
      chatEvidenceCount: report.scenarios.A.chatEvidenceCount
    },
    B: {
      taskId: report.scenarios.B.taskId,
      initialStatus: report.scenarios.B.initialStatus,
      initialStage: report.scenarios.B.initialStage,
      finalStatus: report.scenarios.B.finalStatus,
      finalStage: report.scenarios.B.finalStage,
      attemptCount: report.scenarios.B.attemptCount,
      traceStages: report.scenarios.B.traceStages,
      indexedRecordCount: report.scenarios.B.indexedRecordCount,
      retrievalSource: report.scenarios.B.retrievalSource,
      chatEvidenceCount: report.scenarios.B.chatEvidenceCount
    },
    C: {
      taskId: report.scenarios.C.taskId,
      initialStatus: report.scenarios.C.initialStatus,
      initialStage: report.scenarios.C.initialStage,
      finalStatus: report.scenarios.C.finalStatus,
      finalStage: report.scenarios.C.finalStage,
      attemptCount: report.scenarios.C.attemptCount,
      traceStages: report.scenarios.C.traceStages,
      indexedRecordCount: report.scenarios.C.indexedRecordCount,
      retrievalSource: report.scenarios.C.retrievalSource,
      chatEvidenceCount: report.scenarios.C.chatEvidenceCount
    },
    D: {
      taskId: report.scenarios.D.taskId,
      indexedRecordCount: report.scenarios.D.indexedRecordCount,
      retrievalSource: report.scenarios.D.retrievalSource,
      chatEvidenceCount: report.scenarios.D.chatEvidenceCount
    },
    E: {
      taskId: report.scenarios.E.taskId,
      retrievalSource: report.scenarios.E.retrievalSource,
      chatEvidenceCount: report.scenarios.E.chatEvidenceCount
    },
    F: {
      taskId: report.scenarios.F.taskId,
      initialStatus: report.scenarios.F.initialStatus,
      initialStage: report.scenarios.F.initialStage,
      finalStatus: report.scenarios.F.finalStatus,
      finalStage: report.scenarios.F.finalStage,
      attemptCount: report.scenarios.F.attemptCount,
      traceStages: report.scenarios.F.traceStages,
      indexedRecordCount: report.scenarios.F.indexedRecordCount,
      retrievalSource: report.scenarios.F.retrievalSource,
      chatEvidenceCount: report.scenarios.F.chatEvidenceCount
    },
    G: {
      taskId: report.scenarios.G.taskId,
      initialStatus: report.scenarios.G.initialStatus,
      initialStage: report.scenarios.G.initialStage,
      finalStatus: report.scenarios.G.finalStatus,
      finalStage: report.scenarios.G.finalStage,
      attemptCount: report.scenarios.G.attemptCount,
      traceStages: report.scenarios.G.traceStages,
      indexedRecordCount: report.scenarios.G.indexedRecordCount,
      retrievalSource: report.scenarios.G.retrievalSource,
      chatEvidenceCount: report.scenarios.G.chatEvidenceCount
    }
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
