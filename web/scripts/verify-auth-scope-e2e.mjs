import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  cleanupWindowsPorts,
  createRunContext,
  ensureNextBuild,
  prepareRunWorkspace,
  startProcess,
  stopProcess,
  waitForHealthy
} from "./_shared/e2e-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const runContext = createRunContext({ repoRoot, tempNamespace: "auth-scope-e2e" });
const { tempRoot, stateFilePath } = runContext;
const reportPath = path.join(tempRoot, "report.json");
const webPort = Number(process.env.AUTH_SCOPE_E2E_WEB_PORT ?? "3208");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");

const adminAHeaders = {
  "x-ragent-role": "admin",
  "x-ragent-user-id": "admin_a",
  "x-ragent-user-name": "Admin A",
  "x-ragent-tenant-id": "tenant_a",
  "x-ragent-org-id": "org_a"
};

const adminBHeaders = {
  "x-ragent-role": "admin",
  "x-ragent-user-id": "admin_b",
  "x-ragent-user-name": "Admin B",
  "x-ragent-tenant-id": "tenant_b",
  "x-ragent-org-id": "org_b"
};

const userAHeaders = {
  "x-ragent-role": "user",
  "x-ragent-user-id": "user_a",
  "x-ragent-user-name": "User A",
  "x-ragent-tenant-id": "tenant_a",
  "x-ragent-org-id": "org_a"
};

const userBHeaders = {
  "x-ragent-role": "user",
  "x-ragent-user-id": "user_b",
  "x-ragent-user-name": "User B",
  "x-ragent-tenant-id": "tenant_a",
  "x-ragent-org-id": "org_a"
};

const noTenantUserHeaders = {
  "x-ragent-role": "user",
  "x-ragent-user-id": "user_no_tenant",
  "x-ragent-user-name": "User No Tenant",
  "x-ragent-org-id": "org_a"
};

const noOrgAdminHeaders = {
  "x-ragent-role": "admin",
  "x-ragent-user-id": "admin_no_org",
  "x-ragent-user-name": "Admin No Org",
  "x-ragent-tenant-id": "tenant_a"
};
const preconditions = {
  requiredEnv: ["AUTH_SCOPE_E2E_WEB_PORT"],
  session: {
    adminA: adminAHeaders,
    adminB: adminBHeaders,
    userA: userAHeaders,
    userB: userBHeaders
  },
  externalDependencies: ["Node.js/Next.js runtime"],
  blockedOrSkippedWhen: [
    "Unable to build Next app",
    "Configured web port occupied and cannot be reclaimed"
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
      TS_PLATFORM_STATE_PATH: stateFilePath,
      RAGENT_FORCE_LOCAL_GENERATION: "true",
      AUTH_MOCK_DEFAULT_ROLE: ""
    },
    label: "next-start",
    logRoot: tempRoot
  });

  try {
    await waitForHealthy(`http://127.0.0.1:${webPort}/api/auth/session`, "next-start", [nextStart]);
    const report = await runVerification();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    assertVerification(report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await cleanupWindowsPorts([webPort]);
    await stopProcess(nextStart);
  }
}

async function runVerification() {
  const scenarioA = await verifySignedInUserOwnResources();
  const scenarioB = await verifyUserDeniedAdminApi();
  const scenarioC = await verifyAdminOwnScopeAccess();
  const scenarioD = await verifyMissingScopeDenied();
  const scenarioE = await verifyCrossUserSessionDenied(scenarioA.createdConversationId);
  const scenarioF = await verifyMcpAdminToolDeniedForUser();
  const scenarioG = await verifyMcpAdminToolAllowedForScopedAdmin(scenarioC.createdSettingKey);
  const scenarioH = await verifyCrossTenantAdminIsolation();

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
      routes: ["/api/chat", "/api/conversations", "/api/messages", "/api/admin/*"],
      checks: ["http status", "error code/message", "data filter/deny", "mcp tool status/error"],
      scenarios: ["A", "B", "C", "D", "E", "F", "G", "H"]
    },
    scenarios: {
      A: scenarioA,
      B: scenarioB,
      C: scenarioC,
      D: scenarioD,
      E: scenarioE,
      F: scenarioF,
      G: scenarioG,
      H: scenarioH
    }
  };
}

