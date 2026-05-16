import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  cleanupWindowsPorts,
  ensureNextBuild,
  fetchJson,
  startProcess,
  stopProcess,
  waitForHealthy,
  withJsonHeaders
} from "./_shared/e2e-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const nextCliPath = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const externalWebMode = process.env.OIDC_E2E_EXTERNAL_WEB === "1";

const requestedWebPort = Number(process.env.OIDC_E2E_WEB_PORT ?? "3210");
const requestedOidcPort = Number(process.env.OIDC_E2E_OIDC_PORT ?? "9210");
let activeWebPort = requestedWebPort;
let activeOidcPort = requestedOidcPort;
const reportDir = path.join(repoRoot, "tmp", "oidc-e2e");
const reportPath = path.join(reportDir, "report.json");
const stateFilePath = path.join(reportDir, "ts-platform-state.json");

const logRoot = path.join(reportDir, "logs");

const personas = [
  {
    userId: "oidc_user_demo",
    name: "OIDC User",
    role: "user",
    tenantId: "tenant_oidc",
    orgId: "org_oidc"
  },
  {
    userId: "oidc_admin_demo",
    name: "OIDC Admin",
    role: "admin",
    tenantId: "tenant_oidc",
    orgId: "org_oidc"
  }
];

async function main() {
  activeWebPort = externalWebMode ? requestedWebPort : await resolveAvailablePort(requestedWebPort);
  activeOidcPort = externalWebMode ? requestedOidcPort : await resolveAvailablePort(requestedOidcPort);
  await cleanupWindowsPorts([activeWebPort, activeOidcPort]);
  await fs.mkdir(logRoot, { recursive: true });

  const mockOidc = await startMockOidcProvider({ port: activeOidcPort });
  let nextStart = null;

  if (!externalWebMode) {
    await ensureNextBuild({ webRoot, nextCliPath, repoRoot });

    nextStart = startProcess({
      command: process.execPath,
      args: [nextCliPath, "start", "--port", String(activeWebPort)],
      cwd: webRoot,
      env: {
        TS_PLATFORM_STATE_PATH: stateFilePath,
        RAGENT_FORCE_LOCAL_GENERATION: "true",
        AUTH_PROVIDER_MODE: "oidc",
        AUTH_MOCK_FALLBACK_ENABLED: "false",
        AUTH_HEADER_AUTH_ENABLED: "false",
        AUTH_MOCK_DEFAULT_ROLE: "",
        AUTH_OIDC_AUTHORIZATION_ENDPOINT: `${oidcBaseUrl()}/authorize`,
        AUTH_OIDC_TOKEN_ENDPOINT: `${oidcBaseUrl()}/token`,
        AUTH_OIDC_USERINFO_ENDPOINT: `${oidcBaseUrl()}/userinfo`,
        AUTH_OIDC_CLIENT_ID: "oidc-e2e-client",
        AUTH_OIDC_CLIENT_SECRET: "oidc-e2e-secret",
        AUTH_OIDC_DEFAULT_ROLE: "user",
        AUTH_OIDC_DEFAULT_TENANT_ID: "tenant_oidc",
        AUTH_OIDC_DEFAULT_ORG_ID: "org_oidc",
        AUTH_OIDC_ADMIN_ROLE_VALUES: "admin"
      },
      label: "next-start",
      logRoot
    });
  }

  try {
    await waitForHealthy(`${baseUrl()}/api/auth/session`, "next-start", nextStart ? [nextStart] : []);
    const report = await runVerification(mockOidc);
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    assertReport(report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mockOidc.stop();
    await cleanupWindowsPorts([activeWebPort, activeOidcPort]);
    await stopProcess(nextStart);
  }
}

async function runVerification(mockOidc) {
  const userLogin = await performOidcLogin({
    expectedRole: "user",
    expectedDestination: "/chat"
  });

  const adminLogin = await performOidcLogin({
    expectedRole: "admin",
    expectedDestination: "/admin/dashboard"
  });

  const userChecks = await verifyUserSession(userLogin.jar);
  const adminChecks = await verifyAdminSession(adminLogin.jar);
  const mcpChecks = await verifyMcpGuards({
    userJar: userLogin.jar,
    adminJar: adminLogin.jar
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      authFlow: ["login route", "callback route", "session cookie"],
      guardFlow: ["chat page/api", "admin page/api", "admin api deny for user", "mcp role guard"]
    },
    environment: {
      webPort: activeWebPort,
      oidcPort: activeOidcPort,
      reportPath,
      stateFilePath,
      authProviderMode: "oidc",
      headerAuthEnabled: false,
      mockFallbackEnabled: false,
      externalWebMode
    },
    oidcProvider: {
      issuedCodes: mockOidc.getIssuedCodes(),
      personas
    },
    logins: {
      user: userLogin.summary,
      admin: adminLogin.summary
    },
    checks: {
      userSession: userChecks,
      adminSession: adminChecks,
      mcpRuntime: mcpChecks
    }
  };
}

async function performOidcLogin({ expectedRole, expectedDestination }) {
  const jar = createCookieJar();

  const loginResponse = await fetch(`${baseUrl()}/api/auth/oidc/login`, {
    method: "GET",
    redirect: "manual"
  });

  jar.absorb(loginResponse);
  const loginLocation = loginResponse.headers.get("location");
  const oidcStateCookie = jar.get("ragent_oidc_state");

  if (!loginLocation) {
    throw new Error("OIDC login route did not return redirect location.");
  }

  const authorizeUrl = new URL(loginLocation);
  const authorizeResponse = await fetch(authorizeUrl, {
    method: "GET",
    redirect: "manual"
  });
  const callbackLocation = authorizeResponse.headers.get("location");

  if (!callbackLocation) {
    throw new Error("OIDC authorize endpoint did not return callback redirect.");
  }

  const callbackResponse = await fetch(callbackLocation, {
    method: "GET",
    redirect: "manual",
    headers: {
      Cookie: jar.header()
    }
  });

  jar.absorb(callbackResponse);
  const callbackRedirect = callbackResponse.headers.get("location");
  const callbackBody = await callbackResponse.text();
  const sessionRaw = jar.get("ragent_session");
  if (!sessionRaw) {
    throw new Error(
      `OIDC callback did not set session cookie. status=${callbackResponse.status}, redirect=${callbackRedirect ?? "null"}, body=${callbackBody.slice(0, 200)}`
    );
  }
  const sessionPayload = decodeSessionCookie(sessionRaw);

  return {
    jar,
    summary: {
      loginStatus: loginResponse.status,
      loginRedirect: loginLocation,
      stateCookiePresentAfterLogin: Boolean(oidcStateCookie),
      callbackStatus: callbackResponse.status,
      callbackRedirect,
      expectedDestination,
      sessionCookiePresent: Boolean(sessionRaw),
      stateCookieClearedAfterCallback: !jar.get("ragent_oidc_state"),
      session: sessionPayload,
      assertions: {
        loginRedirectedToAuthorize:
          loginResponse.status >= 300 &&
          loginResponse.status < 400 &&
          authorizeUrl.origin === oidcBaseUrl() &&
          authorizeUrl.pathname === "/authorize",
        callbackRedirectedToDestination:
          callbackResponse.status >= 300 &&
          callbackResponse.status < 400 &&
          callbackRedirect !== null &&
          new URL(callbackRedirect, baseUrl()).pathname === expectedDestination,
        roleMatched: sessionPayload?.role === expectedRole,
        tenantMatched: sessionPayload?.tenantId === "tenant_oidc",
        orgMatched: sessionPayload?.orgId === "org_oidc"
      }
    }
  };
}

async function verifyUserSession(jar) {
  const cookieHeader = jar.header();
  const session = await fetchJson(`${baseUrl()}/api/auth/session`, {
    headers: {
      Cookie: cookieHeader
    }
  });

  if (!session?.user) {
    throw new Error(`OIDC user session was not recognized by /api/auth/session. cookie=${cookieHeader}`);
  }

  const chatPage = await fetch(`${baseUrl()}/chat`, {
    headers: {
      Cookie: cookieHeader
    },
    redirect: "manual"
  });

  const conversations = await fetchJson(`${baseUrl()}/api/conversations`, {
    headers: {
      Cookie: cookieHeader
    }
  });

  const adminDashboard = await fetchWithBody(`${baseUrl()}/api/admin/dashboard`, {
    headers: {
      Cookie: cookieHeader
    }
  });

  return {
    session: {
      mode: session.mode,
      oidcEnabled: session.oidcEnabled,
      mockFallbackEnabled: session.mockFallbackEnabled,
      userRole: session.user?.role,
      userId: session.user?.userId
    },
    routes: {
      chatPageStatus: chatPage.status,
      conversationsStatus: 200,
      adminDashboardStatus: adminDashboard.status,
      adminDashboardCode: adminDashboard.body?.code ?? null,
      adminDashboardMessage: adminDashboard.body?.message ?? null
    },
    assertions: {
      sessionModeIsOidc: session.mode === "oidc",
      userRoleIsUser: session.user?.role === "user",
      chatPageAccessible: chatPage.status === 200,
      conversationsAccessible: true,
      adminApiDenied:
        adminDashboard.status === 403 &&
        adminDashboard.body?.code === "FORBIDDEN" &&
        adminDashboard.body?.message === "Admin role required."
    }
  };
}

async function verifyAdminSession(jar) {
  const session = await fetchJson(`${baseUrl()}/api/auth/session`, {
    headers: {
      Cookie: jar.header()
    }
  });

  const adminPage = await fetch(`${baseUrl()}/admin/dashboard`, {
    headers: {
      Cookie: jar.header()
    },
    redirect: "manual"
  });

  const adminDashboard = await fetchJson(`${baseUrl()}/api/admin/dashboard`, {
    headers: {
      Cookie: jar.header()
    }
  });

  return {
    session: {
      mode: session.mode,
      userRole: session.user?.role,
      userId: session.user?.userId
    },
    routes: {
      adminPageStatus: adminPage.status,
      adminDashboardStatus: 200
    },
    assertions: {
      sessionModeIsOidc: session.mode === "oidc",
      adminRolePresent: session.user?.role === "admin",
      adminPageAccessible: adminPage.status === 200,
      adminApiAccessible: true
    }
  };
}

async function verifyMcpGuards({ userJar, adminJar }) {
  const settingKey = `oidc.e2e.${Date.now()}`;

  const settingWrite = await fetchWithBody(`${baseUrl()}/api/admin/settings`, {
    method: "POST",
    headers: withJsonHeaders({
      Cookie: adminJar.header()
    }),
    body: JSON.stringify({
      key: settingKey,
      value: "enabled",
      description: "OIDC E2E MCP guard verification"
    })
  });

  if (settingWrite.status !== 201) {
    throw new Error(`Unable to seed admin setting for MCP verification: ${settingWrite.status}`);
  }

  const userChat = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders({
      Cookie: userJar.header()
    }),
    body: JSON.stringify({
      message: `Please read system setting ${settingKey}.`
    })
  });

  const adminChat = await fetchJson(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: withJsonHeaders({
      Cookie: adminJar.header()
    }),
    body: JSON.stringify({
      message: `Please read system setting ${settingKey}.`
    })
  });

  const userToolCall = findToolCall(userChat, "get_system_setting");
  const adminToolCall = findToolCall(adminChat, "get_system_setting");

  return {
    seededSettingKey: settingKey,
    routeStatus: {
      userChat: 200,
      adminChat: 200
    },
    toolChecks: {
      user: {
        status: userToolCall?.status ?? null,
        summary: readToolSummary(userToolCall),
        error: readToolError(userToolCall)
      },
      admin: {
        status: adminToolCall?.status ?? null,
        summary: readToolSummary(adminToolCall),
        error: readToolError(adminToolCall)
      }
    },
    assertions: {
      userDeniedByToolGuard:
        userToolCall?.status === "failed" &&
        readToolSummary(userToolCall).toLowerCase().includes("admin role required"),
      adminAllowedByToolGuard: adminToolCall?.status === "succeeded" && !readToolError(adminToolCall)
    }
  };
}

