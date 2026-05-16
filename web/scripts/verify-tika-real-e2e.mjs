import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const goRoot = path.join(repoRoot, "go", "retrievalexecutor");

const tempRoot = path.join(repoRoot, "tmp", "tika-real-e2e");
const reportPath = path.join(tempRoot, "report.json");
const stateFilePath = path.join(tempRoot, "ts-platform-state.json");
const goBinaryPath = path.join(tempRoot, process.platform === "win32" ? "retrieval-service-tika-real-e2e.exe" : "retrieval-service-tika-real-e2e");
const goCachePath = path.join(tempRoot, "gocache");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

const tikaUrlRaw = process.env.PARSER_TIKA_URL ?? "";
const mainGoPort = Number(process.env.TIKA_REAL_E2E_GO_PORT ?? "8595");
const fallbackGoPort = Number(process.env.TIKA_REAL_E2E_GO_FALLBACK_PORT ?? "8596");
const failureGoPort = Number(process.env.TIKA_REAL_E2E_GO_FAILURE_PORT ?? "8597");
const webPort = Number(process.env.TIKA_REAL_E2E_WEB_PORT ?? "3501");
const adminHeaders = createSessionHeaders({
  role: "admin",
  userId: "tika_real_e2e_admin",
  userName: "Tika Real E2E Admin",
  tenantId: "tenant_tika_e2e",
  orgId: "org_tika_e2e"
});
const userHeaders = createSessionHeaders({
  role: "user",
  userId: "tika_real_e2e_user",
  userName: "Tika Real E2E User",
  tenantId: "tenant_tika_e2e",
  orgId: "org_tika_e2e"
});

