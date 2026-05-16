import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { settingUpsertSchema } from "@/lib/contracts";
import { buildSettingReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { settingRepository } from "@/lib/repositories/platform-repositories";

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
    return NextResponse.json(buildSettingReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}

export async function POST(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await parseJsonBody(request);
    if (!body) return toValidationErrorResponse("Request body must be valid JSON.");

    const parsed = settingUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid setting payload.");
    }

    const alreadyExists = settingRepository
      .listReadModel({ tenantId: admin.tenantId, orgId: admin.orgId })
      .some((item) => item.key === parsed.data.key);
    if (alreadyExists) {
      return NextResponse.json(
        {
          code: "CONFLICT",
          message: `Setting key '${parsed.data.key}' already exists. Use PUT to update.`
        },
        { status: 409 }
      );
    }

    const next = settingRepository.upsert(
      {
        ...parsed.data,
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

    const parsed = settingUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid setting payload.");
    }

    const next = settingRepository.upsert(
      {
        ...parsed.data,
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
