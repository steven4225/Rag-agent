import { NextResponse } from "next/server";

import { exchangeOidcCode, fetchOidcUserInfo, getOidcConfig, mapOidcClaimsToSessionUser } from "@/lib/auth/oidc";
import {
  clearOidcStateCookie,
  getOidcStateCookieValue,
  isOidcEnabled,
  setSessionCookie
} from "@/lib/auth/session";
import { userRepository } from "@/lib/repositories/platform-repositories";

function resolveRedirectUri(request: Request): string {
  // 生产环境优先使用显式配置；未配置时回退到当前请求源，兼容本地/预览环境。
  const configured = process.env.AUTH_OIDC_REDIRECT_URI?.trim();
  if (configured) return configured;
  const origin = new URL(request.url).origin;
  return `${origin}/api/auth/oidc/callback`;
}

function redirectWithError(request: Request, code: string): NextResponse {
  // 统一回调失败出口：重定向到登录页并附带错误码，同时清理一次性 state cookie。
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("error", code);
  const response = NextResponse.redirect(loginUrl);
  clearOidcStateCookie(response);
  return response;
}

export async function GET(request: Request) {
  // 回调入口仅在 OIDC 模式下可用；这里不做 mock 登录回退。
  if (!isOidcEnabled()) {
    return redirectWithError(request, "oidc_disabled");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const storedState = await getOidcStateCookieValue();

  // 关键安全闸门：回调 state 必须与登录跳转时签发的 state 一致（防 CSRF/伪造回调）。
  if (!code || !state || !storedState || state !== storedState) {
    return redirectWithError(request, "invalid_state");
  }

  try {
    const config = getOidcConfig();
    const redirectUri = resolveRedirectUri(request);
    // 第一步：用授权码换取 access token。
    const { accessToken } = await exchangeOidcCode({
      config,
      code,
      redirectUri
    });
    // 第二步：用 access token 到 IdP userinfo 拉取用户 claims。
    const claims = await fetchOidcUserInfo({
      config,
      accessToken
    });
    // 将外部身份 claims 映射为系统内部会话模型（user/role/tenant/org）。
    const user = mapOidcClaimsToSessionUser(claims, config);

    // 落本地用户读模型，确保管理侧与鉴权侧使用同一身份来源。
    userRepository.upsert({
      userId: user.userId,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      orgId: user.orgId
    });

    // 这里只做登录后的体验分流；真正的接口授权仍由各 API 的 require* 守卫执行。
    const destination = user.role === "admin" ? "/admin/dashboard" : "/chat";
    const response = NextResponse.redirect(new URL(destination, request.url));
    // 通过设置 session cookie 完成本系统登录态落地。
    setSessionCookie(response, user);
    // state cookie 是一次性凭据，回调成功后必须清理。
    clearOidcStateCookie(response);
    return response;
  } catch {
    // 不向用户暴露 IdP 内部错误细节，统一返回稳定的回调失败码。
    return redirectWithError(request, "oidc_callback_failed");
  }
}
