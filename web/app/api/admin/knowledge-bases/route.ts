import { NextRequest, NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { knowledgeRepository } from "@/lib/repositories/platform-repositories";
import { buildKnowledgeReadModel } from "@/lib/read-model/admin-read-model-adapter";

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json(buildKnowledgeReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
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
    const created = knowledgeRepository.create({
      name,
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
    const knowledgeBaseId = typeof body?.knowledgeBaseId === "string" ? body.knowledgeBaseId.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!knowledgeBaseId || !name) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "knowledgeBaseId and name are required" }, { status: 400 });
    }
    knowledgeRepository.rename(knowledgeBaseId, name, { tenantId: admin.tenantId, orgId: admin.orgId });
    return NextResponse.json({ knowledgeBaseId, name });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const knowledgeBaseId = request.nextUrl.searchParams.get("knowledgeBaseId")?.trim() ?? "";
    if (!knowledgeBaseId) {
      return NextResponse.json({ code: "BAD_REQUEST", message: "knowledgeBaseId query param is required" }, { status: 400 });
    }
    knowledgeRepository.delete(knowledgeBaseId, { tenantId: admin.tenantId, orgId: admin.orgId });
    return NextResponse.json({ knowledgeBaseId });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