async function verifySignedInUserOwnResources() {
  const createdConversation = await fetchJson(`${baseUrl()}/api/conversations`, {
    method: "POST",
    headers: withJsonHeaders(userAHeaders),
    body: JSON.stringify({
      title: "Auth scope scenario A"
    })
  });

  const appendMessage = await fetchJson(`${baseUrl()}/api/messages`, {
    method: "POST",
    headers: withJsonHeaders(userAHeaders),
    body: JSON.stringify({
      conversationId: createdConversation.conversationId,
      role: "user",
      content: "hello from scenario A"
    })
  });

  const listConversations = await fetchJson(`${baseUrl()}/api/conversations`, {
    headers: userAHeaders
  });

  const listMessages = await fetchJson(`${baseUrl()}/api/messages?conversationId=${encodeURIComponent(createdConversation.conversationId)}`, {
    headers: userAHeaders
  });

  const chatCall = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userAHeaders),
    body: JSON.stringify({
      conversationId: createdConversation.conversationId,
      message: "Please list knowledge bases currently available."
    })
  });

  const toolCall = findToolCall(chatCall, "list_knowledge_bases");

  return {
    routeChecks: {
      createConversationStatus: createdConversation.__http.status,
      appendMessageStatus: appendMessage.__http.status,
      listConversationsStatus: listConversations.__http.status,
      listMessagesStatus: listMessages.__http.status,
      chatStatus: chatCall.__http.status
    },
    dataChecks: {
      createdConversationId: createdConversation.conversationId,
      appendedMessageId: appendMessage.messageId,
      conversationsContainCreated: (listConversations.items ?? []).some((item) => item.conversationId === createdConversation.conversationId),
      listedMessagesCount: (listMessages.items ?? []).length
    },
    mcpChecks: {
      toolName: toolCall?.toolName ?? null,
      status: toolCall?.status ?? null,
      outputSummary: readToolSummary(toolCall),
      outputError: readToolError(toolCall)
    },
    assertions: {
      allHttpSuccess:
        createdConversation.__http.status === 200 &&
        appendMessage.__http.status === 200 &&
        listConversations.__http.status === 200 &&
        listMessages.__http.status === 200 &&
        chatCall.__http.status === 200,
      ownConversationReadable: (listConversations.items ?? []).some((item) => item.conversationId === createdConversation.conversationId),
      ownMessageReadable: (listMessages.items ?? []).some((item) => item.messageId === appendMessage.messageId),
      mcpSignedInToolSucceeded: toolCall?.status === "succeeded"
    },
    createdConversationId: createdConversation.conversationId
  };
}

async function verifyUserDeniedAdminApi() {
  const adminRoutes = await callAdminGetRoutes(userAHeaders);
  return {
    routeChecks: adminRoutes,
    assertions: {
      allDenied: adminRoutes.every((item) => item.status === 403 && item.code === "FORBIDDEN" && item.message === "Admin role required.")
    }
  };
}

