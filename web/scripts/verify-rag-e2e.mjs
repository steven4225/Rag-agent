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
  fetchText,
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
const goRoot = path.join(repoRoot, "go", "retrievalexecutor");
const runContext = createRunContext({ repoRoot, tempNamespace: "rag-e2e" });
const { tempRoot, stateFilePath } = runContext;
const indexFilePath = path.join(tempRoot, "go-index-store.json");
const taskStorePath = path.join(tempRoot, "go-ingestion-task-store.json");
const errorTaskStorePath = path.join(tempRoot, "go-ingestion-task-store.error.json");
const reportPath = path.join(tempRoot, "report.json");
const taskStoreBackend = String(process.env.GO_INGESTION_TASK_STORE_BACKEND ?? "json").trim().toLowerCase();
const primaryGoPort = Number(process.env.RAG_E2E_GO_PORT ?? "8195");
const errorGoPort = Number(process.env.RAG_E2E_GO_ERROR_PORT ?? "8196");
const webPort = Number(process.env.RAG_E2E_WEB_PORT ?? "3201");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const adminHeaders = createSessionHeaders({
  role: "admin",
  userId: "rag_e2e_admin",
  userName: "RAG E2E Admin",
  tenantId: "tenant_rag_e2e",
  orgId: "org_rag_e2e"
});
const userHeaders = createSessionHeaders({
  role: "user",
  userId: "rag_e2e_user",
  userName: "RAG E2E User",
  tenantId: "tenant_rag_e2e",
  orgId: "org_rag_e2e"
});
const preconditions = {
  requiredEnv: ["RAG_E2E_GO_PORT", "RAG_E2E_GO_ERROR_PORT", "RAG_E2E_WEB_PORT"],
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
  await ensureNextBuild({ webRoot, nextCliPath, repoRoot });
  const goCommand = resolveGoRunCommand();

  const primaryGo = startProcess({
    command: goCommand.command,
    args: goCommand.args,
    cwd: goRoot,
    env: {
      PORT: String(primaryGoPort),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexFilePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      ...(deriveSqlitePath(taskStorePath) ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: deriveSqlitePath(taskStorePath) } : {}),
      GO_INGESTION_RUNNER_ENABLED: "false",
      GO_INGESTION_RUNNER_INTERVAL: "500ms",
      GO_INGESTION_RUNNER_LIMIT: "2",
      GO_INGESTION_RUNNER_LEASE: "3s"
    },
    label: "go-primary",
    logRoot: tempRoot
  });

  const errorGo = startProcess({
    command: goCommand.command,
    args: goCommand.args,
    cwd: goRoot,
    env: {
      PORT: String(errorGoPort),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: tempRoot,
      GO_INGESTION_TASK_STORE_PATH: errorTaskStorePath,
      ...(deriveSqlitePath(errorTaskStorePath)
        ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: deriveSqlitePath(errorTaskStorePath) }
        : {}),
      GO_INGESTION_RUNNER_ENABLED: "false",
      GO_INGESTION_RUNNER_INTERVAL: "500ms",
      GO_INGESTION_RUNNER_LIMIT: "2",
      GO_INGESTION_RUNNER_LEASE: "3s"
    },
    label: "go-error",
    logRoot: tempRoot
  });

  const nextStart = startProcess({
    command: process.execPath,
    args: [nextCliPath, "start", "--port", String(webPort)],
    cwd: webRoot,
    env: {
      AUTH_PROVIDER_MODE: "mock",
      AUTH_MOCK_FALLBACK_ENABLED: "true",
      AUTH_HEADER_AUTH_ENABLED: "true",
      AUTH_MOCK_DEFAULT_ROLE: "admin",
      AUTH_MOCK_DEFAULT_USER_ID: "rag_e2e_admin",
      AUTH_MOCK_DEFAULT_USER_NAME: "RAG E2E Admin",
      AUTH_MOCK_DEFAULT_TENANT_ID: "tenant_rag_e2e",
      AUTH_MOCK_DEFAULT_ORG_ID: "org_rag_e2e",
      TS_PLATFORM_STATE_PATH: stateFilePath,
      GO_INGESTION_BASE_URL: `http://127.0.0.1:${primaryGoPort}`,
      GO_RETRIEVAL_ENABLED: "true",
      GO_RETRIEVAL_ENDPOINT: `http://127.0.0.1:${primaryGoPort}/internal/retrieval/search`,
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      RAGENT_FORCE_LOCAL_GENERATION: "true"
    },
    label: "next-start",
    logRoot: tempRoot
  });

  const children = [primaryGo, errorGo, nextStart];

  try {
    await waitForHealthy(`http://127.0.0.1:${primaryGoPort}/healthz`, "go-primary", children);
    await waitForHealthy(`http://127.0.0.1:${errorGoPort}/healthz`, "go-error", children);
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/auth/session`, "next-start", children);

    const report = await runVerification();
    assertVerification(report);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    printSummary(report);
  } finally {
    await cleanupWindowsPorts([primaryGoPort, errorGoPort, webPort]);
    await Promise.all(children.map(stopProcess));
  }
}

async function runVerification() {
  const uniqueToken = `nebula-retention-${Date.now()}`;
  const ingestionTraceId = `ingest_verify_${Date.now()}`;
  const documentId = `doc_verify_${Date.now()}`;
  const markdown = [
    `# Policy Validation ${uniqueToken}`,
    "",
    `The ${uniqueToken} clause requires manager approval within two business days.`,
    "",
    "## Operations",
    "",
    "Escalations should include trace metadata and indexed retrieval diagnostics."
  ].join("\n");

  const createTaskPayload = {
    traceId: ingestionTraceId,
    knowledgeBaseId: "kb_policy",
    documentId,
    requestedBy: "rag-e2e-script",
    source: {
      sourceType: "upload",
      uri: `data:text/markdown;base64,${Buffer.from(markdown, "utf8").toString("base64")}`,
      filename: `policy-${uniqueToken}.md`,
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
      initiatedFrom: "verify-rag-e2e-script"
    }
  };

  const scenarioA = {};
  const createdTask = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: withJsonHeaders(adminHeaders),
    body: JSON.stringify(createTaskPayload)
  });
  if (createdTask.status !== "succeeded") {
    await fetchJson(`http://127.0.0.1:${primaryGoPort}/internal/ingestion/tasks/${encodeURIComponent(createdTask.taskId)}/run`, {
      method: "POST"
    });
  }
  const finalizedTask = await fetchJson(`http://127.0.0.1:${primaryGoPort}/internal/ingestion/tasks/${encodeURIComponent(createdTask.taskId)}`);
  const ingestionReadModel = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    headers: adminHeaders
  });
  const indexStorePayload = JSON.parse(await fs.readFile(indexFilePath, "utf8"));
  const indexRecords = indexStorePayload.records ?? [];
  const createdTaskReadModel = ingestionReadModel.items.find((item) => item.taskId === createdTask.taskId);
  Object.assign(scenarioA, {
    taskId: createdTask.taskId,
    traceId: createdTask.traceId,
    status: finalizedTask.status,
    retrievalSource: "not-applicable",
    parserName: finalizedTask.parserResult?.parserName ?? null,
    chunkCount: finalizedTask.chunks?.length ?? 0,
    indexedRecordCount: finalizedTask.indexWriteResult?.recordCount ?? 0,
    indexStoreRecordCount: indexRecords.length,
    indexStoreMatchedRecordIds: indexRecords
      .filter((record) => readField(record, "documentId") === documentId)
      .map((record) => readField(record, "recordId")),
    adminIngestionVisible: Boolean(createdTaskReadModel),
    adminIngestionSummary: createdTaskReadModel?.summary ?? null,
    traceMetadataStages: finalizedTask.trace.map((event) => ({
      stage: event.stage,
      status: event.status,
      metadataKeys: Object.keys(event.metadata ?? {})
    }))
  });

  const scenarioBSearch = await fetchJson(`http://127.0.0.1:${primaryGoPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: `retrieval_verify_${Date.now()}`,
      query: `${uniqueToken} manager approval`,
      knowledgeBaseIds: ["kb_policy"],
      topK: 3,
      filters: {}
    })
  });
  const scenarioB = {
    retrievalSource: scenarioBSearch.source,
    chunkCount: scenarioBSearch.chunks.length,
    topChunkDocumentId: scenarioBSearch.chunks[0]?.documentId ?? null,
    topChunkSource: scenarioBSearch.chunks[0]?.source ?? null,
    topChunkMetadata: scenarioBSearch.chunks[0]?.metadata ?? null,
    chatVisible: "not-applicable",
    adminTraceVisible: "not-applicable"
  };

  const scenarioCChat = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: `According to the policy document, what does ${uniqueToken} require?`
    })
  });
  const traceReadModelAfterChat = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, {
    headers: adminHeaders
  });
  const traceRecordsAfterChat = traceReadModelAfterChat.records ?? traceReadModelAfterChat.items ?? [];
  const scenarioCTraceItems = traceRecordsAfterChat.filter((item) => item.traceId === scenarioCChat.traceId);
  const scenarioC = {
    retrievalSource: scenarioCChat.assistantMessage.metadata?.retrievalSource ?? null,
    fallbackReason: scenarioCChat.assistantMessage.metadata?.fallbackReason ?? null,
    answerPreview: scenarioCChat.assistantMessage.content,
    traceStageCount: scenarioCTraceItems.length,
    traceStages: scenarioCTraceItems.map((item) => ({
      stage: item.stage,
      status: item.status,
      metadata: item.metadata
    })),
    adminTraceVisible: scenarioCTraceItems.length > 0
  };

  const scenarioDNoResultChat = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: "According to the ops runbook, what happens in a priority 1 incident?"
    })
  });
  const traceReadModelAfterNoResult = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, {
    headers: adminHeaders
  });
  const traceRecordsAfterNoResult = traceReadModelAfterNoResult.records ?? traceReadModelAfterNoResult.items ?? [];
  const scenarioDNoResultTrace = traceRecordsAfterNoResult.filter((item) => item.traceId === scenarioDNoResultChat.traceId);
  const scenarioDErrorRetrieval = await fetchJson(`http://127.0.0.1:${errorGoPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: `retrieval_error_${Date.now()}`,
      query: "leave policy manager approval",
      knowledgeBaseIds: ["kb_policy"],
      topK: 3,
      filters: {}
    })
  });

  const ingestionPage = await fetchText(`http://127.0.0.1:${webPort}/admin/ingestion`, {
    headers: {
      cookie: buildSessionCookie({
        userId: adminHeaders["x-ragent-user-id"],
        role: adminHeaders["x-ragent-role"],
        name: adminHeaders["x-ragent-user-name"],
        tenantId: adminHeaders["x-ragent-tenant-id"],
        orgId: adminHeaders["x-ragent-org-id"]
      })
    }
  });
  const tracesPage = await fetchText(`http://127.0.0.1:${webPort}/admin/traces`, {
    headers: {
      cookie: buildSessionCookie({
        userId: adminHeaders["x-ragent-user-id"],
        role: adminHeaders["x-ragent-role"],
        name: adminHeaders["x-ragent-user-name"],
        tenantId: adminHeaders["x-ragent-tenant-id"],
        orgId: adminHeaders["x-ragent-org-id"]
      })
    }
  });

  return {
    preconditions,
    environment: {
      runId: runContext.runId,
      webPort,
      primaryGoPort,
      errorGoPort,
      stateFilePath,
      indexFilePath,
      reportPath
    },
    pages: {
      ingestionPageShell: ingestionPage.includes("Ingestion"),
      tracesPageShell: tracesPage.includes("Traces")
    },
    scenarios: {
      A: scenarioA,
      B: scenarioB,
      C: scenarioC,
      D: {
        noResultChat: {
          retrievalSource: scenarioDNoResultChat.assistantMessage.metadata?.retrievalSource ?? null,
          fallbackReason: scenarioDNoResultChat.assistantMessage.metadata?.fallbackReason ?? null,
          answerPreview: scenarioDNoResultChat.assistantMessage.content,
          traceStages: scenarioDNoResultTrace.map((item) => ({
            stage: item.stage,
            status: item.status,
            metadata: item.metadata
          }))
        },
        indexedStoreUnavailableRetrieval: {
          retrievalSource: scenarioDErrorRetrieval.source,
          chunkCount: scenarioDErrorRetrieval.chunks.length,
          topChunkMetadata: scenarioDErrorRetrieval.chunks[0]?.metadata ?? null
        }
      }
    }
  };
}