async function main() {
  await prepareWorkspace();

  const report = {
    reportPath,
    startedAt: new Date().toISOString(),
    status: "running",
    skipped: false,
    blocked: false,
    environment: {
      parserTikaUrlPresent: Boolean(tikaUrlRaw.trim()),
      parserTikaUrl: tikaUrlRaw.trim() || null,
      webPort,
      mainGoPort,
      fallbackGoPort,
      failureGoPort,
      stateFilePath
    },
    tikaHealth: null,
    cases: {
      success: {},
      fallback: {},
      failure: {}
    }
  };

  const tikaUrl = tikaUrlRaw.trim();
  if (!tikaUrl) {
    report.status = "blocked";
    report.skipped = true;
    report.blocked = true;
    report.reason = "missing-parser-tika-url";
    report.requiredEnvironment = {
      PARSER_TIKA_URL: "例如: http://127.0.0.1:9998"
    };
    report.minimalTikaStartup = {
      docker: "docker run --rm -p 9998:9998 apache/tika:2.9.2.1",
      verify: "curl -X PUT -H 'Accept: text/plain' -H 'Content-Type: text/plain' --data 'health-check' http://127.0.0.1:9998/tika"
    };
    await writeReport(report);
    return;
  }

  const tikaHealth = await checkTikaHealth(tikaUrl);
  report.tikaHealth = tikaHealth;
  if (!tikaHealth.reachable) {
    report.status = "blocked";
    report.skipped = true;
    report.blocked = true;
    report.reason = "tika-server-unreachable";
    report.requiredEnvironment = {
      PARSER_TIKA_URL: tikaUrl
    };
    report.minimalTikaStartup = {
      docker: "docker run --rm -p 9998:9998 apache/tika:2.9.2.1",
      verify: "curl -X PUT -H 'Accept: text/plain' -H 'Content-Type: text/plain' --data 'health-check' http://127.0.0.1:9998/tika"
    };
    await writeReport(report);
    return;
  }

  await ensureNextBuild();
  await buildGoBinary();

  const handles = [];
  try {
    const mainGo = startGoService({
      label: "go-main-tika",
      port: mainGoPort,
      taskStorePath: path.join(tempRoot, "task-store.main.json"),
      indexStorePath: path.join(tempRoot, "index-store.main.json"),
      parserTikaUrl: tikaUrl,
      parserTikaFallbackEnabled: false
    });
    handles.push(mainGo);

    const fallbackGo = startGoService({
      label: "go-fallback-enabled",
      port: fallbackGoPort,
      taskStorePath: path.join(tempRoot, "task-store.fallback.json"),
      indexStorePath: path.join(tempRoot, "index-store.fallback.json"),
      parserTikaUrl: "http://127.0.0.1:1",
      parserTikaFallbackEnabled: true
    });
    handles.push(fallbackGo);

    const failureGo = startGoService({
      label: "go-fallback-disabled",
      port: failureGoPort,
      taskStorePath: path.join(tempRoot, "task-store.failure.json"),
      indexStorePath: path.join(tempRoot, "index-store.failure.json"),
      parserTikaUrl: "http://127.0.0.1:1",
      parserTikaFallbackEnabled: false
    });
    handles.push(failureGo);

    const nextApp = startNextApp();
    handles.push(nextApp);

    await waitForHealthy(`http://127.0.0.1:${mainGoPort}/healthz`, "go-main-tika", handles);
    await waitForHealthy(`http://127.0.0.1:${fallbackGoPort}/healthz`, "go-fallback-enabled", handles);
    await waitForHealthy(`http://127.0.0.1:${failureGoPort}/healthz`, "go-fallback-disabled", handles);
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/auth/session`, "next-start", handles);

    report.cases.success.text_plain = await runSuccessCase({
      label: "text-plain",
      mimeType: "text/plain",
      filename: `tika-real-${Date.now()}.txt`,
      sourceUri: `data:text/plain;base64,${Buffer.from(`Text token ${uniqueToken("plain")} manager approval required.`, "utf8").toString("base64")}`,
      queryText: "manager approval"
    });

    report.cases.success.text_markdown = await runSuccessCase({
      label: "text-markdown",
      mimeType: "text/markdown",
      filename: `tika-real-${Date.now()}.md`,
      sourceUri: `data:text/markdown;base64,${Buffer.from(`# Tika markdown\n\nToken ${uniqueToken("md")} requires manager approval.`, "utf8").toString("base64")}`,
      queryText: "requires manager approval"
    });

    const docxToken = uniqueToken("docx");
    report.cases.success.docx = await runSuccessCase({
      label: "docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: `tika-real-${Date.now()}.docx`,
      sourceUri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buildDocxBuffer(docxToken).toString("base64")}`,
      queryText: docxToken
    });

    const pdfToken = uniqueToken("pdf");
    report.cases.success.pdf = await runSuccessCase({
      label: "pdf",
      mimeType: "application/pdf",
      filename: `tika-real-${Date.now()}.pdf`,
      sourceUri: `data:application/pdf;base64,${buildPdfBuffer(pdfToken).toString("base64")}`,
      queryText: pdfToken
    });

    report.cases.fallback.enabled = await runFallbackEnabledCase();
    report.cases.failure.fallback_disabled = await runFallbackDisabledCase();

    assertVerification(report);
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await writeReport(report);
  } finally {
    await cleanupPorts([mainGoPort, fallbackGoPort, failureGoPort, webPort]);
    await Promise.all(handles.map(stopProcess));
  }
}

async function runSuccessCase({ label, mimeType, filename, sourceUri, queryText }) {
  const token = uniqueToken(label);
  const payload = buildIngestionPayload({
    traceId: uniqueToken("trace"),
    documentId: uniqueToken(`doc-${label}`),
    source: {
      sourceType: "upload",
      uri: sourceUri,
      filename,
      mimeType,
      sizeBytes: sourceUri.length,
      checksum: null
    }
  });

  const created = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: withJsonHeaders(adminHeaders),
    body: JSON.stringify(payload)
  });
  await fetchJson(`http://127.0.0.1:${mainGoPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}/run`, {
    method: "POST"
  });

  const task = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks/${encodeURIComponent(created.taskId)}`, {
    headers: adminHeaders
  });
  const retrieval = await fetchJson(`http://127.0.0.1:${mainGoPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: uniqueToken(`retrieval-${label}`),
      query: queryText,
      knowledgeBaseIds: ["kb_policy"],
      topK: 3,
      filters: {}
    })
  });
  const chat = await verifyChatEvidence(queryText);

  const parsed = task.parserResult?.parsedDocument ?? null;
  const metadata = parsed?.metadata ?? {};
  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserBackend: task.parserResult?.parserBackend ?? null,
    parserName: task.parserResult?.parserName ?? null,
    parserVersion: task.parserResult?.parserVersion ?? null,
    parsedDocument: {
      charCount: Number(parsed?.charCount ?? 0),
      pageCount: parsed?.pageCount ?? null
    },
    metadata: {
      hasTikaMetadata: Boolean(metadata?.tikaMetadata && typeof metadata.tikaMetadata === "object"),
      hasTikaMetadataKeys: Array.isArray(metadata?.tikaMetadataKeys),
      tikaMetadataKeysCount: Array.isArray(metadata?.tikaMetadataKeys) ? metadata.tikaMetadataKeys.length : 0,
      tikaContentType: metadata?.tikaContentType ?? null
    },
    chunkCount: Number(task.chunks?.length ?? 0),
    indexedRecordCount: Number(task.indexWriteResult?.recordCount ?? 0),
    retrievalSource: retrieval.source,
    retrievalChunkCount: Array.isArray(retrieval.chunks) ? retrieval.chunks.length : 0,
    chat
  };
}

