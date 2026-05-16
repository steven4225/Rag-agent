"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { getChunkReadModel, getDocumentDetailReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default function KnowledgeChunksPage() {
  const params = useParams<{ kbId: string | string[]; docId: string | string[] }>();
  const kbId = routeParam(params.kbId);
  const docId = routeParam(params.docId);

  const loadDetail = useCallback(() => getDocumentDetailReadModel(kbId, docId), [kbId, docId]);
  const loadChunks = useCallback(() => getChunkReadModel(kbId, docId), [kbId, docId]);
  const detailResource = useApiResource(loadDetail);
  const chunkResource = useApiResource(loadChunks);

  const detail = detailResource.data;
  const chunks = chunkResource.data?.items ?? [];
  const status = detailResource.status === "error" ? "error" : chunkResource.status;
  const error = detailResource.error ?? chunkResource.error;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{detail?.document.title ?? docId}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {detail?.document.title ?? docId} / strategy {detail?.strategy ?? "loading"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/admin/knowledge/${encodeURIComponent(kbId)}`}
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Back to documents
          </Link>
          <button
            type="button"
            onClick={() => {
              void detailResource.reload();
              void chunkResource.reload();
            }}
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </div>

      <ReadModelState status={status} error={error} empty={chunks.length === 0}>
        {detail ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Document Status</p>
              <p className="mt-2 text-sm text-slate-700">
                task {detail.document.taskId} / status {detail.document.status} / stage {detail.document.currentStage}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                parser {detail.document.parserStatus} / indexing {detail.document.indexingStatus}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                chunks {detail.document.chunkCount} / index records {detail.document.indexRecordCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">updated {new Date(detail.document.updatedAt).toLocaleString()}</p>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Retrieval Evidence Mapping</p>
              <p className="mt-2 text-sm text-slate-700">
                kb retrieval messages: {detail.retrievalEvidence.retrievalAnnotatedMessageCount}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                doc filter hits: {detail.retrievalEvidence.documentFilterHitCount} / latest trace{" "}
                {detail.retrievalEvidence.latestRetrievedTraceId ?? "-"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                latest retrieved:{" "}
                {detail.retrievalEvidence.latestRetrievedAt
                  ? new Date(detail.retrievalEvidence.latestRetrievedAt).toLocaleString()
                  : "-"}
              </p>
              <p className="mt-1 text-xs text-slate-500">evidence keys: {detail.retrievalEvidence.evidenceChunkKeys.length}</p>
            </article>
          </div>
        ) : null}

        <div className="space-y-3">
          {chunks.map((chunk) => (
            <article key={chunk.chunkId} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <p className="font-mono text-xs text-slate-500">{chunk.chunkId}</p>
                  <p className="text-sm text-slate-800">{chunk.textPreview}</p>
                  <p className="text-xs text-slate-500">
                    idx {chunk.chunkIndex} / chars {chunk.charCount} / section {chunk.sectionPath.join(" > ") || "root"}
                  </p>
                </div>
                <div className="space-y-1 text-xs text-slate-500">
                  <p>
                    offsets {chunk.offsets.startOffset}-{chunk.offsets.endOffset} / page {chunk.offsets.pageNumber ?? "-"}
                  </p>
                  <p>ingestion source: {chunk.source.ingestionSourceType}</p>
                  <p>index source: {chunk.source.indexRecordSource ?? "-"}</p>
                  <p>
                    indexed: {String(chunk.embeddingIndex.indexed)} / embeddingRef {chunk.embeddingIndex.embeddingRef ?? "-"}
                  </p>
                  <p>
                    index {chunk.embeddingIndex.indexName ?? "-"} / store {chunk.embeddingIndex.indexStoreType ?? "-"} / dims{" "}
                    {chunk.embeddingIndex.vectorDimensions ?? "-"}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </ReadModelState>
    </section>
  );
}