function readField(record, camelCaseName) {
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

  const goInitialismName = pascalCaseName.replace(/Id$/, "ID");
  return record[goInitialismName];
}

function assertVerification(report) {
  const failures = [];
  const { A, B, C, D } = report.scenarios;

  if (A.status !== "succeeded") failures.push("scenario A ingestion task did not succeed");
  if (A.indexedRecordCount <= 0) failures.push("scenario A did not write index records");
  if (A.indexStoreMatchedRecordIds.length <= 0) failures.push("scenario A index store did not contain the created document");
  if (!A.adminIngestionVisible) failures.push("scenario A admin ingestion read-model did not show the task");
  if (B.retrievalSource !== "indexed-store") failures.push("scenario B did not use indexed-store");
  if (B.chunkCount <= 0) failures.push("scenario B did not return indexed chunks");
  if (C.retrievalSource !== "indexed-store") failures.push("scenario C chat did not consume indexed-store retrieval");
  if (!C.traceStages.some((stage) => stage.stage === "context.assembly" && stage.metadata?.evidenceCount > 0)) {
    failures.push("scenario C chat trace did not show retrieved evidence");
  }
  if (!C.adminTraceVisible) failures.push("scenario C admin traces did not show chat trace");
  if (D.indexedStoreUnavailableRetrieval.retrievalSource !== "local-corpus") {
    failures.push("scenario D unavailable indexed-store did not fall back clearly");
  }

  if (failures.length > 0) {
    throw new Error(`RAG E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function printSummary(report) {
  console.log(JSON.stringify(report, null, 2));
}

function buildSessionCookie(payload) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return `ragent_session=${encoded}`;
}

function deriveSqlitePath(taskStorePath) {
  if (taskStoreBackend !== "sqlite" || !taskStorePath) {
    return "";
  }
  if (taskStorePath.endsWith(".json")) {
    return taskStorePath.slice(0, -".json".length) + ".db";
  }
  return `${taskStorePath}.db`;
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