async function verifyAdminOwnScopeAccess() {
  const unique = Date.now();
  const createdSetting = await fetchJson(`${baseUrl()}/api/admin/settings`, {
    method: "POST",
    headers: withJsonHeaders(adminAHeaders),
    body: JSON.stringify({
      key: `auth.scope.e2e.${unique}`,
      value: "enabled",
      description: "scenario C scoped admin write"
    })
  });

  const settingsRead = await fetchJson(`${baseUrl()}/api/admin/settings`, {
    headers: adminAHeaders
  });
  const dashboardRead = await fetchJson(`${baseUrl()}/api/admin/dashboard`, {
    headers: adminAHeaders
  });

  return {
    routeChecks: {
      createSettingStatus: createdSetting.__http.status,
      listSettingStatus: settingsRead.__http.status,
      dashboardStatus: dashboardRead.__http.status
    },
    dataChecks: {
      scopedSettingExists: (settingsRead.items ?? []).some((item) => item.key === createdSetting.key),
      metricsPresent: typeof dashboardRead.metrics?.conversations === "number"
    },
    assertions: {
      adminRouteSuccess: createdSetting.__http.status === 201 && settingsRead.__http.status === 200 && dashboardRead.__http.status === 200,
      adminSeesScopedData: (settingsRead.items ?? []).some((item) => item.key === createdSetting.key)
    },
    createdSettingKey: createdSetting.key
  };
}

async function verifyMissingScopeDenied() {
  const chatNoTenant = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(noTenantUserHeaders),
    body: JSON.stringify({
      message: "hello"
    })
  });

  const adminNoTenant = await fetchJson(`${baseUrl()}/api/admin/dashboard`, {
    headers: noTenantUserHeaders
  });

  const adminNoOrg = await fetchJson(`${baseUrl()}/api/admin/dashboard`, {
    headers: noOrgAdminHeaders
  });

  const chatPageResponse = await fetch(`${baseUrl()}/chat`, {
    headers: {
      cookie: buildSessionCookie({
        userId: "page_user_no_tenant",
        role: "user",
        name: "Page User",
        tenantId: null,
        orgId: "org_a"
      })
    },
    redirect: "manual"
  });

  const adminPageResponse = await fetch(`${baseUrl()}/admin`, {
    headers: {
      cookie: buildSessionCookie({
        userId: "page_admin_no_org",
        role: "admin",
        name: "Page Admin",
        tenantId: "tenant_a",
        orgId: null
      })
    },
    redirect: "manual"
  });

  const chatPageBody = await chatPageResponse.text();
  const adminPageBody = await adminPageResponse.text();

  const chatPageDeniedSignal = hasPageDeniedSignal(chatPageResponse, chatPageBody);
  const adminPageDeniedSignal = hasPageDeniedSignal(adminPageResponse, adminPageBody);

  return {
    apiChecks: {
      chatNoTenant: summarizeHttp(chatNoTenant),
      adminNoTenant: summarizeHttp(adminNoTenant),
      adminNoOrg: summarizeHttp(adminNoOrg)
    },
    pageChecks: {
      chatPageStatus: chatPageResponse.status,
      chatPageLocation: chatPageResponse.headers.get("location"),
      chatPageDeniedSignal,
      adminPageStatus: adminPageResponse.status,
      adminPageLocation: adminPageResponse.headers.get("location"),
      adminPageDeniedSignal
    },
    assertions: {
      chatApiDeniedNoTenant:
        chatNoTenant.__http.status === 403 &&
        chatNoTenant.code === "TENANT_SCOPE_REQUIRED" &&
        chatNoTenant.message === "Tenant scope required.",
      adminApiDeniedNoTenant:
        adminNoTenant.__http.status === 403 &&
        adminNoTenant.code === "FORBIDDEN" &&
        adminNoTenant.message === "Admin role required.",
      adminApiDeniedNoOrg:
        adminNoOrg.__http.status === 403 &&
        adminNoOrg.code === "ORG_SCOPE_REQUIRED" &&
        adminNoOrg.message === "Org scope required.",
      pageDeniedSignal: chatPageDeniedSignal && adminPageDeniedSignal
    }
  };
}

