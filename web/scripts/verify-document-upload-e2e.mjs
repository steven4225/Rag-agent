import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");

const tempRoot = path.join(repoRoot, "tmp", "document-upload-e2e");
const reportPath = path.join(tempRoot, "report.json");
const stateFilePath = path.join(tempRoot, "ts-platform-state.json");
const mainTaskStorePath = path.join(tempRoot, "go-main-task-store.json");
const mainIndexStorePath = path.join(tempRoot, "go-main-index-store.json");
const unsupportedTaskStorePath = path.join(tempRoot, "go-unsupported-task-store.json");
const unsupportedIndexStorePath = path.join(tempRoot, "go-unsupported-index-store.json");
const dependencyTaskStorePath = path.join(tempRoot, "go-dependency-task-store.json");
const dependencyIndexStorePath = path.join(tempRoot, "go-dependency-index-store.json");
const goBinaryPath = path.join(tempRoot, process.platform === "win32" ? "retrieval-service-e2e.exe" : "retrieval-service-e2e");

const mainGoPort = Number(process.env.DOC_UPLOAD_E2E_GO_PORT ?? "8395");
const unsupportedGoPort = Number(process.env.DOC_UPLOAD_E2E_GO_UNSUPPORTED_PORT ?? "8396");
const dependencyGoPort = Number(process.env.DOC_UPLOAD_E2E_GO_DEPENDENCY_PORT ?? "8397");
const webPort = Number(process.env.DOC_UPLOAD_E2E_WEB_PORT ?? "3401");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

