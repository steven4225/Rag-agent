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

const tempRoot = path.join(repoRoot, "tmp", "tika-parser-e2e");
const reportPath = path.join(tempRoot, "report.json");
const goBinaryPath = path.join(tempRoot, process.platform === "win32" ? "retrieval-service-tika-e2e.exe" : "retrieval-service-tika-e2e");
const goCachePath = path.join(tempRoot, "gocache");

const tikaUrl = process.env.PARSER_TIKA_URL ?? process.env.TIKA_PARSER_E2E_URL ?? "http://127.0.0.1:9998";
const goSuccessPort = Number(process.env.TIKA_PARSER_E2E_GO_PORT ?? "8495");
const goFallbackPort = Number(process.env.TIKA_PARSER_E2E_GO_FALLBACK_PORT ?? "8496");
const goFailurePort = Number(process.env.TIKA_PARSER_E2E_GO_FAILURE_PORT ?? "8497");

async function main() {
  await prepareWorkspace();

  const report = {
    tikaUrl,
    reportPath,
    status: "running",
    skipped: false,
    cases: {}
  };

  const reachable = await checkTikaReachable(tikaUrl);
  if (!reachable) {
    report.status = "skipped";
    report.skipped = true;
    report.reason = "tika-server-unreachable";
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await buildGoBinary();
  const handles = [];
  try {
    const success = startGoService({
      label: "go-tika-success",
      port: goSuccessPort,
      taskStorePath: path.join(tempRoot, "task-store.success.json"),
      indexStorePath: path.join(tempRoot, "index-store.success.json"),
      parserProvider: "tika",
      parserTikaUrl: tikaUrl,
      parserTikaFallbackEnabled: false
    });
    handles.push(success);
    await waitForHealthy(`http://127.0.0.1:${goSuccessPort}/healthz`, "go-tika-success", handles);

    report.cases.success_pdf = await runSuccessCase({
      port: goSuccessPort,
      label: "pdf",
      source: {
        filename: `policy-${Date.now()}.pdf`,
        mimeType: "application/pdf",
        uri: `data:application/pdf;base64,${buildPdfBuffer(uniqueToken("pdf")).toString("base64")}`
      }
    });
    report.cases.success_docx = await runSuccessCase({
      port: goSuccessPort,
      label: "docx",
      source: {
        filename: `policy-${Date.now()}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        uri: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buildDocxBuffer(uniqueToken("docx")).toString("base64")}`
      }
    });

    const fallback = startGoService({
      label: "go-tika-fallback",
      port: goFallbackPort,
      taskStorePath: path.join(tempRoot, "task-store.fallback.json"),
      indexStorePath: path.join(tempRoot, "index-store.fallback.json"),
      parserProvider: "tika",
      parserTikaUrl: "http://127.0.0.1:1",
      parserTikaFallbackEnabled: true
    });
    handles.push(fallback);
    await waitForHealthy(`http://127.0.0.1:${goFallbackPort}/healthz`, "go-tika-fallback", handles);
    report.cases.fallback_enabled = await runFallbackCase(goFallbackPort);

    const failure = startGoService({
      label: "go-tika-failure",
      port: goFailurePort,
      taskStorePath: path.join(tempRoot, "task-store.failure.json"),
      indexStorePath: path.join(tempRoot, "index-store.failure.json"),
      parserProvider: "tika",
      parserTikaUrl: "http://127.0.0.1:1",
      parserTikaFallbackEnabled: false
    });
    handles.push(failure);
    await waitForHealthy(`http://127.0.0.1:${goFailurePort}/healthz`, "go-tika-failure", handles);
    report.cases.fallback_disabled = await runFailureCase(goFailurePort);

    assertVerification(report);
    report.status = "passed";
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await cleanupPorts([goSuccessPort, goFallbackPort, goFailurePort]);
    await Promise.all(handles.map(stopProcess));
  }
}

async function runSuccessCase({ port, label, source }) {
  const created = await createAndRunTask(port, {
    documentId: uniqueToken(`doc-${label}`),
    source
  });
  const parsed = created.parserResult?.parsedDocument;
  return {
    taskId: created.taskId,
    status: created.status,
    currentStage: created.currentStage,
    parserBackend: created.parserResult?.parserBackend ?? null,
    parserName: created.parserResult?.parserName ?? null,
    parserVersion: created.parserResult?.parserVersion ?? null,
    parserErrorCode: created.metadata?.parserErrorCode ?? null,
    parsedCharCount: parsed?.charCount ?? 0,
    pageCount: parsed?.pageCount ?? null,
    hasTikaMetadataKeys: Array.isArray(parsed?.metadata?.tikaMetadataKeys),
    tikaContentType: parsed?.metadata?.tikaContentType ?? null
  };
}

async function runFallbackCase(port) {
  const task = await createAndRunTask(port, {
    documentId: uniqueToken("doc-fallback"),
    source: {
      filename: `fallback-${Date.now()}.pdf`,
      mimeType: "application/pdf",
      uri: `data:application/pdf;base64,${buildPdfBuffer(uniqueToken("fallback")).toString("base64")}`
    }
  });
  const parsed = task.parserResult?.parsedDocument;
  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserBackend: task.parserResult?.parserBackend ?? null,
    parserName: task.parserResult?.parserName ?? null,
    fallbackReason: parsed?.metadata?.fallbackReason ?? task.metadata?.fallbackReason ?? null,
    parserErrorCode: task.metadata?.parserErrorCode ?? null
  };
}

