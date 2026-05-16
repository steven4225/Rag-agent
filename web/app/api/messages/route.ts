import { NextRequest, NextResponse } from "next/server";

import { requireSignedInApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { buildMessageReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { conversationRepository, messageRepository } from "@/lib/repositories/platform-repositories";

export async function GET(request: NextRequest) {
  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const conversationId = request.nextUrl.searchParams.get("conversationId");
    if (!conversationId) {
      return NextResponse.json(
        {
          code: "BAD_REQUEST",
          message: "`conversationId` is required."
        },
        { status: 400 }
      );
    }

    if (!conversationRepository.getByIdForUser(conversationId, user.userId, { tenantId: user.tenantId, orgId: user.orgId ?? null })) {
      return NextResponse.json(
        {
          code: "NOT_FOUND",
          message: "Conversation does not exist."
        },
        { status: 404 }
      );
    }

    return NextResponse.json(buildMessageReadModel(conversationId));
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const body = (await request.json().catch(() => ({}))) as {
      conversationId?: string;
      content?: string;
      role?: "user" | "assistant";
    };

    if (!body.conversationId || !body.content || !body.role) {
      return NextResponse.json(
        {
          code: "BAD_REQUEST",
          message: "`conversationId`, `content`, and `role` are required."
        },
        { status: 400 }
      );
    }

    if (!conversationRepository.getByIdForUser(body.conversationId, user.userId, { tenantId: user.tenantId, orgId: user.orgId ?? null })) {
      return NextResponse.json(
        {
          code: "NOT_FOUND",
          message: "Conversation does not exist."
        },
        { status: 404 }
      );
    }

    const item = messageRepository.append({
      conversationId: body.conversationId,
      role: body.role,
      content: body.content,
      metadata: {
        tenantId: user.tenantId,
        orgId: user.orgId ?? null,
        userId: user.userId
      }
    });

    return NextResponse.json(item);
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
