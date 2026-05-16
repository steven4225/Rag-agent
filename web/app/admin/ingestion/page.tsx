"use client";

import { useMemo, useState } from "react";
import { Activity, ArchiveRestore, ChevronLeft, ChevronRight, FileText, FileWarning } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createIngestionTask, getIngestionReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import { createTraceId } from "@/lib/trace/trace";
import type { IngestionTaskStatus } from "@/lib/contracts";

const PAGE_SIZE = 8;

const STATUS_FILTERS = [
  { label: "All", value: "__all__" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Running", value: "running" },
  { label: "Pending", value: "pending" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" }
];

function statusBadge(status: string) {
  const base = "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]";
  switch (status) {
    case "succeeded": return `${base} bg-emerald-50 text-emerald-700`;
    case "failed": return `${base} bg-red-50 text-red-700`;
    case "running": return `${base} bg-blue-50 text-blue-700`;
    case "pending": return `${base} bg-slate-100 text-slate-600`;
    case "cancelled": return `${base} bg-amber-50 text-amber-700`;
    default: return `${base} bg-slate-100 text-slate-600`;
  }
}

export default function IngestionPage() {
  const { data, status, error, reload } = useApiResource(getIngestionReadModel);
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [page, setPage] = useState(0);

  const allItems = data?.items ?? [];

  const items = useMemo(
    () => statusFilter === "__all__" ? allItems : allItems.filter((t) => t.status === statusFilter),
    [allItems, statusFilter]
  );

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const stats = useMemo(() => ({
    total: allItems.length,
    succeeded: allItems.filter((t) => t.status === "succeeded").length,
    failed: allItems.filter((t) => t.status === "failed").length,
    running: allItems.filter((t) => t.status === "running").length
  }), [allItems]);

  async function handleCreateSampleTask() {
    setCreating(true);
    try {
      const timestamp = Date.now();
      const content = `# Sample Policy ${timestamp}

This markdown document is sent as a real data URI source for the Go parser minimal loop.

## Operations

The chunker should split this content into real parsed chunks with offsets and section paths.`;
      await createIngestionTask({
        traceId: createTraceId("ingest"),
        knowledgeBaseId: "kb_policy",
        documentId: `doc_${timestamp}`,
        requestedBy: "admin_demo",
        tenantId: null,
        orgId: null,
        source: {
          sourceType: "upload",
          uri: `data:text/markdown;base64,${btoa(content)}`,
          filename: `sample-${timestamp}.md`,
          mimeType: "text/markdown",
          sizeBytes: content.length,
          checksum: null
        },
        executionPlan: {
          parser: { parserType: "text-parser", mode: "adapter" },
          chunking: { strategy: "paragraph", targetSize: 1200, overlap: 120 },
          embedding: { enabled: true, model: "mock-embedding-v1", adapter: "deterministic" },
          indexing: { enabled: true, indexName: "kb_policy", storeType: "json-file" }
        },
        metadata: { initiatedFrom: "admin-ingestion-page", boundaryPhase: "embedding-indexing-boundary-phase1" }
      });
      await reload();
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Ingestion</h2>
          <p className="mt-1 text-sm text-slate-500">
            TS control plane creates tasks; Go execution plane runs parser, chunker, embedding, and indexing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleCreateSampleTask()}
            disabled={creating}
            className="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {creating ? "Creating..." : "Create Sample Task"}
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total Tasks", value: stats.total, icon: FileText, tone: "bg-slate-50 border-slate-200", textTone: "text-slate-900" },
          { label: "Succeeded", value: stats.succeeded, icon: Activity, tone: "bg-emerald-50 border-emerald-200", textTone: "text-emerald-800" },
          { label: "Running", value: stats.running, icon: ArchiveRestore, tone: "bg-blue-50 border-blue-200", textTone: "text-blue-800" },
          { label: "Failed", value: stats.failed, icon: FileWarning, tone: "bg-red-50 border-red-200", textTone: "text-red-800" }
        ].map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.label} className={["rounded-2xl border p-4", card.tone].join(" ")}>
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{card.label}</p>
                <Icon className="h-4 w-4 text-slate-400" />
              </div>
              <p className={["mt-2 text-2xl font-semibold", card.textTone].join(" ")}>{card.value}</p>
            </article>
          );
        })}
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mr-1">Status:</span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => { setStatusFilter(f.value); setPage(0); }}
            className={[
              "rounded-full px-3 py-1 text-[11px] font-medium transition",
              statusFilter === f.value
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            ].join(" ")}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ReadModelState status={status} error={error} empty={allItems.length === 0}>
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
            <p className="text-sm text-slate-500">No ingestion tasks match the current filter.</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {pageItems.map((item) => (
                <TaskCard key={item.taskId} item={item} />
              ))}
            </div>

            {totalPages > 1 ? (
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-slate-500">
                  Page {page + 1} of {totalPages} ({items.length} tasks)
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            ) : null}
          </>
        )}
      </ReadModelState>
    </section>
  );
}

