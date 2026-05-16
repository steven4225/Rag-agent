import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { userRepository } from "@/lib/repositories/platform-repositories";

export const SESSION_COOKIE_NAME = "ragent_session";

export type SessionRole = "user" | "admin";

export type SessionUser = {
  id: string;
  userId: string;
  role: SessionRole;
  name: string;
  orgId?: string | null;
  tenantId?: string | null;
};

export type TenantScopedSessionUser = SessionUser & {
  tenantId: string;
};

export type OrgScopedSessionUser = TenantScopedSessionUser & {
  orgId: string;
};

type SessionPayload = {
  userId: string;
  role: SessionRole;
  name: string;
  orgId?: string | null;
  tenantId?: string | null;
};

type AuthProviderMode = "oidc" | "mock";

class AuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_MOCK_TENANT_ID = "tenant_demo";
const DEFAULT_MOCK_ORG_ID = "org_demo";
const OIDC_STATE_COOKIE_NAME = "ragent_oidc_state";

function getSessionSecret(): string {
  const secret = process.env.AUTH_SESSION_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SESSION_SECRET is required in production");
    }
    return "ragent-dev-secret-do-not-use-in-production";
  }
  return secret;
}

function signPayload(payload: string): string {
  const hmac = createHmac("sha256", getSessionSecret());
  hmac.update(payload);
  return hmac.digest("base64url");
}

function verifyPayload(payload: string, signature: string): boolean {
  const expected = signPayload(payload);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function isTrue(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function normalizeMode(value: string | null | undefined): AuthProviderMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "mock") return "mock";
  return "oidc";
}

export function getAuthProviderMode(): AuthProviderMode {
  // 认证模式总开关：oidc 为生产主路径，mock 为本地/测试回退路径。
  return normalizeMode(process.env.AUTH_PROVIDER_MODE);
}

export function isOidcEnabled(): boolean {
  // 是否启用 OIDC 认证链路。
  return getAuthProviderMode() === "oidc";
}

export function isMockFallbackEnabled(): boolean {
  // mock 回退用于本地联调/试运行；生产默认不建议依赖。
  const explicit = process.env.AUTH_MOCK_FALLBACK_ENABLED;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return isTrue(explicit);
  }
  if (getAuthProviderMode() === "mock") return true;
  return process.env.NODE_ENV !== "production";
}

export function isHeaderAuthEnabled(): boolean {
  // 头部注入身份常用于自动化测试或网关前置鉴权场景。
  const explicit = process.env.AUTH_HEADER_AUTH_ENABLED;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return isTrue(explicit);
  }
  return process.env.NODE_ENV !== "production";
}

function toSessionRole(value: string | null | undefined): SessionRole | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return normalized === "admin" || normalized === "user" ? normalized : null;
}

function toSessionUser(payload: SessionPayload): SessionUser {
  return {
    id: payload.userId,
    userId: payload.userId,
    role: payload.role,
    name: payload.name,
    orgId: payload.orgId ?? null,
    tenantId: payload.tenantId ?? null
  };
}

function fromUserReadModel(input: {
  userId: string;
  role: SessionRole;
  name: string;
  tenantId: string | null;
  orgId: string | null;
}): SessionUser {
  return {
    id: input.userId,
    userId: input.userId,
    role: input.role,
    name: input.name,
    tenantId: input.tenantId,
    orgId: input.orgId
  };
}

function decodeCookiePayload(rawCookie: string | undefined): SessionUser | null {
  if (!rawCookie) return null;

  // 兼容历史编码差异：尝试原值、一次 decode、二次 decode。
  const candidates = [rawCookie, tryDecode(rawCookie), tryDecode(tryDecode(rawCookie))].filter((item): item is string => typeof item === "string");

  for (const candidate of candidates) {
    // 新格式：{payload}.{signature}
    const dot = candidate.lastIndexOf(".");
    if (dot > 0) {
      const payload = candidate.slice(0, dot);
      const signature = candidate.slice(dot + 1);
      if (verifyPayload(payload, signature)) {
        const parsed = tryParseSessionPayload(payload);
        if (parsed) return parsed;
      }
    }
    // 兼容未签名的旧格式（dev 环境可能残留）
    const parsed = tryParseSessionPayload(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function tryDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tryParseSessionPayload(value: string): SessionUser | null {
  try {
    const parsed = JSON.parse(value) as Partial<SessionPayload>;
    const role = toSessionRole(parsed.role);
    const userId = parsed.userId?.trim();
    const name = parsed.name?.trim();
    if (!role || !userId || !name) return null;
    return toSessionUser({
      userId,
      role,
      name,
      orgId: parsed.orgId?.trim() || null,
      tenantId: parsed.tenantId?.trim() || null
    });
  } catch {
    return null;
  }
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const entries = header.split(";").map((part) => part.trim());
  const parsed: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    parsed[key] = value;
  }
  return parsed;
}

function readHeaderSession(request: Request): SessionUser | null {
  // 从请求头构造会话（仅在开启 header auth 时生效）。
  const role = toSessionRole(request.headers.get("x-ragent-role"));
  const userId = request.headers.get("x-ragent-user-id")?.trim();
  const name = request.headers.get("x-ragent-user-name")?.trim();
  if (!role || !userId || !name) return null;
  return toSessionUser({
    userId,
    role,
    name,
    orgId: request.headers.get("x-ragent-org-id")?.trim() || null,
    tenantId: request.headers.get("x-ragent-tenant-id")?.trim() || null
  });
}

function readDefaultMockSession(): SessionUser | null {
  // 无显式会话时的兜底：仅在 mock 回退开启时返回演示用户。
  if (!isMockFallbackEnabled()) return null;
  const role = toSessionRole(process.env.AUTH_MOCK_DEFAULT_ROLE);
  if (!role) return null;
  const defaultUserId = process.env.AUTH_MOCK_DEFAULT_USER_ID?.trim() || (role === "admin" ? "admin_demo" : "user_demo");
  const userFromRepo = userRepository.getByUserId(defaultUserId);
  if (userFromRepo?.role === role) {
    return fromUserReadModel(userFromRepo);
  }

  const fallbackByRole = userRepository.listByRole(role)[0] ?? null;
  if (fallbackByRole) {
    return fromUserReadModel(fallbackByRole);
  }

  return toSessionUser({
    userId: defaultUserId,
    role,
    name: process.env.AUTH_MOCK_DEFAULT_USER_NAME?.trim() || (role === "admin" ? "Demo Admin" : "Demo User"),
    orgId: process.env.AUTH_MOCK_DEFAULT_ORG_ID?.trim() || DEFAULT_MOCK_ORG_ID,
    tenantId: process.env.AUTH_MOCK_DEFAULT_TENANT_ID?.trim() || DEFAULT_MOCK_TENANT_ID
  });
}

export function encodeSessionCookie(user: SessionUser): string {
  const payload = JSON.stringify({
    userId: user.userId,
    role: user.role,
    name: user.name,
    orgId: user.orgId ?? null,
    tenantId: user.tenantId ?? null
  } satisfies SessionPayload);
  return `${payload}.${signPayload(payload)}`;
}

export function setSessionCookie(response: NextResponse, user: SessionUser) {
  // 登录态落地：HttpOnly 防脚本读取，sameSite=lax 降低 CSRF 风险。
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: encodeSessionCookie(user),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8
  });
}

