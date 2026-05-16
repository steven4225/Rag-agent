import { NextResponse } from "next/server";

import { requireSignedInApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { buildConversationReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { conversationRepository } from "@/lib/repositories/platform-repositories";

export async function GET(request: Request) {
  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    return NextResponse.json(buildConversationReadModel(user.userId, { tenantId: user.tenantId, orgId: user.orgId ?? null }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const item = conversationRepository.create({
      title: body.title,
      userId: user.userId,
      tenantId: user.tenantId,
      orgId: user.orgId ?? null
    });

    return NextResponse.json(item);
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
