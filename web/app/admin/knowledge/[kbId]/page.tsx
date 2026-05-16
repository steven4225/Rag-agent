"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { getKnowledgeBaseDocumentsReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function KnowledgeDocumentsPage() {
  const params = useParams<{ kbId: string | string[] }>();
  const kbId = routeParam(params.kbId);
  const loadDocuments = useCallback(() => getKnowledgeBaseDocumentsReadModel(kbId), [kbId]);
  const { data, status, error, reload } = useApiResource(loadDocuments);
  const items = data?.items ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{data?.knowledgeBaseName ?? kbId}</h2>
          <p className="mt-1 text-xs text-slate-500">Documents in {data?.knowledgeBaseName ?? kbId} / strategy: {data?.strategy ?? "loading"}</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <ReadModelState status={status} error={error} empty={items.length === 0}>
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.documentId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-slate-500">{item.documentId}</p>
                  <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-xs text-slate-500">
                    {item.filename} / {item.mimeType} / source {item.sourceType}
                  </p>
                  <p className="text-xs text-slate-500">
                    status {item.status} / stage {item.currentStage} / parser {item.parserStatus} / indexing {item.indexingStatus}
                  </p>
                </div>
                <div className="space-y-1 text-xs text-slate-500">
                  <p>chunks: {item.chunkCount}</p>
                  <p>index records: {item.indexRecordCount}</p>
                  <p>retrieval hits: {item.retrievalEvidenceCount}</p>
                  <p>updated: {new Date(item.updatedAt).toLocaleString()}</p>
                  <Link
                    href={`/admin/knowledge/${encodeURIComponent(kbId)}/docs/${encodeURIComponent(item.documentId)}`}
                    className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    View chunks
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      </ReadModelState>
    </section>
  );
}
