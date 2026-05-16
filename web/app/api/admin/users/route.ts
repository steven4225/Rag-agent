import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { userUpsertSchema } from "@/lib/contracts";
import { buildUserReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { userRepository } from "@/lib/repositories/platform-repositories";

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

function normalizeScopeField(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json(buildUserReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}

export async function POST(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await parseJsonBody(request);
    if (!body) return toValidationErrorResponse("Request body must be valid JSON.");

    const parsed = userUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid user payload.");
    }

    const alreadyExists = userRepository.getByUserId(parsed.data.userId);
    if (alreadyExists) {
      return NextResponse.json(
        {
          code: "CONFLICT",
          message: `User '${parsed.data.userId}' already exists. Use PUT to update.`
        },
        { status: 409 }
      );
    }

    const next = userRepository.upsert({
      userId: parsed.data.userId,
      name: parsed.data.name,
      role: parsed.data.role,
      tenantId: normalizeScopeField(parsed.data.tenantId) ?? admin.tenantId,
      orgId: normalizeScopeField(parsed.data.orgId) ?? admin.orgId
    });
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

    const parsed = userUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid user payload.");
    }

    const next = userRepository.upsert({
      userId: parsed.data.userId,
      name: parsed.data.name,
      role: parsed.data.role,
      tenantId: normalizeScopeField(parsed.data.tenantId) ?? admin.tenantId,
      orgId: normalizeScopeField(parsed.data.orgId) ?? admin.orgId
    });
    return NextResponse.json(next);
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}
