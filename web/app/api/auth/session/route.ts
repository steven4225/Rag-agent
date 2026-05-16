import { NextResponse } from "next/server";

import {
  clearSessionCookie,
  getAuthProviderMode,
  getRequestUser,
  isMockFallbackEnabled,
  isOidcEnabled,
  SessionRole,
  SessionUser,
  setSessionCookie
} from "@/lib/auth/session";
import type { UserReadModel } from "@/lib/contracts";
import { userRepository } from "@/lib/repositories/platform-repositories";

const DEFAULT_MOCK_TENANT_ID = process.env.AUTH_MOCK_DEFAULT_TENANT_ID?.trim() || "tenant_demo";
const DEFAULT_MOCK_ORG_ID = process.env.AUTH_MOCK_DEFAULT_ORG_ID?.trim() || "org_demo";

function toRole(value: unknown): SessionRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "admin" || normalized === "user" ? normalized : null;
}

function buildMockUser(payload: Partial<SessionUser> & { role: SessionRole }): SessionUser {
  const fallbackId = payload.role === "admin" ? "admin_demo" : "user_demo";
  return {
    id: payload.userId?.trim() || fallbackId,
    userId: payload.userId?.trim() || fallbackId,
    role: payload.role,
    name: payload.name?.trim() || (payload.role === "admin" ? "Demo Admin" : "Demo User"),
    orgId: payload.orgId?.trim() || DEFAULT_MOCK_ORG_ID,
    tenantId: payload.tenantId?.trim() || DEFAULT_MOCK_TENANT_ID
  };
}

function toSessionUser(user: UserReadModel): SessionUser {
  return {
    id: user.userId,
    userId: user.userId,
    role: user.role,
    name: user.name,
    tenantId: user.tenantId,
    orgId: user.orgId
  };
}

function listMockUsers() {
  return userRepository.listReadModel().map(toSessionUser);
}

function resolveStoredUser(role: SessionRole, userId: string | undefined) {
  const normalizedUserId = userId?.trim() || "";
  if (normalizedUserId) {
    const byId = userRepository.getByUserId(normalizedUserId);
    if (byId && byId.role === role) return byId;
  }

  return userRepository.listByRole(role)[0] ?? null;
}

export async function GET(request: Request) {
  const mode = getAuthProviderMode();
  const mockFallbackEnabled = isMockFallbackEnabled();
  const oidcEnabled = isOidcEnabled();
  return NextResponse.json({
    ok: true,
    mode,
    oidcEnabled,
    mockFallbackEnabled,
    oidcLoginPath: oidcEnabled ? "/api/auth/oidc/login" : null,
    user: getRequestUser(request),
    users: mockFallbackEnabled ? listMockUsers() : []
  });
}

export async function POST(request: Request) {
  if (!isMockFallbackEnabled()) {
    return NextResponse.json(
      {
        code: "MOCK_AUTH_DISABLED",
        message: "Mock session creation is disabled. Use OIDC login endpoint instead."
      },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Partial<SessionUser> & { role?: string };
  const role = toRole(body.role);

  if (!role) {
    return NextResponse.json(
      {
        code: "BAD_REQUEST",
        message: "`role` must be 'user' or 'admin'."
      },
      { status: 400 }
    );
  }

  const storedUser = resolveStoredUser(role, body.userId);
  const user =
    storedUser !== null
      ? toSessionUser(storedUser)
      : buildMockUser({
          role,
          userId: body.userId,
          name: body.name,
          orgId: body.orgId,
          tenantId: body.tenantId
        });

  userRepository.upsert({
    userId: user.userId,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    orgId: user.orgId
  });

  const response = NextResponse.json({
    ok: true,
    user,
    mode: getAuthProviderMode()
  });

  setSessionCookie(response, user);

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
