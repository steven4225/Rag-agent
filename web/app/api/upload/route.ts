import { NextResponse } from "next/server";

import { requireAdminApi, requireOrgScopeApi, requireTenantScopeApi, toAuthErrorResponse } from "@/lib/auth/session";
import { createIngestionTask } from "@/lib/ingestion/orchestrator";
import { createTraceId } from "@/lib/trace/trace";

export async function POST(request: Request) {
  try {
    const user = requireOrgScopeApi(requireTenantScopeApi(requireAdminApi(request)));
    const traceId = createTraceId("ingest");
    const timestamp = Date.now();
    const content = `Sample plain text document ${timestamp}.

This upload route now sends a real data URI source to the Go parser.

The chunker should emit real chunk offsets from parsed document text.`;
    const task = await createIngestionTask({
      traceId,
      knowledgeBaseId: "kb_demo",
      documentId: `doc_${timestamp}`,
      requestedBy: user.userId,
      tenantId: user.tenantId,
      orgId: user.orgId,
      source: {
        sourceType: "upload",
        uri: `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`,
        filename: "placeholder.txt",
        mimeType: "text/plain",
        sizeBytes: content.length,
        checksum: null
      },
      executionPlan: {
        parser: {
          parserType: "text-parser",
          mode: "adapter"
        },
        chunking: {
          strategy: "paragraph",
          targetSize: 1200,
          overlap: 120
        },
        embedding: {
          enabled: true,
          model: "mock-embedding-v1",
          adapter: "deterministic"
        },
        indexing: {
          enabled: true,
          indexName: "kb_demo",
          storeType: "json-file"
        }
      },
      metadata: {
        initiatedFrom: "upload-route",
        boundaryPhase: "embedding-indexing-boundary-phase1",
        tenantId: user.tenantId,
        orgId: user.orgId,
        requestedRole: user.role
      }
    });

    return NextResponse.json({
      phase: "shell",
      task
    });
  } catch (error) {
    return toAuthErrorResponse(error) ?? NextResponse.json({ code: "INTERNAL_ERROR", message: "Unknown error." }, { status: 500 });
  }
}
