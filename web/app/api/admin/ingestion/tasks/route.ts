import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { GoIngestionClientError } from "@/lib/clients/go-ingestion";
import { ingestionTaskCreateRequestSchema } from "@/lib/contracts";
import { createIngestionTask } from "@/lib/ingestion/orchestrator";
import { buildIngestionReadModel } from "@/lib/read-model/admin-read-model-adapter";

export async function GET(request: Request) {
  try {
    const admin = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    return NextResponse.json(buildIngestionReadModel({ tenantId: admin.tenantId, orgId: admin.orgId }));
  } catch (error) {
    const authError = toAuthErrorResponse(error);
    if (authError) {
      return authError;
    }
    if (error instanceof Error) {
      console.error("[/api/admin/ingestion/tasks][GET]", error.message, error.stack);
      return NextResponse.json({ code: "INGESTION_READ_MODEL_FAILED", message: error.message }, { status: 500 });
    }
    const unknownType = Object.prototype.toString.call(error);
    console.error("[/api/admin/ingestion/tasks][GET] unknown error", unknownType, error);
    return NextResponse.json(
      { code: "INGESTION_READ_MODEL_UNKNOWN_ERROR", message: "Unknown error.", errorType: unknownType },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const payload = ingestionTaskCreateRequestSchema.parse(await request.json());
    const task = await createIngestionTask({
      ...payload,
      requestedBy: payload.requestedBy?.trim() || user.userId,
      tenantId: user.tenantId,
      orgId: user.orgId,
      metadata: {
        ...payload.metadata,
        tenantId: user.tenantId,
        orgId: user.orgId,
        requestedRole: user.role
      }
    });
    return NextResponse.json(task);
  } catch (error) {
    const authError = toAuthErrorResponse(error);
    if (authError) {
      return authError;
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          code: "INVALID_INGESTION_REQUEST",
          message: "Ingestion task request payload is invalid.",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        },
        { status: 400 }
      );
    }

    if (error instanceof GoIngestionClientError) {
      return NextResponse.json(
        {
          code: error.code,
          message: error.message,
          traceId: error.traceId
        },
        { status: error.status }
      );
    }

    if (error instanceof Error) {
      console.error("[/api/admin/ingestion/tasks][POST]", error.message, error.stack);
      return NextResponse.json({ code: "INGESTION_TASK_CREATE_FAILED", message: error.message }, { status: 500 });
    }

    const unknownType = Object.prototype.toString.call(error);
    const unknownMessage =
      typeof error === "string"
        ? error
        : typeof error === "number" || typeof error === "boolean"
          ? String(error)
          : "Unknown error.";
    console.error("[/api/admin/ingestion/tasks][POST] unknown error", unknownType, error);
    return NextResponse.json(
      { code: "INGESTION_TASK_CREATE_UNKNOWN_ERROR", message: unknownMessage, errorType: unknownType },
      { status: 500 }
    );
  }
}