async function verifyCrossUserSessionDenied(conversationId) {
  const userBMessagesRead = await fetchJson(`${baseUrl()}/api/messages?conversationId=${encodeURIComponent(conversationId)}`, {
    headers: userBHeaders
  });

  const userBChatCall = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userBHeaders),
    body: JSON.stringify({
      conversationId,
      message: "attempt cross-user conversation access"
    })
  });

  return {
    routeChecks: {
      messagesRead: summarizeHttp(userBMessagesRead),
      chatWithForeignConversation: summarizeHttp(userBChatCall)
    },
    assertions: {
      messagesDenied:
        userBMessagesRead.__http.status === 404 &&
        userBMessagesRead.code === "NOT_FOUND" &&
        userBMessagesRead.message === "Conversation does not exist.",
      chatDenied:
        userBChatCall.__http.status === 404 &&
        userBChatCall.code === "NOT_FOUND" &&
        userBChatCall.message === "Conversation does not exist."
    }
  };
}

async function verifyMcpAdminToolDeniedForUser() {
  const response = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(userAHeaders),
    body: JSON.stringify({
      message: "Please read system setting retrieval.adapter."
    })
  });
  const toolCall = findToolCall(response, "get_system_setting");
  return {
    routeChecks: {
      chatStatus: response.__http.status
    },
    mcpChecks: {
      toolName: toolCall?.toolName ?? null,
      status: toolCall?.status ?? null,
      outputSummary: readToolSummary(toolCall),
      outputError: readToolError(toolCall)
    },
    assertions: {
      toolFailedByGuard: toolCall?.status === "failed" && readToolSummary(toolCall).toLowerCase().includes("admin role required")
    }
  };
}

async function verifyMcpAdminToolAllowedForScopedAdmin(settingKey) {
  const response = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders(adminAHeaders),
    body: JSON.stringify({
      message: `Please read system setting ${settingKey}.`
    })
  });
  const toolCall = findToolCall(response, "get_system_setting");
  return {
    routeChecks: {
      chatStatus: response.__http.status
    },
    mcpChecks: {
      toolName: toolCall?.toolName ?? null,
      status: toolCall?.status ?? null,
      outputSummary: readToolSummary(toolCall),
      outputError: readToolError(toolCall)
    },
    assertions: {
      toolSucceeded: toolCall?.status === "succeeded" && !readToolError(toolCall)
    }
  };
}

async function verifyCrossTenantAdminIsolation() {
  const unique = Date.now();
  const createdByAdminA = await fetchJson(`${baseUrl()}/api/admin/settings`, {
    method: "POST",
    headers: withJsonHeaders(adminAHeaders),
    body: JSON.stringify({
      key: `auth.scope.cross.tenant.${unique}`,
      value: "tenant-a-only",
      description: "scenario H cross tenant isolation"
    })
  });

  const adminAList = await fetchJson(`${baseUrl()}/api/admin/settings`, {
    headers: adminAHeaders
  });
  const adminBList = await fetchJson(`${baseUrl()}/api/admin/settings`, {
    headers: adminBHeaders
  });

  return {
    routeChecks: {
      createStatus: createdByAdminA.__http.status,
      adminAListStatus: adminAList.__http.status,
      adminBListStatus: adminBList.__http.status
    },
    dataChecks: {
      presentInAdminA: (adminAList.items ?? []).some((item) => item.key === createdByAdminA.key),
      presentInAdminB: (adminBList.items ?? []).some((item) => item.key === createdByAdminA.key)
    },
    assertions: {
      isolatedByTenantOrg:
        createdByAdminA.__http.status === 201 &&
        (adminAList.items ?? []).some((item) => item.key === createdByAdminA.key) &&
        !(adminBList.items ?? []).some((item) => item.key === createdByAdminA.key)
    }
  };
}

async function callAdminGetRoutes(headers) {
  const routes = [
    "/api/admin/dashboard",
    "/api/admin/knowledge-bases",
    "/api/admin/ingestion/tasks",
    "/api/admin/mappings",
    "/api/admin/sample-questions",
    "/api/admin/settings"
  ];

  const results = [];
  for (const route of routes) {
    const response = await fetchJson(`${baseUrl()}${route}`, { headers });
    results.push({
      route,
      status: response.__http.status,
      code: response.code ?? null,
      message: response.message ?? null
    });
  }
  return results;
}

