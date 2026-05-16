"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Database, FileText, Layers3, Pencil, Plus, Trash2 } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import {
  CreateKnowledgeBaseDialog,
  DeleteKnowledgeBaseDialog,
  RenameKnowledgeBaseDialog
} from "@/components/admin/knowledge-dialogs";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeReadModel,
  renameKnowledgeBase
} from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

export default function KnowledgePage() {
  const { data, status, error, reload } = useApiResource(getKnowledgeReadModel);
  const items = data?.items ?? [];
  const totalDocuments = items.reduce((sum, item) => sum + item.documentCount, 0);
  const latestUpdate = items[0]?.updatedAt ? new Date(items[0].updatedAt).toLocaleString() : "--";

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ knowledgeBaseId: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ knowledgeBaseId: string; name: string } | null>(null);

  const handleCreate = useCallback(async (name: string) => {
    await createKnowledgeBase({ name });
    await reload();
  }, [reload]);

  const handleRename = useCallback(async (knowledgeBaseId: string, name: string) => {
    await renameKnowledgeBase({ knowledgeBaseId, name });
    await reload();
  }, [reload]);

  const handleDelete = useCallback(async (knowledgeBaseId: string) => {
    await deleteKnowledgeBase(knowledgeBaseId);
    await reload();
  }, [reload]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Knowledge bases</h3>
          <p className="mt-1 text-sm text-slate-500">Create, rename, and manage knowledge bases with document and chunk drill-down.</p>
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
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            New KB
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "Knowledge bases", value: items.length, icon: Database, tone: "bg-blue-50 text-blue-600" },
          { label: "Documents", value: totalDocuments, icon: FileText, tone: "bg-violet-50 text-violet-600" },
          { label: "Latest update", value: latestUpdate, icon: Layers3, tone: "bg-emerald-50 text-emerald-600" }
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

      <ReadModelState status={status} error={error} empty={items.length === 0}>
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.knowledgeBaseId} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
                    <Database className="h-3.5 w-3.5" />
                    Knowledge base
                  </div>
                  <h4 className="mt-3 text-base font-semibold text-slate-900">{item.name}</h4>
                  <p className="mt-1 text-sm text-slate-500">
                    {item.documentCount} documents / updated {new Date(item.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRenameTarget({ knowledgeBaseId: item.knowledgeBaseId, name: item.name })}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    aria-label="Rename"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget({ knowledgeBaseId: item.knowledgeBaseId, name: item.name })}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-red-200 bg-white text-red-500 hover:bg-red-50"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <Link
                    href={`/admin/knowledge/${item.knowledgeBaseId}`}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    Open
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      </ReadModelState>

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />

      {renameTarget ? (
        <RenameKnowledgeBaseDialog
          open
          knowledgeBaseId={renameTarget.knowledgeBaseId}
          currentName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRename={handleRename}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteKnowledgeBaseDialog
          open
          knowledgeBaseId={deleteTarget.knowledgeBaseId}
          name={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onDelete={handleDelete}
        />
      ) : null}
    </section>
  );
}
