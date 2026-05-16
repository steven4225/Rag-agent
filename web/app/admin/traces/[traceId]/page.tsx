"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { ArrowRight, Circle, Clock3 } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { getTraceReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import type { TraceNode } from "@/lib/contracts";

function nodeStatusColor(status: string) {
  switch (status) {
    case "succeeded": return "bg-emerald-500";
    case "failed": return "bg-red-500";
    case "running": return "bg-blue-500";
    case "pending": return "bg-slate-300";
    case "cancelled": return "bg-amber-500";
    default: return "bg-slate-400";
  }
}

function nodeStatusBorder(status: string) {
  switch (status) {
    case "succeeded": return "border-emerald-200";
    case "failed": return "border-red-200";
    case "running": return "border-blue-200";
    case "pending": return "border-slate-200";
    case "cancelled": return "border-amber-200";
    default: return "border-slate-200";
  }
}

function TimelineNode({ node, isLast }: { node: TraceNode; isLast: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={["h-3 w-3 rounded-full border-2 border-white shadow-sm", nodeStatusColor(node.status)].join(" ")} />
        {!isLast ? <div className="mt-1 w-0.5 flex-1 bg-slate-200" /> : null}
      </div>
      <div className={["flex-1 -mt-0.5 pb-4", isLast ? "" : ""].join(" ")}>
        <article className={["rounded-xl border bg-white p-3 shadow-sm", nodeStatusBorder(node.status)].join(" ")}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-900">{node.stage}</span>
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{node.nodeType}</span>
            </div>
            <span
              className={[
                "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                node.status === "succeeded" ? "bg-emerald-50 text-emerald-700" :
                node.status === "failed" ? "bg-red-50 text-red-700" :
                node.status === "running" ? "bg-blue-50 text-blue-700" :
                node.status === "cancelled" ? "bg-amber-50 text-amber-700" :
                "bg-slate-100 text-slate-600"
              ].join(" ")}
            >
              {node.status}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <span>node {node.nodeId}</span>
            {node.parentNodeId ? <span>parent {node.parentNodeId}</span> : null}
            {node.durationMs != null ? (
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-3 w-3" />
                {node.durationMs}ms
              </span>
            ) : null}
          </div>
          {node.startedAt ? (
            <p className="mt-1 text-[11px] text-slate-400">
              {new Date(node.startedAt).toLocaleString()} {node.finishedAt ? <><ArrowRight className="inline h-3 w-3 mx-0.5" /> {new Date(node.finishedAt).toLocaleString()}</> : null}
            </p>
          ) : null}
          {node.metadata && Object.keys(node.metadata).length > 0 ? (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100 max-h-32">
              {JSON.stringify(node.metadata, null, 2)}
            </pre>
          ) : null}
        </article>
      </div>
    </div>
  );
}

export default function TraceDetailPage() {
  const params = useParams<{ traceId: string }>();
  const traceId = params.traceId;
  const { data, status, error, reload } = useApiResource(getTraceReadModel);

  const matchingRuns = useMemo(
    () => (data?.items ?? []).filter((item) => item.traceId === traceId),
    [data?.items, traceId]
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Trace / {traceId}</h3>
          <p className="mt-1 text-sm text-slate-500">Execution timeline with node status, duration, and metadata across all runs for this trace.</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <ReadModelState status={status} error={error} empty={matchingRuns.length === 0}>
        <div className="space-y-4">
          {matchingRuns.map((run) => (
            <article key={run.runId} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center gap-3">
                  <span
                    className={[
                      "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                      run.status === "succeeded" ? "bg-emerald-50 text-emerald-700" :
                      run.status === "failed" ? "bg-red-50 text-red-700" :
                      run.status === "running" ? "bg-blue-50 text-blue-700" :
                      run.status === "cancelled" ? "bg-amber-50 text-amber-700" :
                      "bg-slate-100 text-slate-600"
                    ].join(" ")}
                  >
                    {run.status}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">Run {run.runId}</span>
                  {run.durationMs != null ? (
                    <span className="text-xs text-slate-500">{run.durationMs}ms total</span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {run.conversationId ?? "no conversation"} / {run.nodes.length} nodes
                  {run.startedAt ? <> / started {new Date(run.startedAt).toLocaleString()}</> : null}
                </p>
              </div>

              {run.nodes.length > 0 ? (
                <div className="ml-2">
                  {run.nodes.map((node, index) => (
                    <TimelineNode
                      key={node.nodeId}
                      node={node}
                      isLast={index === run.nodes.length - 1}
                    />
                  ))}
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-slate-400">No nodes recorded for this run.</p>
              )}
            </article>
          ))}
        </div>
      </ReadModelState>
    </section>
  );
}
