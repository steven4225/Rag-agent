"use client";

import { useState } from "react";
import { Filter, RotateCcw, Search } from "lucide-react";

export type TraceFilter = {
  traceId: string;
  conversationId: string;
  taskId: string;
  status: string;
};

type Props = {
  onApply: (filter: TraceFilter) => void;
  onReset: () => void;
};

const STATUS_OPTIONS = [
  { label: "All", value: "__all__" },
  { label: "Succeeded", value: "succeeded" },
  { label: "Running", value: "running" },
  { label: "Pending", value: "pending" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" }
];

const emptyFilter: TraceFilter = { traceId: "", conversationId: "", taskId: "", status: "__all__" };

export function TraceFilterBar({ onApply, onReset }: Props) {
  const [filter, setFilter] = useState<TraceFilter>(emptyFilter);

  const handleReset = () => {
    setFilter(emptyFilter);
    onReset();
  };

  const handleApply = () => {
    onApply({ ...filter });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <Filter className="h-4 w-4 text-slate-400" />
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Filter traces</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Trace ID</label>
          <input
            type="text"
            value={filter.traceId}
            onChange={(e) => setFilter((f) => ({ ...f, traceId: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            placeholder="e.g. trace_abc123"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Conversation ID</label>
          <input
            type="text"
            value={filter.conversationId}
            onChange={(e) => setFilter((f) => ({ ...f, conversationId: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            placeholder="e.g. conv_demo"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Task ID</label>
          <input
            type="text"
            value={filter.taskId}
            onChange={(e) => setFilter((f) => ({ ...f, taskId: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            placeholder="e.g. task_xyz"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Status</label>
          <select
            value={filter.status}
            onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-100"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleReset}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
        <button
          type="button"
          onClick={handleApply}
          className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800"
        >
          <Search className="h-3 w-3" />
          Search
        </button>
      </div>
    </div>
  );
}