async function main() {
  await prepareWorkspace();
  await ensureNextBuild();
  await buildGoBinary();

  const handles = [];
  try {
    const mainGo = startGoService({
      label: "go-main",
      port: mainGoPort,
      taskStorePath: mainTaskStorePath,
      indexStorePath: mainIndexStorePath,
      parserProvider: "auto",
      parserPdfEnabled: true,
      parserDocxEnabled: true
    });
    handles.push(mainGo);

    const unsupportedGo = startGoService({
      label: "go-unsupported",
      port: unsupportedGoPort,
      taskStorePath: unsupportedTaskStorePath,
      indexStorePath: unsupportedIndexStorePath,
      parserProvider: "auto",
      parserPdfEnabled: true,
      parserDocxEnabled: false
    });
    handles.push(unsupportedGo);

    const dependencyGo = startGoService({
      label: "go-dependency-missing",
      port: dependencyGoPort,
      taskStorePath: dependencyTaskStorePath,
      indexStorePath: dependencyIndexStorePath,
      parserProvider: "auto",
      parserPdfEnabled: true,
      parserDocxEnabled: true,
      envPatch: {
        PATH: process.platform === "win32" ? "C:\\Windows\\System32" : ""
      }
    });
    handles.push(dependencyGo);

    const web = startNextApp();
    handles.push(web);

    await waitForHealthy(`http://127.0.0.1:${mainGoPort}/healthz`, "go-main", handles);
    await waitForHealthy(`http://127.0.0.1:${unsupportedGoPort}/healthz`, "go-unsupported", handles);
    await waitForHealthy(`http://127.0.0.1:${dependencyGoPort}/healthz`, "go-dependency-missing", handles);
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/trace`, "next-start", handles);

    const report = {
      environment: {
        webPort,
        mainGoPort,
        unsupportedGoPort,
        dependencyGoPort,
        reportPath,
        stateFilePath,
        mainTaskStorePath,
        mainIndexStorePath,
        unsupportedTaskStorePath,
        unsupportedIndexStorePath,
        dependencyTaskStorePath,
        dependencyIndexStorePath
      },
      cases: {
        success: {},
        failure: {}
      }
    };

    report.cases.success.text_plain = await runSuccessCase({
      caseName: "text-plain",
      mimeType: "text/plain",
      filename: `sample-${Date.now()}.txt`,
      buildSource: (token) => `data:text/plain;base64,${Buffer.from(`Text upload token ${token}\nManager approval required.`, "utf8").toString("base64")}`,
      expectedParserName: "go-text-parser"
    });

    report.cases.success.text_markdown = await runSuccessCase({
      caseName: "text-markdown",
      mimeType: "text/markdown",
      filename: `sample-${Date.now()}.md`,
      buildSource: (token) =>
        `data:text/markdown;base64,${Buffer.from(
          `# Markdown Upload ${token}\n\nThe token ${token} requires manager approval.\n\n## Notes\n\nTrace evidence should be visible.`,
          "utf8"
        ).toString("base64")}`,
      expectedParserName: "go-text-parser"
    });

    report.cases.success.docx = await runSuccessCase({
      caseName: "docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: `sample-${Date.now()}.docx`,
      buildSource: (token) => `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buildDocxBuffer(token).toString("base64")}`,
      expectedParserName: "go-docx-parser"
    });

    report.cases.success.pdf = await runPdfMainCase();

    report.cases.failure.unsupported_format = await runFailureCase({
      label: "unsupported-format",
      port: unsupportedGoPort,
      source: {
        uri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buildDocxBuffer(uniqueToken("unsupported")).toString("base64")}`,
        filename: `unsupported-${Date.now()}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      expectedCode: "unsupported-format",
      expectedRetryable: false
    });

    report.cases.failure.parse_failed = await runFailureCase({
      label: "parse-failed",
      port: mainGoPort,
      source: {
        uri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${Buffer.from("broken-docx-payload", "utf8").toString("base64")}`,
        filename: `broken-${Date.now()}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      expectedCode: "parse-failed",
      expectedRetryable: false
    });

    const missingFilePath = path.join(tempRoot, `missing-${Date.now()}.txt`);
    report.cases.failure.file_read_failed = await runFailureCase({
      label: "file-read-failed",
      port: mainGoPort,
      source: {
        uri: pathToFileURL(missingFilePath).toString(),
        filename: "missing.txt",
        mimeType: "text/plain"
      },
      expectedCode: "file-read-failed",
      expectedRetryable: true
    });

    report.cases.failure.dependency_missing = await runFailureCase({
      label: "dependency-missing",
      port: dependencyGoPort,
      source: {
        uri: `data:application/pdf;base64,${buildPdfBuffer(uniqueToken("dependency")).toString("base64")}`,
        filename: `dependency-${Date.now()}.pdf`,
        mimeType: "application/pdf"
      },
      expectedCode: "dependency-missing",
      expectedRetryable: false
    });

    assertVerification(report);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    printSummary(report);
  } finally {
    await cleanupPorts([mainGoPort, unsupportedGoPort, dependencyGoPort, webPort]);
    await Promise.all(handles.map(stopProcess));
  }
}

async function runPdfMainCase() {
  const token = uniqueToken("pdf");
  const payload = buildIngestionPayload({
    documentId: `doc_pdf_${Date.now()}`,
    traceId: uniqueToken("trace-pdf"),
    source: {
      sourceType: "upload",
      uri: `data:application/pdf;base64,${buildPdfBuffer(token).toString("base64")}`,
      filename: `sample-${Date.now()}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 1024,
      checksum: null
    }
  });

  const created = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  await runTaskOnMain(created.taskId);
  const task = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks/${encodeURIComponent(created.taskId)}`);

  const parserErrorCode = readTaskParserErrorCode(task);
  if (task.status === "failed" && parserErrorCode === "dependency-missing") {
    return {
      acceptedAsDependencyMissing: true,
      taskId: task.taskId,
      status: task.status,
      currentStage: task.currentStage,
      parserErrorCode,
      retryable: task.retryable,
      failureStage: task.failureStage,
      failureReason: task.failureReason,
      failedTracePresent: Array.isArray(task.trace) && task.trace.some((event) => event.stage === "failed")
    };
  }

  const success = await buildSuccessAssertions({
    task,
    token,
    expectedParserName: "go-pdf-parser",
    caseName: "pdf"
  });
  return {
    acceptedAsDependencyMissing: false,
    ...success
  };
}

async function runSuccessCase({ caseName, mimeType, filename, buildSource, expectedParserName }) {
  const token = uniqueToken(caseName);
  const sourceUri = buildSource(token);
  const payload = buildIngestionPayload({
    documentId: `doc_${caseName}_${Date.now()}`,
    traceId: uniqueToken(`trace-${caseName}`),
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  await runTaskOnMain(created.taskId);
  const task = await fetchJson(`http://127.0.0.1:${webPort}/api/admin/ingestion/tasks/${encodeURIComponent(created.taskId)}`);

  return buildSuccessAssertions({
    task,
    token,
    expectedParserName,
    caseName
  });
}

