import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { buildKnowledgeBaseDocumentsReadModel } from "@/lib/read-model/admin-read-model-adapter";

type RouteContext = {
  params: Promise<{
    kbId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const { kbId } = await context.params;
    return NextResponse.json(buildKnowledgeBaseDocumentsReadModel(kbId, { tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
