import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");

const tempRoot = path.join(repoRoot, "tmp", "vector-db-e2e");
const reportPath = path.join(tempRoot, "report.json");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

const jsonGoPort = Number(process.env.VECTOR_DB_E2E_JSON_GO_PORT ?? "8495");
const qdrantGoPort = Number(process.env.VECTOR_DB_E2E_QDRANT_GO_PORT ?? "8496");
const fallbackGoPort = Number(process.env.VECTOR_DB_E2E_FALLBACK_GO_PORT ?? "8497");
const webPort = Number(process.env.VECTOR_DB_E2E_WEB_PORT ?? "3501");
const taskStoreBackend = String(process.env.GO_INGESTION_TASK_STORE_BACKEND ?? "json").trim().toLowerCase();

async function main() {
  await prepareWorkspace();
  await ensureNextBuild();

  const qdrantURL = stringsTrim(process.env.QDRANT_URL);
  const qdrantAPIKey = stringsTrim(process.env.QDRANT_API_KEY);
  const baseCollection = stringsTrim(process.env.QDRANT_COLLECTION) || "ragent_chunks";
  const qdrantCollection = `${baseCollection}_e2e_${Date.now()}`;

  const report = {
    generatedAt: new Date().toISOString(),
    reportPath,
    environment: {
      webPort,
      jsonGoPort,
      qdrantGoPort,
      fallbackGoPort,
      qdrantConfigured: qdrantURL.length > 0,
      qdrantCollection
    },
    backends: {},
    fallbackBehavior: {}
  };

  report.backends.json = await runBackendSuite({
    backend: "json",
    goPort: jsonGoPort,
    webPort,
    stateFilePath: path.join(tempRoot, "ts-platform-state.json.json-backend"),
    taskStorePath: path.join(tempRoot, "go-task-store.json.json-backend"),
    indexStorePath: path.join(tempRoot, "go-index-store.json.json-backend"),
    goEnv: {
      INDEX_BACKEND: "json"
    }
  });

  if (!qdrantURL) {
    report.backends.qdrant = {
      backend: "qdrant",
      status: "skipped",
      skipped: true,
      reason: "QDRANT_URL is not configured",
      taskId: null,
      indexedRecordCount: 0,
      retrievalSource: null,
      retrievalMode: null,
      evidenceCount: {
        chat: 0,
        stream: 0
      },
      deleteVerified: false,
      filterVerified: false,
      topKVerified: false,
      fallbackBehavior: "not-run",
      retrievalMetadata: null
    };
  } else {
    await ensureQdrantAccessible({
      qdrantURL,
      qdrantAPIKey
    });

    report.backends.qdrant = await runBackendSuite({
      backend: "qdrant",
      goPort: qdrantGoPort,
      webPort,
      stateFilePath: path.join(tempRoot, "ts-platform-state.json.qdrant-backend"),
      taskStorePath: path.join(tempRoot, "go-task-store.json.qdrant-backend"),
      indexStorePath: path.join(tempRoot, "go-index-store.json.qdrant-backend"),
      goEnv: {
        INDEX_BACKEND: "qdrant",
        QDRANT_URL: qdrantURL,
        QDRANT_API_KEY: qdrantAPIKey,
        QDRANT_COLLECTION: qdrantCollection
      },
      qdrant: {
        url: qdrantURL,
        apiKey: qdrantAPIKey,
        collection: qdrantCollection
      }
    });
  }

  report.fallbackBehavior = await verifyFallbackBehavior({
    fallbackGoPort,
    indexStorePath: path.join(tempRoot, "go-index-store.json.fallback"),
    taskStorePath: path.join(tempRoot, "go-task-store.json.fallback"),
    // Always use an unreachable endpoint for fallback assertions so results
    // do not depend on whether a real Qdrant instance is currently available.
    qdrantURL: "http://127.0.0.1:1"
  });

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  assertVerification(report);
  printSummary(report);
}