export function clearSessionCookie(response: NextResponse) {
  // 主动退出登录时清理会话 cookie。
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export function setOidcStateCookie(response: NextResponse, state: string) {
  response.cookies.set({
    name: OIDC_STATE_COOKIE_NAME,
    value: `${state}.${signPayload(state)}`,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10
  });
}

export function clearOidcStateCookie(response: NextResponse) {
  response.cookies.set({
    name: OIDC_STATE_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}

export async function getOidcStateCookieValue(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(OIDC_STATE_COOKIE_NAME)?.value?.trim();
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const state = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  return verifyPayload(state, signature) ? state : null;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  // 页面/Server Action 场景：优先读 cookie，会话缺失时按配置决定是否 mock 兜底。
  const cookieStore = await cookies();
  const cookieUser = decodeCookiePayload(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (cookieUser) return cookieUser;
  return readDefaultMockSession();
}

export function getRequestUser(request: Request): SessionUser | null {
  // API 场景统一入口：先尝试 header 身份，再尝试 cookie，最后按配置决定 mock 兜底。
  if (isHeaderAuthEnabled()) {
    const headerUser = readHeaderSession(request);
    if (headerUser) return headerUser;
  }

  const parsedCookies = parseCookieHeader(request.headers.get("cookie"));
  const cookieUser = decodeCookiePayload(parsedCookies[SESSION_COOKIE_NAME]);
  if (cookieUser) return cookieUser;

  return readDefaultMockSession();
}

export async function requireSignedIn(): Promise<SessionUser> {
  // 页面级守卫：未登录直接重定向到 /login。
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  // 页面级管理员守卫：非 admin 重定向到 /chat。
  const user = await requireSignedIn();
  if (user.role !== "admin") redirect("/chat");
  return user;
}

export function requireTenantScope(user: SessionUser): TenantScopedSessionUser {
  // 页面级租户作用域守卫：多租户场景必须具备 tenantId。
  const tenantId = user.tenantId?.trim();
  if (!tenantId) redirect("/login");
  return {
    ...user,
    tenantId
  };
}

export function requireOrgScope(user: TenantScopedSessionUser): OrgScopedSessionUser {
  // 页面级组织作用域守卫：需要组织边界时必须具备 orgId。
  const orgId = user.orgId?.trim();
  if (!orgId) redirect("/login");
  return {
    ...user,
    orgId
  };
}

export function requireSignedInApi(request: Request): SessionUser {
  // API 级认证守卫：只负责“你是谁”（401）。
  const user = getRequestUser(request);
  if (!user) {
    throw new AuthError(401, "UNAUTHORIZED", "Sign-in required.");
  }
  return user;
}

export function requireAdminApi(request: Request): SessionUser {
  // API 级授权守卫：验证是否具备 admin 角色（403）。
  const user = requireSignedInApi(request);
  if (user.role !== "admin") {
    throw new AuthError(403, "FORBIDDEN", "Admin role required.");
  }
  return user;
}

export function requireTenantScopeApi(user: SessionUser): TenantScopedSessionUser {
  // API 级租户边界守卫：未携带 tenantId 一律拒绝（403）。
  const tenantId = user.tenantId?.trim();
  if (!tenantId) {
    throw new AuthError(403, "TENANT_SCOPE_REQUIRED", "Tenant scope required.");
  }
  return {
    ...user,
    tenantId
  };
}

export function requireOrgScopeApi(user: TenantScopedSessionUser): OrgScopedSessionUser {
  // API 级组织边界守卫：需要 org 细分时继续收窄作用域（403）。
  const orgId = user.orgId?.trim();
  if (!orgId) {
    throw new AuthError(403, "ORG_SCOPE_REQUIRED", "Org scope required.");
  }
  return {
    ...user,
    orgId
  };
}

export function toAuthErrorResponse(error: unknown) {
  // 统一把鉴权异常映射为稳定 JSON 错误结构，便于前端与脚本处理。
  if (error instanceof AuthError) {
    return NextResponse.json(
      {
        code: error.code,
        message: error.message
      },
      {
        status: error.status
      }
    );
  }
  return null;
}
