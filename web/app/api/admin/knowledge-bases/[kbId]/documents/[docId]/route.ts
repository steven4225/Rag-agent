import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { buildDocumentDetailReadModel } from "@/lib/read-model/admin-read-model-adapter";

type RouteContext = {
  params: Promise<{
    kbId: string;
    docId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const { kbId, docId } = await context.params;
    const readModel = buildDocumentDetailReadModel(kbId, docId, { tenantId: admin.tenantId, orgId: admin.orgId });
    if (!readModel) {
      return NextResponse.json(
        {
          code: "DOCUMENT_NOT_FOUND",
          message: "Document not found in this knowledge base."
        },
        { status: 404 }
      );
    }
    return NextResponse.json(readModel);
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
