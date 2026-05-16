"use client";

import { Activity, ArchiveRestore, Bot, Database, FileWarning, MessageSquareText, TimerReset, Waypoints, Workflow } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { getDashboardReadModel } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

function PipBar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full rounded-full bg-slate-100">
      <div className={["h-full rounded-full transition-all", tone].join(" ")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function DashboardPage() {
  const { data, status, error, reload } = useApiResource(getDashboardReadModel);
  const m = data?.metrics;

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Operational snapshot</h3>
          <p className="mt-1 text-sm text-slate-500">Platform metrics across chat, retrieval, ingestion, and knowledge.</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <ReadModelState status={status} error={error} empty={!m}>
        {/* Row 1: Core KPIs */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Active Users", value: m?.activeUsers ?? 0, icon: Activity, tone: "bg-emerald-50 text-emerald-600" },
            { label: "Conversations", value: m?.conversations ?? 0, icon: Bot, tone: "bg-blue-50 text-blue-600" },
            { label: "Messages", value: m?.messages ?? 0, icon: MessageSquareText, tone: "bg-violet-50 text-violet-600" },
            { label: "Traces", value: m?.traces ?? 0, icon: Waypoints, tone: "bg-amber-50 text-amber-600" }
          ].map((kpi) => {
            const Icon = kpi.icon;
            return (
              <article key={kpi.label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{kpi.label}</p>
                    <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{kpi.value}</p>
                  </div>
                  <span className={["inline-flex h-11 w-11 items-center justify-center rounded-2xl", kpi.tone].join(" ")}>
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
              </article>
            );
          })}
        </div>

        {/* Row 2: Pipeline + Knowledge */}
        <div className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Workflow className="h-4 w-4 text-slate-400" />
              <h4 className="text-sm font-semibold text-slate-900">Message Pipeline</h4>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Generated</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{m?.generatedMessages ?? 0}</p>
                <p className="mt-1 text-[11px] text-slate-400">LLM responses</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Retrieval</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{m?.retrievalAnnotatedMessages ?? 0}</p>
                <p className="mt-1 text-[11px] text-slate-400">RAG annotated</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Tool Calls</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{m?.toolCalls ?? 0}</p>
                <p className="mt-1 text-[11px] text-slate-400">Agent tools</p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Retrieval ratio</span>
                <span>
                  {m?.messages ? Math.round(((m?.retrievalAnnotatedMessages ?? 0) / m.messages) * 100) : 0}%
                </span>
              </div>
              <PipBar
                value={m?.retrievalAnnotatedMessages ?? 0}
                max={m?.messages ?? 1}
                tone="bg-violet-500"
              />
            </div>
          </article>

          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-slate-400" />
              <h4 className="text-sm font-semibold text-slate-900">Knowledge & Ingestion</h4>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Knowledge Bases</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{m?.knowledgeBases ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Ingestion Tasks</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{m?.ingestionTasks ?? 0}</p>
              </div>
            </div>
          </article>
        </div>

        {/* Row 3: Ingestion health + system info */}
        <div className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <ArchiveRestore className="h-4 w-4 text-slate-400" />
              <h4 className="text-sm font-semibold text-slate-900">Ingestion Health</h4>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-emerald-700">Succeeded</p>
                <p className="mt-2 text-2xl font-semibold text-emerald-800">{m?.ingestionSucceeded ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-red-200 bg-red-50/50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-red-700">Failed</p>
                <p className="mt-2 text-2xl font-semibold text-red-800">{m?.ingestionFailed ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-blue-200 bg-blue-50/50 px-4 py-4">
                <p className="text-xs uppercase tracking-[0.16em] text-blue-700">Running</p>
                <p className="mt-2 text-2xl font-semibold text-blue-800">{m?.ingestionRunning ?? 0}</p>
              </div>
            </div>
            {m?.ingestionTasks ? (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Success rate</span>
                  <span>
                    {m.ingestionTasks > 0
                      ? Math.round(((m.ingestionSucceeded ?? 0) / m.ingestionTasks) * 100)
                      : 0}%
                  </span>
                </div>
                <PipBar value={m?.ingestionSucceeded ?? 0} max={m?.ingestionTasks ?? 1} tone="bg-emerald-500" />
              </div>
            ) : null}
          </article>

          <article className="rounded-3xl border border-slate-200 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <TimerReset className="h-4 w-4 text-slate-400" />
              <h4 className="text-sm font-semibold text-slate-900">Architecture Snapshot</h4>
            </div>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <li className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <span className="font-semibold text-slate-900">TS Control Plane</span> — App Router, admin APIs, auth/session enforcement, read-model adapters.
              </li>
              <li className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <span className="font-semibold text-slate-900">Go Execution Plane</span> — Retrieval service, ingestion pipeline, BM25 cache, chunker/embedding/indexing adapters.
              </li>
              <li className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <span className="font-semibold text-slate-900">Streaming Boundary</span> — SSE chat stream with thinking delta, tool call, and message event types.
              </li>
            </ul>
          </article>
        </div>
      </ReadModelState>
    </section>
  );
}