async function runBackendSuite({
  backend,
  goPort,
  webPort,
  stateFilePath,
  taskStorePath,
  indexStorePath,
  goEnv,
  qdrant = null
}) {
  const handles = [];
  try {
    const sqlitePath = deriveSqlitePath(taskStorePath);
    const goCommand = resolveGoRunCommand();
    const goService = startProcess({
      label: `${backend}-go`,
      command: goCommand.command,
      args: goCommand.args,
      cwd: path.join(repoRoot, "go", "retrievalexecutor"),
      env: {
        PORT: String(goPort),
        GO_RETRIEVAL_SOURCE: "indexed-store",
        GO_RETRIEVAL_FALLBACK_ENABLED: "true",
        GO_RETRIEVAL_MODE: "hybrid",
        GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
        GO_INGESTION_TASK_STORE_PATH: taskStorePath,
        ...(sqlitePath ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: sqlitePath } : {}),
        GO_INGESTION_RUNNER_ENABLED: "false",
        GO_INGESTION_RUNNER_INTERVAL: "500ms",
        GO_INGESTION_RUNNER_LIMIT: "2",
        GO_INGESTION_RUNNER_LEASE: "3s",
        ...goEnv
      }
    });
    handles.push(goService);

    const webService = startProcess({
      label: `${backend}-next`,
      command: process.execPath,
      args: [nextCliPath, "start", "--port", String(webPort)],
      cwd: webRoot,
    env: {
      AUTH_PROVIDER_MODE: "mock",
      AUTH_MOCK_FALLBACK_ENABLED: "true",
      AUTH_HEADER_AUTH_ENABLED: "true",
      AUTH_MOCK_DEFAULT_ROLE: "admin",
      AUTH_MOCK_DEFAULT_USER_ID: "verify_vector_db_e2e_admin",
      AUTH_MOCK_DEFAULT_USER_NAME: "Verify Vector DB E2E Admin",
        AUTH_MOCK_DEFAULT_TENANT_ID: "tenant_demo",
        AUTH_MOCK_DEFAULT_ORG_ID: "org_demo",
        TS_PLATFORM_STATE_PATH: stateFilePath,
        GO_INGESTION_BASE_URL: `http://127.0.0.1:${goPort}`,
        GO_RETRIEVAL_ENABLED: "true",
        GO_RETRIEVAL_ENDPOINT: `http://127.0.0.1:${goPort}/internal/retrieval/search`,
        GO_RETRIEVAL_FALLBACK_ENABLED: "true",
        GO_INGESTION_FALLBACK_ENABLED: "false",
        RAGENT_FORCE_LOCAL_GENERATION: "true"
      }
    });
    handles.push(webService);

    await waitForHealthy(`http://127.0.0.1:${goPort}/healthz`, `${backend}-go`, handles);
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/trace`, `${backend}-next`, handles);

    const tokenPrimary = uniqueToken(`${backend}-primary`);
    const tokenUpdated = uniqueToken(`${backend}-updated`);
    const tokenTopK = uniqueToken(`${backend}-topk`);
    const sharedToken = uniqueToken(`${backend}-shared`);
    const docPrimary = `doc_${backend}_primary`;
    const kbPrimary = `kb_${backend}_primary`;

    const firstTask = await createAndRunTaskViaWeb({
      webPort,
      goPort,
      payload: buildIngestionPayload({
        traceId: uniqueToken(`${backend}-trace-first`),
        knowledgeBaseId: kbPrimary,
        documentId: docPrimary,
        filename: `${backend}-primary.md`,
        markdown: buildMultiParagraphMarkdown(tokenPrimary, 6)
      })
    });

    const secondTask = await createAndRunTaskViaWeb({
      webPort,
      goPort,
      payload: buildIngestionPayload({
        traceId: uniqueToken(`${backend}-trace-second`),
        knowledgeBaseId: kbPrimary,
        documentId: docPrimary,
        filename: `${backend}-primary-replace.md`,
        markdown: buildMultiParagraphMarkdown(tokenUpdated, 6)
      })
    });

    const deleteInspection = qdrant
      ? await inspectQdrantDocumentContents({
          qdrantURL: qdrant.url,
          qdrantAPIKey: qdrant.apiKey,
          collection: qdrant.collection,
          knowledgeBaseId: kbPrimary,
          documentId: docPrimary,
          oldToken: tokenPrimary,
          newToken: tokenUpdated
        })
      : await inspectJsonDocumentContents({
          indexStorePath,
          knowledgeBaseId: kbPrimary,
          documentId: docPrimary,
          oldToken: tokenPrimary,
          newToken: tokenUpdated
        });

    await createAndRunTaskViaWeb({
      webPort,
      goPort,
      payload: buildIngestionPayload({
        traceId: uniqueToken(`${backend}-trace-filter-a`),
        knowledgeBaseId: `kb_${backend}_filter_a`,
        documentId: `doc_${backend}_filter_a`,
        filename: `${backend}-filter-a.md`,
        markdown: `# Filter A\n\n${sharedToken} belongs to knowledge base A only.\n\nThis is marker A.`
      })
    });
    await createAndRunTaskViaWeb({
      webPort,
      goPort,
      payload: buildIngestionPayload({
        traceId: uniqueToken(`${backend}-trace-filter-b`),
        knowledgeBaseId: `kb_${backend}_filter_b`,
        documentId: `doc_${backend}_filter_b`,
        filename: `${backend}-filter-b.md`,
        markdown: `# Filter B\n\n${sharedToken} belongs to knowledge base B only.\n\nThis is marker B.`
      })
    });

    await createAndRunTaskViaWeb({
      webPort,
      goPort,
      payload: buildIngestionPayload({
        traceId: uniqueToken(`${backend}-trace-topk`),
        knowledgeBaseId: kbPrimary,
        documentId: `doc_${backend}_topk`,
        filename: `${backend}-topk.md`,
        markdown: buildMultiParagraphMarkdown(tokenTopK, 12)
      })
    });

    const filterQuery = await searchRetrieval({
      goPort,
      query: sharedToken,
      knowledgeBaseIds: [`kb_${backend}_filter_a`],
      topK: 5,
      filters: {}
    });

    const topK1 = await searchRetrieval({
      goPort,
      query: tokenTopK,
      knowledgeBaseIds: [kbPrimary],
      topK: 1,
      filters: {}
    });
    const topK3 = await searchRetrieval({
      goPort,
      query: tokenTopK,
      knowledgeBaseIds: [kbPrimary],
      topK: 3,
      filters: {}
    });

    const chat = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `According to the policy document, what does ${tokenTopK} require?`
      })
    });
    const chatEvidenceCount = await extractEvidenceCount(webPort, chat.traceId);

    const streamRaw = await fetchText(`http://127.0.0.1:${webPort}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Please confirm again from the policy document what ${tokenTopK} requires.`
      })
    });
    const streamEvents = parseNdjson(streamRaw);
    const streamCompleted = streamEvents.find((event) => event.type === "message.completed");
    const streamTraceId = streamCompleted?.traceId ?? null;
    const streamEvidenceCount = streamTraceId ? await extractEvidenceCount(webPort, streamTraceId) : 0;

    const deleteVerified =
      Number(secondTask.indexWriteResult?.deletedRecordCount ?? 0) > 0 &&
      deleteInspection.oldTokenPresent === false &&
      deleteInspection.newTokenPresent === true;
    const filterVerified =
      filterQuery.chunks.length > 0 &&
      filterQuery.chunks.every((chunk) => chunk.knowledgeBaseId === `kb_${backend}_filter_a`);
    const topKVerified = topK1.chunks.length === 1 && topK3.chunks.length > 1 && topK3.chunks.length <= 3;

    const firstTopKChunk = topK3.chunks[0] ?? null;
    const retrievalMetadata = firstTopKChunk?.metadata ?? {};
    const qdrantDetails = qdrant
      ? await inspectQdrantCollection({
          qdrantURL: qdrant.url,
          qdrantAPIKey: qdrant.apiKey,
          collection: qdrant.collection
        })
      : null;

    return {
      backend,
      status: "passed",
      skipped: false,
      taskId: secondTask.taskId,
      indexedRecordCount: Number(secondTask.indexWriteResult?.recordCount ?? 0),
      retrievalSource: topK3.source,
      retrievalMode: firstTopKChunk?.metadata?.retrievalMode ?? null,
      evidenceCount: {
        chat: chatEvidenceCount,
        stream: streamEvidenceCount
      },
      deleteVerified,
      filterVerified,
      topKVerified,
      fallbackBehavior: "not-applicable",
      retrievalMetadata: {
        indexBackend: retrievalMetadata?._indexBackend ?? null,
        indexStoreSource: retrievalMetadata?._indexStoreSource ?? null,
        indexStoreType: retrievalMetadata?._indexStoreType ?? null,
        scoreSource: retrievalMetadata?.scoreSource ?? null
      },
      ingestion: {
        firstTaskId: firstTask.taskId,
        secondTaskId: secondTask.taskId,
        firstStatus: firstTask.status,
        secondStatus: secondTask.status,
        deleteInspection
      },
      qdrant: qdrantDetails
    };
  } catch (error) {
    return {
      backend,
      status: "failed",
      skipped: false,
      reason: error instanceof Error ? error.message : String(error),
      taskId: null,
      indexedRecordCount: 0,
      retrievalSource: null,
      retrievalMode: null,
      evidenceCount: {
        chat: 0,
        stream: 0
      },
      deleteVerified: false,
      filterVerified: false,
      topKVerified: false,
      fallbackBehavior: "not-applicable",
      retrievalMetadata: null
    };
  } finally {
    await cleanupPorts([goPort, webPort]);
    await Promise.all(handles.map(stopProcess));
  }
}