async function buildSuccessAssertions({ task, token, expectedParserName, caseName }) {
  const retrieval = await fetchJson(`http://127.0.0.1:${mainGoPort}/internal/retrieval/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      traceId: uniqueToken(`retrieval-${caseName}`),
      query: token,
      knowledgeBaseIds: ["kb_policy"],
      topK: 3,
      filters: {}
    })
  });

  const chat = await verifyChatEvidence(token);
  const parserName = task.parserResult?.parserName ?? null;
  const parserVersion = task.parserResult?.parserVersion ?? null;
  const parsedCharCount = Number(task.parserResult?.parsedDocument?.charCount ?? 0);
  const chunkCount = Number(task.chunks?.length ?? 0);
  const indexedRecordCount = Number(task.indexWriteResult?.recordCount ?? 0);

  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserName,
    parserVersion,
    expectedParserName,
    parsedCharCount,
    chunkCount,
    indexedRecordCount,
    retrievalSource: retrieval.source,
    retrievalChunkCount: retrieval.chunks.length,
    retrievalTopDocumentId: retrieval.chunks[0]?.documentId ?? null,
    chatEvidence: chat,
    traceFailedPresent: Array.isArray(task.trace) && task.trace.some((event) => event.stage === "failed")
  };
}

async function verifyChatEvidence(token) {
  const chatResponse = await fetchJson(`http://127.0.0.1:${webPort}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "conv_demo",
      message: `According to document token ${token}, what is the policy requirement?`
    })
  });
  const chatTraceItems = (await fetchJson(`http://127.0.0.1:${webPort}/api/trace`)).items.filter((item) => item.traceId === chatResponse.traceId);
  const chatEvidenceCount = Number(
    chatTraceItems.find((item) => item.stage === "context.assembly")?.metadata?.evidenceCount ?? 0
  );

  const streamResponse = await fetchText(`http://127.0.0.1:${webPort}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "conv_demo",
      message: `Please verify token ${token} from indexed document evidence.`
    })
  });
  const streamEvents = parseNdjson(streamResponse);
  const completed = streamEvents.find((event) => event.type === "message.completed");
  const streamTraceId = completed?.traceId ?? null;
  const streamTraceItems = streamTraceId
    ? (await fetchJson(`http://127.0.0.1:${webPort}/api/trace`)).items.filter((item) => item.traceId === streamTraceId)
    : [];
  const streamEvidenceCount = Number(
    streamTraceItems.find((item) => item.stage === "context.assembly")?.metadata?.evidenceCount ?? 0
  );

  return {
    apiChatTraceId: chatResponse.traceId,
    apiChatRetrievalSource: chatResponse.assistantMessage?.metadata?.retrievalSource ?? null,
    apiChatEvidenceCount: chatEvidenceCount,
    apiChatStreamTraceId: streamTraceId,
    apiChatStreamRetrievalSource: completed?.assistantMessage?.metadata?.retrievalSource ?? null,
    apiChatStreamEvidenceCount: streamEvidenceCount
  };
}