function TaskCard({ item }: { item: IngestionTaskStatus }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{item.taskId}</span>
            <span className={statusBadge(item.status)}>{item.status}</span>
          </div>
          <h3 className="text-sm font-semibold text-slate-900">
            {item.source.filename}
          </h3>
          <p className="text-xs text-slate-500">
            kb {item.knowledgeBaseId} / doc {item.documentId} / trace {item.traceId}
          </p>
          <p className="text-xs text-slate-500">
            parser {item.executionPlan.parser.parserType} / chunk {item.executionPlan.chunking.strategy} / stage {item.currentStage}
          </p>
        </div>
        <div className="space-y-1 text-xs text-slate-500">
          <p>chunks: {item.chunks.length}</p>
          <p>indexed records: {item.indexWriteResult?.recordCount ?? 0}</p>
          <p>trace events: {item.trace.length}</p>
          <p>updated: {new Date(item.updatedAt).toLocaleString()}</p>
        </div>
      </div>

      <div className="mt-3 border-t border-slate-200 pt-3">
        <div className="grid gap-2 lg:grid-cols-4">
          <StageBox label="Parser" status={item.parserResult?.status ?? "pending"} detail={item.parserResult?.parsedDocument?.title ?? "-"} />
          <StageBox label="Chunker" status={item.chunks.length > 0 ? "succeeded" : "pending"} detail={`${item.chunks.length} chunks`} />
          <StageBox label="Embedding" status={item.embeddingResult?.status ?? "pending"} detail={`${item.embeddingResult?.vectorCount ?? 0} vectors`} />
          <StageBox label="Indexing" status={item.indexWriteResult?.status ?? "pending"} detail={`${item.indexWriteResult?.recordCount ?? 0} records`} />
        </div>
      </div>

      {item.trace.length > 0 ? (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Latest Trace</p>
          <p className="mt-1 text-xs text-slate-700">{item.trace[item.trace.length - 1]?.message ?? "-"}</p>
          <p className="text-[11px] text-slate-400">
            {item.trace[item.trace.length - 1]?.stage ?? "-"} / {item.trace[item.trace.length - 1]?.status ?? "-"}
          </p>
        </div>
      ) : null}
    </article>
  );
}

function StageBox({ label, status, detail }: { label: string; status: string; detail: string }) {
  const tone =
    status === "succeeded" ? "border-emerald-200 bg-emerald-50/50" :
    status === "failed" ? "border-red-200 bg-red-50/50" :
    status === "running" ? "border-blue-200 bg-blue-50/50" :
    "border-slate-200 bg-white";

  return (
    <div className={["rounded-xl border px-3 py-2", tone].join(" ")}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-0.5 text-xs font-medium text-slate-700">{detail}</p>
    </div>
  );
}