async function runFallbackEnabledCase() {
  const task = await createAndRunTask(fallbackGoPort, {
    documentId: uniqueToken("doc-fallback"),
    source: {
      filename: `fallback-${Date.now()}.md`,
      mimeType: "text/markdown",
      uri: `data:text/markdown;base64,${Buffer.from(`# fallback\n\n${uniqueToken("fallback")} text fallback check`, "utf8").toString("base64")}`
    },
    metadata: {
      maxAttempts: 1
    }
  });
  const parsed = task.parserResult?.parsedDocument;
  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserBackend: task.parserResult?.parserBackend ?? null,
    parserName: task.parserResult?.parserName ?? null,
    parserVersion: task.parserResult?.parserVersion ?? null,
    parserErrorCode: task.metadata?.parserErrorCode ?? null,
    fallbackReason: parsed?.metadata?.fallbackReason ?? task.metadata?.fallbackReason ?? null
  };
}

async function runFallbackDisabledCase() {
  const task = await createAndRunTask(failureGoPort, {
    documentId: uniqueToken("doc-failure"),
    source: {
      filename: `failure-${Date.now()}.pdf`,
      mimeType: "application/pdf",
      uri: `data:application/pdf;base64,${buildPdfBuffer(uniqueToken("failure")).toString("base64")}`
    },
    metadata: {
      maxAttempts: 1
    }
  });
  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserErrorCode: task.metadata?.parserErrorCode ?? null,
    retryable: Boolean(task.retryable),
    failureStage: task.failureStage ?? null,
    failureReason: task.failureReason ?? null,
    traceFailedPresent: Array.isArray(task.trace) && task.trace.some((event) => event.stage === "failed")
  };
}

async function verifyChatEvidence(token) {
  const chat = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: `According to the policy document, what does token ${token} require?`
    })
  });
  const traceResponse = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, { headers: adminHeaders });
  const traceRecords = Array.isArray(traceResponse.records) ? traceResponse.records : [];
  const traceItems = traceRecords.filter((item) => item.traceId === chat.traceId);
  const traceEvidenceCount = Number(traceItems.find((item) => item.stage === "context.assembly")?.metadata?.evidenceCount ?? 0);
  const metadataEvidenceCount = Number(chat.assistantMessage?.metadata?.context?.evidenceCount ?? 0);
  const evidenceCount = Math.max(traceEvidenceCount, metadataEvidenceCount);

  const streamResponse = await fetchText(`http://127.0.0.1:${webPort}/api/chat/stream`, {
    method: "POST",
    headers: withJsonHeaders(userHeaders),
    body: JSON.stringify({
      message: `Please stream based on policy document evidence for token ${token}.`
    })
  });
  const events = parseNdjson(streamResponse);
  const completed = events.find((event) => event.type === "message.completed");
  const streamTraceId = completed?.traceId ?? null;
  const streamTraceResponse = streamTraceId
    ? await fetchJson(`http://127.0.0.1:${webPort}/api/trace`, { headers: adminHeaders })
    : null;
  const streamTraceItems = streamTraceId
    ? (() => {
        const records = Array.isArray(streamTraceResponse?.records) ? streamTraceResponse.records : [];
        return records.filter((item) => item.traceId === streamTraceId);
      })()
    : [];
  const streamTraceEvidenceCount = Number(streamTraceItems.find((item) => item.stage === "context.assembly")?.metadata?.evidenceCount ?? 0);
  const streamMetadataEvidenceCount = Number(completed?.assistantMessage?.metadata?.context?.evidenceCount ?? 0);
  const streamEvidenceCount = Math.max(streamTraceEvidenceCount, streamMetadataEvidenceCount);

  return {
    apiChatTraceId: chat.traceId,
    apiChatRetrievalSource: chat.assistantMessage?.metadata?.retrievalSource ?? null,
    apiChatEvidenceCount: evidenceCount,
    apiChatStreamTraceId: streamTraceId,
    apiChatStreamRetrievalSource: completed?.assistantMessage?.metadata?.retrievalSource ?? null,
    apiChatStreamEvidenceCount: streamEvidenceCount
  };
}

