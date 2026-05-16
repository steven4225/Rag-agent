import { NextResponse } from "next/server";

import { buildOidcAuthorizationUrl, generateOidcState, getOidcConfig } from "@/lib/auth/oidc";
import { isOidcEnabled, setOidcStateCookie } from "@/lib/auth/session";

function resolveRedirectUri(request: Request): string {
  const configured = process.env.AUTH_OIDC_REDIRECT_URI?.trim();
  if (configured) return configured;
  const origin = new URL(request.url).origin;
  return `${origin}/api/auth/oidc/callback`;
}

export async function GET(request: Request) {
  if (!isOidcEnabled()) {
    return NextResponse.json(
      {
        code: "OIDC_DISABLED",
        message: "OIDC auth provider is disabled."
      },
      { status: 404 }
    );
  }

  const config = getOidcConfig();
  const redirectUri = resolveRedirectUri(request);
  const state = generateOidcState();
  const redirectUrl = buildOidcAuthorizationUrl({
    config,
    state,
    redirectUri
  });

  const response = NextResponse.redirect(redirectUrl);
  setOidcStateCookie(response, state);
  return response;
}
