import { NextResponse } from "next/server";

import { requireSignedInApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { messageRepository } from "@/lib/repositories/platform-repositories";

export async function POST(request: Request) {
  try {
    const user = requireTenantScopeApi(requireSignedInApi(request));
    const body = await request.json().catch(() => ({})) as {
      messageId?: string;
      value?: "like" | "dislike" | null;
    };

    if (!body.messageId) {
      return NextResponse.json(
        { code: "BAD_REQUEST", message: "messageId is required." },
        { status: 400 }
      );
    }
    if (body.value !== "like" && body.value !== "dislike" && body.value !== null) {
      return NextResponse.json(
        { code: "BAD_REQUEST", message: "value must be 'like', 'dislike', or null." },
        { status: 400 }
      );
    }

    messageRepository.updateFeedback(body.messageId, body.value);
    return NextResponse.json({ ok: true, userId: user.userId });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