function assertVerification(report) {
  const failures = [];
  const successCases = report.cases.success;
  const fallbackEnabled = report.cases.fallback.enabled;
  const fallbackDisabled = report.cases.failure.fallback_disabled;

  for (const [key, item] of Object.entries(successCases)) {
    if (item.status !== "succeeded" || item.currentStage !== "completed") {
      failures.push(`${key}: expected succeeded/completed, got ${item.status}/${item.currentStage}`);
    }
    if (item.parserBackend !== "tika") {
      failures.push(`${key}: expected parserBackend=tika, got ${item.parserBackend}`);
    }
    if (!item.parserName || !item.parserVersion) {
      failures.push(`${key}: parserName or parserVersion missing`);
    }
    if (item.parsedDocument.charCount <= 0) {
      failures.push(`${key}: parsedDocument.charCount <= 0`);
    }
    if (!item.metadata.hasTikaMetadata && !item.metadata.hasTikaMetadataKeys) {
      failures.push(`${key}: tikaMetadata/tikaMetadataKeys missing`);
    }
    if (item.chunkCount <= 0) {
      failures.push(`${key}: chunkCount <= 0`);
    }
    if (item.indexedRecordCount <= 0) {
      failures.push(`${key}: indexedRecordCount <= 0`);
    }
    if (item.retrievalSource !== "indexed-store") {
      failures.push(`${key}: retrievalSource expected indexed-store, got ${item.retrievalSource}`);
    }
    if ((item.chat?.apiChatEvidenceCount ?? 0) <= 0) {
      failures.push(`${key}: /api/chat evidenceCount <= 0`);
    }
    if ((item.chat?.apiChatStreamEvidenceCount ?? 0) <= 0) {
      failures.push(`${key}: /api/chat/stream evidenceCount <= 0`);
    }
  }

  const pdfPageCount = Number(successCases.pdf?.parsedDocument?.pageCount ?? 0);
  if (!(pdfPageCount > 0)) {
    failures.push(`pdf: pageCount mapping invalid (${successCases.pdf?.parsedDocument?.pageCount})`);
  }

  if (!fallbackEnabled) {
    failures.push("fallback_enabled: case missing");
  } else {
    if (fallbackEnabled.status !== "succeeded" || fallbackEnabled.currentStage !== "completed") {
      failures.push(`fallback_enabled: expected succeeded/completed, got ${fallbackEnabled.status}/${fallbackEnabled.currentStage}`);
    }
    if (fallbackEnabled.parserBackend === "tika") {
      failures.push("fallback_enabled: expected non-tika backend when tika unavailable");
    }
    if (!fallbackEnabled.fallbackReason) {
      failures.push("fallback_enabled: fallbackReason missing");
    }
  }

  if (!fallbackDisabled) {
    failures.push("fallback_disabled: case missing");
  } else {
    if (fallbackDisabled.status !== "failed" || fallbackDisabled.currentStage !== "failed") {
      failures.push(`fallback_disabled: expected failed/failed, got ${fallbackDisabled.status}/${fallbackDisabled.currentStage}`);
    }
    if (!fallbackDisabled.parserErrorCode) {
      failures.push("fallback_disabled: parserErrorCode missing");
    }
    if (!fallbackDisabled.failureStage || fallbackDisabled.failureStage !== "parser") {
      failures.push(`fallback_disabled: failureStage expected parser, got ${fallbackDisabled.failureStage}`);
    }
    if (!fallbackDisabled.failureReason) {
      failures.push("fallback_disabled: failureReason missing");
    }
    if (!fallbackDisabled.traceFailedPresent) {
      failures.push("fallback_disabled: trace missing failed stage");
    }
  }

  if (failures.length > 0) {
    throw new Error(`Tika real E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

async function createAndRunTask(port, { documentId, source, metadata = {} }) {
  const payload = buildIngestionPayload({
    traceId: uniqueToken("trace"),
    documentId,
    metadata,
    source: {
      sourceType: "upload",
      uri: source.uri,
      filename: source.filename,
      mimeType: source.mimeType,
      sizeBytes: source.uri.length,
      checksum: null
    }
  });
  const created = await fetchJson(`http://127.0.0.1:${port}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  await fetchJson(`http://127.0.0.1:${port}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}/run`, {
    method: "POST"
  });
  return fetchJson(`http://127.0.0.1:${port}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);
}

function buildIngestionPayload({ traceId, documentId, source, metadata = {} }) {
  return {
    traceId,
    knowledgeBaseId: "kb_policy",
    documentId,
    requestedBy: "verify-tika-real-e2e",
    source,
    executionPlan: {
      parser: {
        parserType: "auto-parser",
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
      initiatedFrom: "verify-tika-real-e2e",
      ...metadata
    }
  };
}

function createSessionHeaders({ role, userId, userName, tenantId, orgId }) {
  return {
    "x-ragent-role": role,
    "x-ragent-user-id": userId,
    "x-ragent-user-name": userName,
    "x-ragent-tenant-id": tenantId,
    "x-ragent-org-id": orgId
  };
}

function withJsonHeaders(headers = {}) {
  return {
    "Content-Type": "application/json",
    ...headers
  };
}

async function checkTikaHealth(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  const result = {
    baseUrl: normalized,
    reachable: false,
    tikaEndpoint: { ok: false, status: null, error: null },
    metaEndpoint: { ok: false, status: null, error: null }
  };

  const sampleText = "tika health token";
  try {
    const tikaResp = await fetch(`${normalized}/tika`, {
      method: "PUT",
      headers: {
        Accept: "text/plain",
        "Content-Type": "text/plain"
      },
      body: sampleText
    });
    result.tikaEndpoint.ok = tikaResp.ok;
    result.tikaEndpoint.status = tikaResp.status;
  } catch (error) {
    result.tikaEndpoint.error = error instanceof Error ? error.message : String(error);
  }

  try {
    const metaResp = await fetch(`${normalized}/meta`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "text/plain"
      },
      body: sampleText
    });
    result.metaEndpoint.ok = metaResp.ok;
    result.metaEndpoint.status = metaResp.status;
  } catch (error) {
    result.metaEndpoint.error = error instanceof Error ? error.message : String(error);
  }

  result.reachable = Boolean(result.tikaEndpoint.ok && result.metaEndpoint.ok);
  return result;
}

async function prepareWorkspace() {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

async function ensureNextBuild() {
  const buildIdPath = path.join(webRoot, ".next", "BUILD_ID");
  try {
    await fs.access(buildIdPath);
    return;
  } catch {}

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand({
    command: npmCmd,
    args: ["run", "build"],
    cwd: webRoot,
    label: "next-build"
  });
}

async function buildGoBinary() {
  const command = process.platform === "win32" ? "go.exe" : "go";
  await runCommand({
    command,
    args: ["build", "-o", goBinaryPath, "./cmd/retrieval-service"],
    cwd: goRoot,
    env: {
      ...process.env,
      GOCACHE: goCachePath
    },
    label: "go-build-retrieval-service"
  });
}

function startGoService({ label, port, taskStorePath, indexStorePath, parserTikaUrl, parserTikaFallbackEnabled }) {
  return startProcess({
    label,
    command: goBinaryPath,
    args: [],
    cwd: goRoot,
    env: {
      PORT: String(port),
      GOCACHE: goCachePath,
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      GO_INGESTION_RUNNER_ENABLED: "false",
      GO_INGESTION_RUNNER_INTERVAL: "500ms",
      GO_INGESTION_RUNNER_LIMIT: "2",
      GO_INGESTION_RUNNER_LEASE: "3s",
      PARSER_PROVIDER: "tika",
      PARSER_TIKA_URL: parserTikaUrl,
      PARSER_TIKA_FALLBACK_ENABLED: parserTikaFallbackEnabled ? "true" : "false",
      PARSER_TIKA_TIMEOUT_MS: "1500",
      PARSER_PDF_ENABLED: "true",
      PARSER_DOCX_ENABLED: "true"
    }
  });
}

function startNextApp() {
  return startProcess({
    label: "next-start",
    command: process.execPath,
    args: [nextCliPath, "start", "--port", String(webPort)],
    cwd: webRoot,
    env: {
      TS_PLATFORM_STATE_PATH: stateFilePath,
      GO_INGESTION_BASE_URL: `http://127.0.0.1:${mainGoPort}`,
      GO_RETRIEVAL_ENABLED: "true",
      GO_RETRIEVAL_ENDPOINT: `http://127.0.0.1:${mainGoPort}/internal/retrieval/search`,
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_INGESTION_FALLBACK_ENABLED: "false",
      RAGENT_FORCE_LOCAL_GENERATION: "true"
    }
  });
}