function assertReport(report) {
  const failures = [];

  const userLogin = report.logins.user;
  const adminLogin = report.logins.admin;
  const userChecks = report.checks.userSession;
  const adminChecks = report.checks.adminSession;
  const mcpChecks = report.checks.mcpRuntime;

  if (!userLogin.assertions.loginRedirectedToAuthorize) failures.push("user login route did not redirect to OIDC authorize endpoint");
  if (!userLogin.assertions.callbackRedirectedToDestination) failures.push("user callback route did not redirect to /chat");
  if (!userLogin.assertions.roleMatched) failures.push("user OIDC session role mismatch");
  if (!userLogin.assertions.tenantMatched) failures.push("user OIDC tenant claim not mapped");
  if (!userLogin.assertions.orgMatched) failures.push("user OIDC org claim not mapped");

  if (!adminLogin.assertions.loginRedirectedToAuthorize) failures.push("admin login route did not redirect to OIDC authorize endpoint");
  if (!adminLogin.assertions.callbackRedirectedToDestination) failures.push("admin callback route did not redirect to /admin/dashboard");
  if (!adminLogin.assertions.roleMatched) failures.push("admin OIDC session role mismatch");
  if (!adminLogin.assertions.tenantMatched) failures.push("admin OIDC tenant claim not mapped");
  if (!adminLogin.assertions.orgMatched) failures.push("admin OIDC org claim not mapped");

  if (!userChecks.assertions.sessionModeIsOidc) failures.push("user session mode is not oidc");
  if (!userChecks.assertions.userRoleIsUser) failures.push("user session role is not user");
  if (!userChecks.assertions.chatPageAccessible) failures.push("user cannot access /chat page with OIDC session");
  if (!userChecks.assertions.conversationsAccessible) failures.push("user cannot access chat API with OIDC session");
  if (!userChecks.assertions.adminApiDenied) failures.push("user is not denied by admin API guard");

  if (!adminChecks.assertions.sessionModeIsOidc) failures.push("admin session mode is not oidc");
  if (!adminChecks.assertions.adminRolePresent) failures.push("admin session role missing");
  if (!adminChecks.assertions.adminPageAccessible) failures.push("admin cannot access /admin/dashboard page with OIDC session");
  if (!adminChecks.assertions.adminApiAccessible) failures.push("admin cannot access admin API with OIDC session");

  if (!mcpChecks.assertions.userDeniedByToolGuard) failures.push("MCP runtime does not deny admin-only tool for OIDC user session");
  if (!mcpChecks.assertions.adminAllowedByToolGuard) failures.push("MCP runtime does not allow admin tool for OIDC admin session");

  if (failures.length > 0) {
    throw new Error(`OIDC E2E verification failed:\n- ${failures.join("\n- ")}`);
  }
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

function decodeSessionCookie(rawCookie) {
  if (!rawCookie) return null;
  try {
    const decoded = decodeURIComponent(rawCookie);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function createCookieJar() {
  const store = new Map();

  return {
    absorb(response) {
      const setCookies = getSetCookieHeaders(response.headers);
      for (const setCookie of setCookies) {
        const pair = setCookie.split(";")[0];
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value.length === 0) {
          store.delete(name);
        } else {
          store.set(name, value);
        }
      }
    },
    get(name) {
      return store.get(name) ?? null;
    },
    header() {
      return [...store.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
  };
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  if (!combined) return [];

  return combined
    .split(/,(?=[^;=]+=)/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchWithBody(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    body
  };
}

async function startMockOidcProvider({ port }) {
  const tokenStore = new Map();
  const issuedCodes = [];
  let authCount = 0;

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && requestUrl.pathname === "/authorize") {
      authCount += 1;
      const persona = personas[Math.min(authCount - 1, personas.length - 1)];
      const state = requestUrl.searchParams.get("state") ?? "";
      const redirectUri = requestUrl.searchParams.get("redirect_uri");

      if (!redirectUri || !state) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }

      const code = `code_${authCount}_${Date.now()}`;
      const accessToken = `token_${code}`;
      tokenStore.set(accessToken, {
        sub: persona.userId,
        name: persona.name,
        role: persona.role,
        tenant_id: persona.tenantId,
        org_id: persona.orgId
      });
      issuedCodes.push({
        code,
        accessToken,
        persona: persona.userId,
        role: persona.role
      });

      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);

      res.writeHead(302, {
        Location: callback.toString()
      });
      res.end();
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/token") {
      const bodyText = await readRequestBody(req);
      const body = new URLSearchParams(bodyText);
      const code = body.get("code") ?? "";
      const accessToken = `token_${code}`;

      if (!tokenStore.has(accessToken)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600
        })
      );
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/userinfo") {
      const auth = req.headers.authorization ?? "";
      const accessToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const claims = tokenStore.get(accessToken) ?? null;

      if (!claims) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(claims));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    getIssuedCodes: () => [...issuedCodes]
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function baseUrl() {
  return `http://127.0.0.1:${activeWebPort}`;
}

function oidcBaseUrl() {
  return `http://127.0.0.1:${activeOidcPort}`;
}

async function resolveAvailablePort(preferredPort) {
  for (let offset = 0; offset < 20; offset += 1) {
    const candidate = preferredPort + offset;
    // Skip ports currently occupied by stale processes before checking bind availability.
    await cleanupWindowsPorts([candidate]);
    const available = await canBindPort(candidate);
    if (available) return candidate;
  }
  throw new Error(`Unable to find an available port near ${preferredPort}.`);
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