async function verifyFallbackBehavior({ fallbackGoPort, indexStorePath, taskStorePath, qdrantURL }) {
  const failureCase = await verifyQdrantInitFailure({
    port: fallbackGoPort,
    indexStorePath,
    taskStorePath,
    qdrantURL
  });

  const fallbackCase = await verifyQdrantFallbackToJson({
    port: fallbackGoPort,
    indexStorePath,
    taskStorePath,
    qdrantURL
  });

  return {
    withoutFallback: failureCase,
    withFallback: fallbackCase
  };
}

async function verifyQdrantInitFailure({ port, indexStorePath, taskStorePath, qdrantURL }) {
  const sqlitePath = deriveSqlitePath(taskStorePath);
  const goCommand = resolveGoRunCommand();
  const handle = startProcess({
    label: "qdrant-failure-no-fallback",
    command: goCommand.command,
    args: goCommand.args,
    cwd: path.join(repoRoot, "go", "retrievalexecutor"),
    env: {
      PORT: String(port),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      ...(sqlitePath ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: sqlitePath } : {}),
      GO_INGESTION_RUNNER_ENABLED: "false",
      INDEX_BACKEND: "qdrant",
      QDRANT_URL: qdrantURL
    }
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${port}/healthz`, "qdrant-failure-no-fallback", [handle], 5000);
    return {
      expected: "init-failure",
      passed: false,
      details: "service unexpectedly became healthy without fallback"
    };
  } catch {
    const stderr = handle.getStderr();
    const matched =
      stderr.includes("initialize qdrant index backend failed") ||
      stderr.includes("QDRANT_URL is required") ||
      stderr.includes("qdrant ping failed");
    return {
      expected: "init-failure",
      passed: matched,
      details: matched ? "startup failed as expected without fallback" : "startup failed but expected error marker not found",
      stderrSnippet: stderr.slice(0, 500)
    };
  } finally {
    await stopProcess(handle);
    await cleanupPorts([port]);
  }
}

async function verifyQdrantFallbackToJson({ port, indexStorePath, taskStorePath, qdrantURL }) {
  const sqlitePath = deriveSqlitePath(taskStorePath);
  const goCommand = resolveGoRunCommand();
  const handle = startProcess({
    label: "qdrant-fallback-json",
    command: goCommand.command,
    args: goCommand.args,
    cwd: path.join(repoRoot, "go", "retrievalexecutor"),
    env: {
      PORT: String(port),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      ...(sqlitePath ? { GO_INGESTION_TASK_STORE_SQLITE_PATH: sqlitePath } : {}),
      GO_INGESTION_RUNNER_ENABLED: "false",
      INDEX_BACKEND: "qdrant",
      INDEX_BACKEND_FALLBACK: "json",
      QDRANT_URL: qdrantURL
    }
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${port}/healthz`, "qdrant-fallback-json", [handle], 15000);

    const created = await createAndRunTaskViaGo({
      goPort: port,
      payload: buildIngestionPayload({
        traceId: uniqueToken("fallback-trace"),
        knowledgeBaseId: "kb_fallback_json",
        documentId: "doc_fallback_json",
        filename: "fallback-json.md",
        markdown: buildMultiParagraphMarkdown(uniqueToken("fallback"), 3)
      })
    });

    const indexSource = created.indexWriteResult?.source ?? null;
    return {
      expected: "fallback-to-json",
      passed: created.status === "succeeded" && created.currentStage === "completed" && indexSource === "go-json-index-store",
      details: {
        taskId: created.taskId,
        status: created.status,
        currentStage: created.currentStage,
        indexSource,
        indexStoreType: created.indexWriteResult?.storeType ?? null
      }
    };
  } catch (error) {
    return {
      expected: "fallback-to-json",
      passed: false,
      details: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await stopProcess(handle);
    await cleanupPorts([port]);
  }
}