async function runFailureCase(port) {
  const task = await createAndRunTask(port, {
    documentId: uniqueToken("doc-failure"),
    source: {
      filename: `failure-${Date.now()}.pdf`,
      mimeType: "application/pdf",
      uri: `data:application/pdf;base64,${buildPdfBuffer(uniqueToken("failure")).toString("base64")}`
    }
  });
  return {
    taskId: task.taskId,
    status: task.status,
    currentStage: task.currentStage,
    parserErrorCode: task.metadata?.parserErrorCode ?? null,
    retryable: Boolean(task.retryable),
    failureStage: task.failureStage ?? null
  };
}

async function createAndRunTask(port, { documentId, source }) {
  const payload = buildIngestionPayload({
    traceId: uniqueToken("trace"),
    documentId,
    source
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

function buildIngestionPayload({ traceId, documentId, source }) {
  return {
    traceId,
    knowledgeBaseId: "kb_policy",
    documentId,
    requestedBy: "verify-tika-parser-e2e",
    source: {
      sourceType: "upload",
      uri: source.uri,
      filename: source.filename,
      mimeType: source.mimeType,
      sizeBytes: source.uri.length,
      checksum: null
    },
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
      initiatedFrom: "verify-tika-parser-e2e"
    }
  };
}

function assertVerification(report) {
  const failures = [];
  const successPdf = report.cases.success_pdf;
  const successDocx = report.cases.success_docx;
  const fallbackEnabled = report.cases.fallback_enabled;
  const fallbackDisabled = report.cases.fallback_disabled;

  for (const [key, value] of Object.entries({ success_pdf: successPdf, success_docx: successDocx })) {
    if (value.status !== "succeeded" || value.currentStage !== "completed") {
      failures.push(`${key}: expected succeeded/completed, got ${value.status}/${value.currentStage}`);
    }
    if (value.parserBackend !== "tika") {
      failures.push(`${key}: expected parserBackend=tika, got ${value.parserBackend}`);
    }
    if (value.parserName !== "go-tika-parser") {
      failures.push(`${key}: expected parserName=go-tika-parser, got ${value.parserName}`);
    }
    if (!value.parserVersion) {
      failures.push(`${key}: parserVersion missing`);
    }
    if (value.parsedCharCount <= 0) {
      failures.push(`${key}: parsedCharCount <= 0`);
    }
    if (!value.hasTikaMetadataKeys) {
      failures.push(`${key}: tikaMetadataKeys missing`);
    }
  }

  if (fallbackEnabled.status !== "succeeded" || fallbackEnabled.currentStage !== "completed") {
    failures.push(
      `fallback_enabled: expected succeeded/completed, got ${fallbackEnabled.status}/${fallbackEnabled.currentStage}`
    );
  }
  if (!fallbackEnabled.fallbackReason) {
    failures.push("fallback_enabled: fallbackReason missing");
  }
  if (fallbackEnabled.parserBackend !== "simple" && fallbackEnabled.parserBackend !== "text") {
    failures.push(`fallback_enabled: expected simple/text parser backend, got ${fallbackEnabled.parserBackend}`);
  }

  const allowedFailureCodes = new Set(["dependency-missing", "parser-backend-unavailable"]);
  if (fallbackDisabled.status !== "failed" || fallbackDisabled.currentStage !== "failed") {
    failures.push(
      `fallback_disabled: expected failed/failed, got ${fallbackDisabled.status}/${fallbackDisabled.currentStage}`
    );
  }
  if (!allowedFailureCodes.has(fallbackDisabled.parserErrorCode)) {
    failures.push(
      `fallback_disabled: expected parser error code in [dependency-missing, parser-backend-unavailable], got ${fallbackDisabled.parserErrorCode}`
    );
  }
  if (fallbackDisabled.retryable) {
    failures.push("fallback_disabled: expected retryable=false");
  }
  if (fallbackDisabled.failureStage !== "parser") {
    failures.push(`fallback_disabled: expected failureStage=parser, got ${fallbackDisabled.failureStage}`);
  }

  if (failures.length > 0) {
    throw new Error(`Tika parser E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

function startGoService({
  label,
  port,
  taskStorePath,
  indexStorePath,
  parserProvider,
  parserTikaUrl,
  parserTikaFallbackEnabled
}) {
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
      PARSER_PROVIDER: parserProvider,
      PARSER_TIKA_URL: parserTikaUrl,
      PARSER_TIKA_FALLBACK_ENABLED: parserTikaFallbackEnabled ? "true" : "false",
      PARSER_TIKA_TIMEOUT_MS: "1500",
      PARSER_PDF_ENABLED: "true",
      PARSER_DOCX_ENABLED: "true"
    }
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

async function checkTikaReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/tika`, {
      method: "PUT",
      headers: {
        Accept: "text/plain",
        "Content-Type": "text/plain"
      },
      body: "health-check"
    });
    return response.ok;
  } catch {
    return false;
  }
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

async function prepareWorkspace() {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