function startProcess({ command, args, cwd, env, label }) {
  const stdoutPath = path.join(tempRoot, `${label}.stdout.log`);
  const stderrPath = path.join(tempRoot, `${label}.stderr.log`);
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const flushLogs = async () => {
    await fs.writeFile(stdoutPath, stdout, "utf8");
    await fs.writeFile(stderrPath, stderr, "utf8");
  };
  child.stdout.on("data", () => {
    void flushLogs();
  });
  child.stderr.on("data", () => {
    void flushLogs();
  });

  return {
    label,
    child,
    stdoutPath,
    stderrPath,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

async function runCommand({ command, args, cwd, env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`[${label}] command failed with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function stopProcess(handle) {
  if (!handle || !handle.child || handle.child.exitCode !== null) {
    return;
  }

  handle.child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGKILL");
      }
      resolve();
    }, 2000);

    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (process.platform === "win32" && handle.child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(handle.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  }
}

async function waitForHealthy(url, label, handles = []) {
  const startedAt = Date.now();
  const timeoutMs = 45_000;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(500);
  }

  const diagnostics = handles
    .filter((handle) => handle.label === label)
    .map(
      (handle) =>
        `${handle.label} stdout:\n${handle.getStdout()}\n${handle.label} stderr:\n${handle.getStderr()}\nlogs: ${handle.stdoutPath}, ${handle.stderrPath}`
    )
    .join("\n");
  throw new Error(`Timed out waiting for ${label} at ${url}\n${diagnostics}`);
}

async function cleanupPorts(ports) {
  if (process.platform !== "win32") {
    return;
  }
  const output = await execFileText("netstat.exe", ["-ano"]).catch(() => "");
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    for (const port of ports) {
      if (line.includes(`:${port}`) && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).at(-1);
        if (pid && /^\d+$/.test(pid)) {
          pids.add(pid);
        }
      }
    }
  }
  await Promise.all([...pids].map((pid) => execFileText("taskkill.exe", ["/PID", pid, "/T", "/F"]).catch(() => "")));
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${body}`);
  }
  return body;
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

function buildDocxBuffer(token) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>DOCX token ${xmlEscape(token)}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Manager approval is required for token ${xmlEscape(token)}.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Tika DOCX ${xmlEscape(token)}</dc:title>
</cp:coreProperties>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(relsXml, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml, "utf8") }
  ]);
}

function buildPdfBuffer(token) {
  const escaped = pdfEscape(`PDF token ${token} requires manager approval.`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const parts = [header];
  const offsets = [];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    const buffer = Buffer.from(object, "utf8");
    parts.push(buffer);
    cursor += buffer.length;
  }

  const xrefStart = cursor;
  const xrefLines = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) {
    xrefLines.push(`${String(offset).padStart(10, "0")} 00000 n `);
  }
  const xref = Buffer.from(`${xrefLines.join("\n")}\n`, "utf8");
  parts.push(xref);
  cursor += xref.length;

  const trailer = Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, "utf8");
  parts.push(trailer);
  cursor += trailer.length;
  return Buffer.concat(parts, cursor);
}

function buildZip(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    fileParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...fileParts, centralDirectory, end]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pdfEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function uniqueToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  const failedReport = {
    reportPath,
    status: "failed",
    skipped: false,
    blocked: false,
    error: error instanceof Error ? error.message : String(error)
  };
  await writeReport(failedReport);
  process.exitCode = 1;
});