async function createAndRunTaskViaWeb({ webPort, goPort, payload }) {
  const created = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}/run`, {
    method: "POST"
  });

  return fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);
}

async function createAndRunTaskViaGo({ goPort, payload }) {
  const created = await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  await fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}/run`, {
    method: "POST"
  });

  return fetchJson(`http://127.0.0.1:${goPort}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);
}

async function searchRetrieval({ goPort, query, knowledgeBaseIds, topK, filters }) {
  return fetchJson(`http://127.0.0.1:${goPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: uniqueToken("retrieval-trace"),
      query,
      knowledgeBaseIds,
      topK,
      filters
    })
  });
}

async function ensureQdrantAccessible({ qdrantURL, qdrantAPIKey }) {
  await fetchJsonWithHeaders(`${qdrantURL.replace(/\/+$/, "")}/collections`, {}, qdrantAPIKey);
}

async function inspectQdrantCollection({ qdrantURL, qdrantAPIKey, collection }) {
  const baseURL = qdrantURL.replace(/\/+$/, "");
  const collectionInfo = await fetchJsonWithHeaders(
    `${baseURL}/collections/${encodeURIComponent(collection)}`,
    {},
    qdrantAPIKey
  ).catch(() => null);
  const countInfo = await fetchJsonWithHeaders(
    `${baseURL}/collections/${encodeURIComponent(collection)}/points/count`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exact: true })
    },
    qdrantAPIKey
  ).catch(() => null);

  return {
    collectionAccessible: Boolean(collectionInfo?.status && String(collectionInfo.status).toLowerCase() === "ok"),
    pointCount: Number(countInfo?.result?.count ?? 0)
  };
}