function findToolCall(chatResponse, toolName) {
  const calls = Array.isArray(chatResponse?.assistantMessage?.metadata?.toolCalls) ? chatResponse.assistantMessage.metadata.toolCalls : [];
  return calls.find((item) => item.toolName === toolName) ?? null;
}

function readToolSummary(call) {
  if (!call || typeof call !== "object") return "";
  if (!call.output || typeof call.output !== "object") return "";
  return typeof call.output.summary === "string" ? call.output.summary : "";
}

function readToolError(call) {
  if (!call || typeof call !== "object") return null;
  if (!call.output || typeof call.output !== "object") return null;
  return call.output.error ?? null;
}

function summarizeHttp(body) {
  return {
    status: body.__http.status,
    code: body.code ?? null,
    message: body.message ?? null
  };
}

function assertVerification(report) {
  const failures = [];
  const scenarios = report.scenarios;

  if (!scenarios.A.assertions.allHttpSuccess) failures.push("scenario A expected successful access to own chat/conversation/message APIs");
  if (!scenarios.A.assertions.ownConversationReadable) failures.push("scenario A expected own conversation to be listed");
  if (!scenarios.A.assertions.ownMessageReadable) failures.push("scenario A expected own message to be listed");
  if (!scenarios.A.assertions.mcpSignedInToolSucceeded) failures.push("scenario A expected signed-in MCP tool to succeed");

  if (!scenarios.B.assertions.allDenied) failures.push("scenario B expected user to be denied by admin routes");
  if (!scenarios.C.assertions.adminRouteSuccess) failures.push("scenario C expected admin routes success");
  if (!scenarios.C.assertions.adminSeesScopedData) failures.push("scenario C expected admin to read scoped data");
  if (!scenarios.D.assertions.chatApiDeniedNoTenant) failures.push("scenario D expected chat API deny without tenant scope");
  if (!scenarios.D.assertions.adminApiDeniedNoTenant) failures.push("scenario D expected admin API deny without admin role/tenant");
  if (!scenarios.D.assertions.adminApiDeniedNoOrg) failures.push("scenario D expected admin API deny without org scope");
  if (!scenarios.D.assertions.pageDeniedSignal) failures.push("scenario D expected chat/admin pages or APIs to deny missing scope");
  if (!scenarios.E.assertions.messagesDenied) failures.push("scenario E expected cross-user messages access denied");
  if (!scenarios.E.assertions.chatDenied) failures.push("scenario E expected cross-user chat access denied");
  if (!scenarios.F.assertions.toolFailedByGuard) failures.push("scenario F expected user MCP admin tool guard failure");
  if (!scenarios.G.assertions.toolSucceeded) failures.push("scenario G expected scoped admin MCP tool success");
  if (!scenarios.H.assertions.isolatedByTenantOrg) failures.push("scenario H expected cross-tenant admin data isolation");

  if (failures.length > 0) {
    throw new Error(`Auth/scope E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = {
      raw: text
    };
  }

  const normalized = body && typeof body === "object" ? body : { value: body };
  return {
    ...normalized,
    __http: {
      status: response.status,
      ok: response.ok
    }
  };
}

function withJsonHeaders(headers) {
  return {
    "Content-Type": "application/json",
    ...headers
  };
}

function hasPageDeniedSignal(response, bodyText) {
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400 && location.includes("/login")) {
    return true;
  }
  const lowered = bodyText.toLowerCase();
  return lowered.includes("next_redirect") || lowered.includes("/login");
}

function buildSessionCookie(payload) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return `ragent_session=${encoded}`;
}

function baseUrl() {
  return `http://127.0.0.1:${webPort}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