async function runFailureCase({ label, port, source, expectedCode, expectedRetryable }) {
  const payload = buildIngestionPayload({
    documentId: `doc_fail_${label}_${Date.now()}`,
    traceId: uniqueToken(`trace-fail-${label}`),
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
  const task = await fetchJson(`http://127.0.0.1:${port}/internal/ingestion/tasks/${encodeURIComponent(created.taskId)}`);

  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserErrorCode: readTaskParserErrorCode(task),
    retryable: Boolean(task.retryable),
    failureStage: task.failureStage,
    failureReason: task.failureReason,
    expectedCode,
    expectedRetryable,
    failedTracePresent: Array.isArray(task.trace) && task.trace.some((event) => event.stage === "failed"),
    retryScheduledTracePresent: Array.isArray(task.trace) && task.trace.some((event) => event.stage === "retry-scheduled")
  };
}

function assertVerification(report) {
  const failures = [];
  const successCases = report.cases.success;
  const failureCases = report.cases.failure;

  const successKeys = ["text_plain", "text_markdown", "docx"];
  for (const key of successKeys) {
    const item = successCases[key];
    if (item.status !== "succeeded" || item.currentStage !== "completed") {
      failures.push(`${key}: expected succeeded/completed, got ${item.status}/${item.currentStage}`);
    }
    if (item.parserName !== item.expectedParserName) {
      failures.push(`${key}: parser mismatch, expected ${item.expectedParserName}, got ${item.parserName}`);
    }
    if (!item.parserVersion) failures.push(`${key}: parserVersion missing`);
    if (item.parsedCharCount <= 0) failures.push(`${key}: parsed char count <= 0`);
    if (item.chunkCount <= 0) failures.push(`${key}: chunk count <= 0`);
    if (item.indexedRecordCount <= 0) failures.push(`${key}: indexed record count <= 0`);
    if (item.retrievalSource !== "indexed-store") failures.push(`${key}: retrieval source is ${item.retrievalSource}`);
    if ((item.chatEvidence?.apiChatEvidenceCount ?? 0) <= 0) failures.push(`${key}: /api/chat evidence count <= 0`);
    if ((item.chatEvidence?.apiChatStreamEvidenceCount ?? 0) <= 0) failures.push(`${key}: /api/chat/stream evidence count <= 0`);
    if (item.chatEvidence?.apiChatRetrievalSource !== "indexed-store") {
      failures.push(`${key}: /api/chat retrieval source is ${item.chatEvidence?.apiChatRetrievalSource}`);
    }
    if (item.chatEvidence?.apiChatStreamRetrievalSource !== "indexed-store") {
      failures.push(`${key}: /api/chat/stream retrieval source is ${item.chatEvidence?.apiChatStreamRetrievalSource}`);
    }
  }

  const pdf = successCases.pdf;
  if (pdf.acceptedAsDependencyMissing) {
    if (pdf.parserErrorCode !== "dependency-missing") failures.push(`pdf: expected dependency-missing, got ${pdf.parserErrorCode}`);
    if (Boolean(pdf.retryable)) failures.push(`pdf: expected retryable!=true on dependency-missing, got ${pdf.retryable}`);
    if (!pdf.failedTracePresent) failures.push("pdf: failed trace missing on dependency-missing");
  } else {
    if (pdf.status !== "succeeded" || pdf.currentStage !== "completed") {
      failures.push(`pdf: expected succeeded/completed, got ${pdf.status}/${pdf.currentStage}`);
    }
    if (pdf.parserName !== "go-pdf-parser") failures.push(`pdf: parser mismatch, got ${pdf.parserName}`);
    if (!pdf.parserVersion) failures.push("pdf: parserVersion missing");
    if (pdf.parsedCharCount <= 0) failures.push("pdf: parsed char count <= 0");
    if (pdf.chunkCount <= 0) failures.push("pdf: chunk count <= 0");
    if (pdf.indexedRecordCount <= 0) failures.push("pdf: indexed record count <= 0");
    if (pdf.retrievalSource !== "indexed-store") failures.push(`pdf: retrieval source is ${pdf.retrievalSource}`);
    if ((pdf.chatEvidence?.apiChatEvidenceCount ?? 0) <= 0) failures.push("pdf: /api/chat evidence count <= 0");
    if ((pdf.chatEvidence?.apiChatStreamEvidenceCount ?? 0) <= 0) failures.push("pdf: /api/chat/stream evidence count <= 0");
    if (pdf.chatEvidence?.apiChatRetrievalSource !== "indexed-store") {
      failures.push(`pdf: /api/chat retrieval source is ${pdf.chatEvidence?.apiChatRetrievalSource}`);
    }
    if (pdf.chatEvidence?.apiChatStreamRetrievalSource !== "indexed-store") {
      failures.push(`pdf: /api/chat/stream retrieval source is ${pdf.chatEvidence?.apiChatStreamRetrievalSource}`);
    }
  }

  for (const key of Object.keys(failureCases)) {
    const item = failureCases[key];
    if (item.parserErrorCode !== item.expectedCode) {
      failures.push(`${key}: expected parserErrorCode=${item.expectedCode}, got ${item.parserErrorCode}`);
    }
    if (item.retryable !== item.expectedRetryable) {
      failures.push(`${key}: expected retryable=${item.expectedRetryable}, got ${item.retryable}`);
    }
    if (item.failureStage !== "parser") {
      failures.push(`${key}: expected failureStage=parser, got ${item.failureStage}`);
    }
    if (!item.failureReason || String(item.failureReason).trim() === "") {
      failures.push(`${key}: failureReason missing`);
    }
    if (!item.failedTracePresent) {
      failures.push(`${key}: trace missing failed stage`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Document upload E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function readTaskParserErrorCode(task) {
  const metadata = task?.metadata ?? {};
  if (typeof metadata?.parserErrorCode === "string") {
    return metadata.parserErrorCode;
  }
  return null;
}

function buildIngestionPayload({ traceId, documentId, source }) {
  return {
    traceId,
    knowledgeBaseId: "kb_policy",
    documentId,
    requestedBy: "document-upload-e2e-script",
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
      initiatedFrom: "verify-document-upload-e2e"
    }
  };
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
  <dc:title>Document Upload DOCX ${xmlEscape(token)}</dc:title>
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

async function runTaskOnMain(taskId) {
  await fetchJson(`http://127.0.0.1:${mainGoPort}/internal/ingestion/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST"
  });
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

async function buildGoBinary() {
  const command = process.platform === "win32" ? "go.exe" : "go";
  await runCommand({
    command,
    args: ["build", "-o", goBinaryPath, "./cmd/retrieval-service"],
    cwd: path.join(repoRoot, "go", "retrievalexecutor"),
    label: "go-build-retrieval-service"
  });
}

function startGoService({
  label,
  port,
  taskStorePath,
  indexStorePath,
  parserProvider,
  parserPdfEnabled,
  parserDocxEnabled,
  envPatch = {}
}) {
  return startProcess({
    label,
    command: goBinaryPath,
    args: [],
    cwd: path.join(repoRoot, "go", "retrievalexecutor"),
    env: {
      PORT: String(port),
      GO_RETRIEVAL_SOURCE: "indexed-store",
      GO_RETRIEVAL_FALLBACK_ENABLED: "true",
      GO_RETRIEVAL_INDEX_STORE_PATH: indexStorePath,
      GO_INGESTION_TASK_STORE_PATH: taskStorePath,
      GO_INGESTION_RUNNER_ENABLED: "false",
      GO_INGESTION_RUNNER_INTERVAL: "500ms",
      GO_INGESTION_RUNNER_LIMIT: "2",
      GO_INGESTION_RUNNER_LEASE: "3s",
      PARSER_PROVIDER: parserProvider,
      PARSER_PDF_ENABLED: parserPdfEnabled ? "true" : "false",
      PARSER_DOCX_ENABLED: parserDocxEnabled ? "true" : "false",
      ...envPatch
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

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
    if (signal) {
      console.error(`[${label}] exited with signal ${signal}`);
    }
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

async function runCommand({ command, args, cwd, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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

function printSummary(report) {
  console.log(
    JSON.stringify(
      {
        reportPath,
        success: Object.fromEntries(
          Object.entries(report.cases.success).map(([key, value]) => [
            key,
            {
              taskId: value.taskId,
              status: value.status,
              currentStage: value.currentStage,
              parserName: value.parserName ?? null,
              parserErrorCode: value.parserErrorCode ?? null,
              retrievalSource: value.retrievalSource ?? null,
              chatEvidenceCount: value.chatEvidence?.apiChatEvidenceCount ?? null,
              streamEvidenceCount: value.chatEvidence?.apiChatStreamEvidenceCount ?? null,
              acceptedAsDependencyMissing: value.acceptedAsDependencyMissing ?? false
            }
          ])
        ),
        failure: report.cases.failure
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