async function inspectQdrantDocumentContents({
  qdrantURL,
  qdrantAPIKey,
  collection,
  knowledgeBaseId,
  documentId,
  oldToken,
  newToken
}) {
  const baseURL = qdrantURL.replace(/\/+$/, "");
  const response = await fetchJsonWithHeaders(
    `${baseURL}/collections/${encodeURIComponent(collection)}/points/scroll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 256,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            {
              key: "knowledgeBaseId",
              match: { value: knowledgeBaseId }
            },
            {
              key: "documentId",
              match: { value: documentId }
            }
          ]
        }
      })
    },
    qdrantAPIKey
  );

  const points = Array.isArray(response?.result?.points) ? response.result.points : [];
  const contents = points
    .map((point) => stringsTrim(point?.payload?.content))
    .filter(Boolean)
    .join("\n");
  return {
    pointCount: points.length,
    oldTokenPresent: contents.includes(oldToken),
    newTokenPresent: contents.includes(newToken)
  };
}

async function inspectJsonDocumentContents({ indexStorePath, knowledgeBaseId, documentId, oldToken, newToken }) {
  const raw = await fs.readFile(indexStorePath, "utf8");
  const payload = JSON.parse(raw);
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const matched = records.filter(
    (record) => readRecordField(record, "knowledgeBaseId") === knowledgeBaseId && readRecordField(record, "documentId") === documentId
  );
  const contents = matched
    .map((record) => stringsTrim(readRecordField(record, "content")))
    .filter(Boolean)
    .join("\n");
  const recordCount = matched.length;
  return {
    pointCount: recordCount,
    oldTokenPresent: contents.includes(oldToken),
    newTokenPresent: contents.includes(newToken)
  };
}

function buildIngestionPayload({ traceId, knowledgeBaseId, documentId, filename, markdown }) {
  return {
    traceId,
    knowledgeBaseId,
    documentId,
    requestedBy: "verify-vector-db-e2e",
    source: {
      sourceType: "upload",
      uri: `data:text/markdown;base64,${Buffer.from(markdown, "utf8").toString("base64")}`,
      filename,
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
        targetSize: 800,
        overlap: 80
      },
      embedding: {
        enabled: true,
        model: "mock-embedding-v1",
        adapter: "deterministic"
      },
      indexing: {
        enabled: true,
        indexName: knowledgeBaseId,
        storeType: "vector-db"
      }
    },
    metadata: {
      initiatedFrom: "verify-vector-db-e2e"
    }
  };
}

function buildMultiParagraphMarkdown(token, paragraphCount) {
  const paragraphs = [];
  for (let i = 0; i < paragraphCount; i += 1) {
    paragraphs.push(
      `Paragraph ${i + 1}: token ${token} requires manager approval and retrieval evidence validation for vector database workflow.`
    );
  }
  return `# Vector DB E2E ${token}\n\n${paragraphs.join("\n\n")}\n`;
}

async function extractEvidenceCount(webPort, traceId) {
  const startedAt = Date.now();
  const timeoutMs = 5000;
  while (Date.now() - startedAt < timeoutMs) {
    const traces = await fetchJson(`http://127.0.0.1:${webPort}/api/trace`);
    const items = Array.isArray(traces?.items) ? traces.items : [];
    const contextStage = items.find((item) => item.traceId === traceId && item.stage === "context.assembly");
    const evidenceCount = Number(contextStage?.metadata?.evidenceCount ?? 0);
    if (evidenceCount > 0) {
      return evidenceCount;
    }
    await sleep(250);
  }
  return 0;
}

async function prepareWorkspace() {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
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

function startProcess({ label, command, args, cwd, env }) {
  const stdoutPath = path.join(tempRoot, `${label}.stdout.log`);
  const stderrPath = path.join(tempRoot, `${label}.stderr.log`);
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    void flushLogs();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    void flushLogs();
  });

  const flushLogs = async () => {
    await fs.writeFile(stdoutPath, stdout, "utf8");
    await fs.writeFile(stderrPath, stderr, "utf8");
  };

  return {
    label,
    child,
    stdoutPath,
    stderrPath,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
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

async function waitForHealthy(url, label, handles = [], timeoutMs = 45000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(400);
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

function uniqueToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function deriveSqlitePath(taskStorePath) {
  if (taskStoreBackend !== "sqlite" || !taskStorePath) {
    return "";
  }
  if (taskStorePath.endsWith(".json")) {
    return taskStorePath.slice(0, -".json".length) + ".db";
  }
  return `${taskStorePath}.db`;
}

function stringsTrim(value) {
  return typeof value === "string" ? value.trim() : "";
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

async function fetchJsonWithHeaders(url, init = {}, apiKey = "") {
  const headers = {
    ...(init.headers ?? {})
  };
  if (apiKey) {
    headers["api-key"] = apiKey;
  }
  return fetchJson(url, {
    ...init,
    headers
  });
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${body}`);
  }
  return body;
}

async function runCommand({ command, args, cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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

function assertVerification(report) {
  const failures = [];
  const json = report.backends.json;
  if (json.status !== "passed") failures.push("json backend suite failed");
  if (!json.deleteVerified) failures.push("json backend delete verification failed");
  if (!json.filterVerified) failures.push("json backend filter verification failed");
  if (!json.topKVerified) failures.push("json backend topK verification failed");
  if (json.retrievalSource !== "indexed-store") failures.push("json backend retrievalSource is not indexed-store");

  const qdrant = report.backends.qdrant;
  if (!qdrant.skipped) {
    if (qdrant.status !== "passed") failures.push("qdrant backend suite failed");
    if (!qdrant.deleteVerified) failures.push("qdrant backend delete verification failed");
    if (!qdrant.filterVerified) failures.push("qdrant backend filter verification failed");
    if (!qdrant.topKVerified) failures.push("qdrant backend topK verification failed");
    if (qdrant.retrievalSource !== "indexed-store") failures.push("qdrant backend retrievalSource is not indexed-store");
    if (qdrant.retrievalMetadata?.indexBackend !== "qdrant") {
      failures.push(`qdrant backend retrieval metadata indexBackend mismatch (${qdrant.retrievalMetadata?.indexBackend})`);
    }
  }

  const fallback = report.fallbackBehavior;
  if (!fallback.withoutFallback?.passed) {
    failures.push("qdrant unavailable without fallback did not fail as expected");
  }
  if (!fallback.withFallback?.passed) {
    failures.push("qdrant unavailable with INDEX_BACKEND_FALLBACK=json did not fallback as expected");
  }

  if (failures.length > 0) {
    throw new Error(`Vector DB E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function printSummary(report) {
  console.log(
    JSON.stringify(
      {
        reportPath,
        json: report.backends.json,
        qdrant: report.backends.qdrant,
        fallbackBehavior: report.fallbackBehavior
      },
      null,
      2
    )
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
