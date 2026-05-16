import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { sampleQuestionUpsertSchema } from "@/lib/contracts";
import { buildSampleQuestionReadModel } from "@/lib/read-model/admin-read-model-adapter";
import { sampleQuestionRepository } from "@/lib/repositories/platform-repositories";

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

function normalizeKnowledgeBaseId(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json(buildSampleQuestionReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    return toAuthErrorResponse(error) ?? toInternalErrorResponse();
  }
}

export async function POST(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const body = await parseJsonBody(request);
    if (!body) return toValidationErrorResponse("Request body must be valid JSON.");

    const parsed = sampleQuestionUpsertSchema.omit({ questionId: true }).safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid sample question payload.");
    }

    const next = sampleQuestionRepository.upsert(
      {
        questionId: `sample_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        question: parsed.data.question,
        knowledgeBaseId: normalizeKnowledgeBaseId(parsed.data.knowledgeBaseId),
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

    const parsed = sampleQuestionUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return toValidationErrorResponse(parsed.error.issues[0]?.message ?? "Invalid sample question payload.");
    }

    if (!parsed.data.questionId) {
      return toValidationErrorResponse("questionId is required for update.");
    }

    const next = sampleQuestionRepository.upsert(
      {
        questionId: parsed.data.questionId,
        question: parsed.data.question,
        knowledgeBaseId: normalizeKnowledgeBaseId(parsed.data.knowledgeBaseId),
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
