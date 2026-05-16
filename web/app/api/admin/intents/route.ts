import { NextRequest, NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { intentRepository } from "@/lib/repositories/platform-repositories";

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json({
      items: intentRepository.listReadModel({ tenantId: admin.tenantId, orgId: admin.orgId })
    });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "name is required" }, { status: 400 });
    }
    const created = intentRepository.create({
      name,
      description: typeof body?.description === "string" ? body.description : undefined,
      parentIntentId: typeof body?.parentIntentId === "string" ? body.parentIntentId : null,
      routeExpression: typeof body?.routeExpression === "string" ? body.routeExpression : undefined,
      knowledgeBaseIds: Array.isArray(body?.knowledgeBaseIds) ? body.knowledgeBaseIds : undefined,
      enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      priority: typeof body?.priority === "number" ? body.priority : undefined,
      tenantId: admin.tenantId,
      orgId: admin.orgId
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await request.json().catch(() => null);
    const intentId = typeof body?.intentId === "string" ? body.intentId.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!intentId || !name) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "intentId and name are required" }, { status: 400 });
    }
    intentRepository.update(intentId, {
      name,
      description: typeof body?.description === "string" ? body.description : undefined,
      parentIntentId: body?.parentIntentId !== undefined ? (typeof body.parentIntentId === "string" ? body.parentIntentId : null) : undefined,
      routeExpression: typeof body?.routeExpression === "string" ? body.routeExpression : undefined,
      knowledgeBaseIds: Array.isArray(body?.knowledgeBaseIds) ? body.knowledgeBaseIds : undefined,
      enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      priority: typeof body?.priority === "number" ? body.priority : undefined
    }, { tenantId: admin.tenantId, orgId: admin.orgId });
    return NextResponse.json({ intentId, name });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const intentId = request.nextUrl.searchParams.get("intentId")?.trim() ?? "";
    if (!intentId) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "intentId query param is required" }, { status: 400 });
    }
    intentRepository.delete(intentId, { tenantId: admin.tenantId, orgId: admin.orgId });
    return NextResponse.json({ intentId });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
