"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Clock3, TimerReset, Waypoints } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { TraceFilterBar, type TraceFilter } from "@/components/admin/filter-bar";
import { getTraceReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import type { TraceRun } from "@/lib/contracts";

const PAGE_SIZE = 10;

function applyFilter(items: TraceRun[], filter: TraceFilter) {
  return items.filter((item) => {
    if (filter.traceId && !item.traceId.toLowerCase().includes(filter.traceId.toLowerCase())) return false;
    if (filter.conversationId && !(item.conversationId ?? "").toLowerCase().includes(filter.conversationId.toLowerCase())) return false;
    if (filter.taskId) {
      const hasTask = item.nodes.some((node) =>
        (node.nodeId ?? "").toLowerCase().includes(filter.taskId.toLowerCase())
      );
      if (!hasTask) return false;
    }
    if (filter.status && filter.status !== "__all__" && item.status !== filter.status) return false;
    return true;
  });
}

export default function TracesPage() {
  const { data, status, error, reload } = useApiResource(getTraceReadModel);
  const allItems = data?.items ?? [];
  const [filter, setFilter] = useState<TraceFilter>({ traceId: "", conversationId: "", taskId: "", status: "__all__" });
  const [page, setPage] = useState(0);

  const items = useMemo(() => applyFilter(allItems, filter), [allItems, filter]);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const successCount = allItems.filter((item) => item.status.toLowerCase() === "success").length;
  const averageDuration =
    allItems.length > 0
      ? Math.round(allItems.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) / allItems.length)
      : 0;

  const handleFilterApply = (newFilter: TraceFilter) => {
    setFilter(newFilter);
    setPage(0);
  };

  const handleFilterReset = () => {
    setFilter({ traceId: "", conversationId: "", taskId: "", status: "__all__" });
    setPage(0);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Trace runs</h3>
          <p className="mt-1 text-sm text-slate-500">Search and inspect trace execution records.</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: "Runs", value: allItems.length, icon: Waypoints, tone: "bg-blue-50 text-blue-600" },
          { label: "Successful", value: successCount, icon: Activity, tone: "bg-emerald-50 text-emerald-600" },
          { label: "Avg. duration", value: `${averageDuration}ms`, icon: Clock3, tone: "bg-violet-50 text-violet-600" },
          { label: "Streaming route", value: "/api/chat/stream", icon: TimerReset, tone: "bg-amber-50 text-amber-600" }
        ].map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
                  <p className="mt-3 text-lg font-semibold text-slate-950">{card.value}</p>
                </div>
                <span className={["inline-flex h-11 w-11 items-center justify-center rounded-2xl", card.tone].join(" ")}>
                  <Icon className="h-5 w-5" />
                </span>
              </div>
            </article>
          );
        })}
      </div>

      <TraceFilterBar onApply={handleFilterApply} onReset={handleFilterReset} />

      <ReadModelState status={status} error={error} empty={allItems.length === 0}>
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
            <p className="text-sm text-slate-500">No traces match the current filter.</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {pageItems.map((item) => (
                <article key={item.runId} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={[
                            "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                            item.status === "succeeded" ? "bg-emerald-50 text-emerald-700" :
                            item.status === "failed" ? "bg-red-50 text-red-700" :
                            item.status === "running" ? "bg-blue-50 text-blue-700" :
                            item.status === "cancelled" ? "bg-amber-50 text-amber-700" :
                            "bg-slate-100 text-slate-600"
                          ].join(" ")}
                        >
                          {item.status}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {item.durationMs != null ? `${item.durationMs}ms` : "-"}
                        </span>
                      </div>
                      <p className="mt-2 truncate font-mono text-sm font-semibold text-slate-900">{item.traceId}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        run {item.runId} / {item.conversationId ?? "no conversation"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {item.nodes.length} nodes / started {item.startedAt ? new Date(item.startedAt).toLocaleString() : "-"}
                      </p>
                    </div>
                    <Link
                      href={`/admin/traces/${item.traceId}`}
                      className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      Detail
                    </Link>
                  </div>
                </article>
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
                  Page {page + 1} of {totalPages} ({items.length} traces)
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
