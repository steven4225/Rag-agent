import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { mappingUpsertSchema } from "@/lib/contracts";
import { buildMappingReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { mappingRepository } from "@/lib/repositories/platform-repositories";

function toInternalErrorResponse() {
  return NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
}

function toValidationErrorResponse(message: string) {
  return NextResponse.json({ code: "VALIDATION_ERROR", message }, { status: 400 });
}

async function parseJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json(buildMappingReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}

export async function POST(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await parseJsonBody(request);
    if (!body) return toValidationErrorResponse("Request body must be valid JSON.");

    const parsed = mappingUpsertSchema.omit({ mappingId: true }).safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid mapping payload.");
    }

    const next = mappingRepository.upsert(
      {
        mappingId: `map_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sourceTerm: parsed.data.sourceTerm,
        targetTerm: parsed.data.targetTerm,
        enabled: parsed.data.enabled,
        tenantId: admin.tenantId,
        orgId: admin.orgId
      },
      { tenantId: admin.tenantId, orgId: admin.orgId }
    );

    return NextResponse.json(next, { status: 201 });
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}

export async function PUT(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await parseJsonBody(request);
    if (!body) return toValidationErrorResponse("Request body must be valid JSON.");

    const parsed = mappingUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid mapping payload.");
    }

    if (!parsed.data.mappingId) {
      return toValidationErrorResponse("mappingId is required for update.");
    }

    const next = mappingRepository.upsert(
      {
        mappingId: parsed.data.mappingId,
        sourceTerm: parsed.data.sourceTerm,
        targetTerm: parsed.data.targetTerm,
        enabled: parsed.data.enabled,
        tenantId: admin.tenantId,
        orgId: admin.orgId
      },
      { tenantId: admin.tenantId, orgId: admin.orgId }
    );

    return NextResponse.json(next);
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}
