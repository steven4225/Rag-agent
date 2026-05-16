"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Circle, Layers3, Plus, Search, Trash2 } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createIntent, deleteIntent, getIntentReadModel, updateIntent } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import type { IntentReadModel } from "@/lib/contracts";

type IntentDraft = {
  name: string;
  description: string;
  parentIntentId: string;
  routeExpression: string;
  enabled: boolean;
  priority: number;
};

const EMPTY_DRAFT: IntentDraft = {
  name: "",
  description: "",
  parentIntentId: "",
  routeExpression: "",
  enabled: true,
  priority: 0
};

export default function IntentListPage() {
  const { data, status, error, reload } = useApiResource(getIntentReadModel);
  const items = data?.items ?? [];

  const [createDraft, setCreateDraft] = useState<IntentDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<IntentDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeEditItem = useMemo(() => items.find((i) => i.intentId === editingId) ?? null, [editingId, items]);
  const parentOptions = useMemo(
    () => items.filter((i) => i.intentId !== editingId).map((i) => ({ value: i.intentId, label: i.name })),
    [items, editingId]
  );

  async function handleCreate() {
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await createIntent({
        name: createDraft.name,
        description: createDraft.description,
        parentIntentId: createDraft.parentIntentId || null,
        routeExpression: createDraft.routeExpression,
        enabled: createDraft.enabled,
        priority: createDraft.priority
      });
      setCreateDraft(EMPTY_DRAFT);
      setFeedback("Intent created.");
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to create intent.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate() {
    if (!editingId) return;
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await updateIntent({
        intentId: editingId,
        name: editingDraft.name,
        description: editingDraft.description,
        parentIntentId: editingDraft.parentIntentId || null,
        routeExpression: editingDraft.routeExpression,
        enabled: editingDraft.enabled,
        priority: editingDraft.priority
      });
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setFeedback("Intent updated.");
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to update intent.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(intentId: string) {
    setSubmitError(null);
    setFeedback(null);
    try {
      await deleteIntent(intentId);
      if (editingId === intentId) {
        setEditingId(null);
        setEditingDraft(EMPTY_DRAFT);
      }
      setFeedback("Intent deleted.");
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to delete intent.");
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Intent List</h3>
          <p className="mt-1 text-sm text-slate-500">Create, edit, and organize agent routing intents.</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {/* Create form */}
      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Create Intent</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <input
            value={createDraft.name}
            onChange={(e) => setCreateDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="name *"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.description}
            onChange={(e) => setCreateDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="description"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <select
            value={createDraft.parentIntentId}
            onChange={(e) => setCreateDraft((d) => ({ ...d, parentIntentId: e.target.value }))}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          >
            <option value="">No parent (root)</option>
            {parentOptions.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <input
            value={createDraft.routeExpression}
            onChange={(e) => setCreateDraft((d) => ({ ...d, routeExpression: e.target.value }))}
            placeholder="route (e.g. /qa)"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={createDraft.enabled}
                onChange={(e) => setCreateDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              enabled
            </label>
            <input
              type="number"
              value={createDraft.priority}
              onChange={(e) => setCreateDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
              placeholder="priority"
              className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={saving || !createDraft.name.trim()}
          className="mt-3 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {saving ? "Saving..." : "Create"}
        </button>
      </article>

      {feedback ? <p className="text-sm text-emerald-700">{feedback}</p> : null}
      {submitError ? <p className="text-sm text-rose-600">{submitError}</p> : null}

      <ReadModelState status={status} error={error} empty={items.length === 0}>
        <div className="space-y-3">
          {items.map((item) => {
            const inEdit = item.intentId === editingId;
            const parent = item.parentIntentId
              ? items.find((p) => p.intentId === item.parentIntentId)
              : null;

            return (
              <article key={item.intentId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-slate-500">{item.intentId}</span>
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                          item.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                        ].join(" ")}
                      >
                        {item.enabled ? "Active" : "Disabled"}
                      </span>
                      <span className="text-[11px] text-slate-400">priority {item.priority}</span>
                    </div>

                    {inEdit ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input
                          value={editingDraft.name}
                          onChange={(e) => setEditingDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="name"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                        />
                        <input
                          value={editingDraft.description}
                          onChange={(e) => setEditingDraft((d) => ({ ...d, description: e.target.value }))}
                          placeholder="description"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                        />
                        <select
                          value={editingDraft.parentIntentId}
                          onChange={(e) => setEditingDraft((d) => ({ ...d, parentIntentId: e.target.value }))}
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                        >
                          <option value="">No parent (root)</option>
                          {parentOptions.map((p) => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-2">
                          <input
                            value={editingDraft.routeExpression}
                            onChange={(e) => setEditingDraft((d) => ({ ...d, routeExpression: e.target.value }))}
                            placeholder="route"
                            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                          />
                          <label className="flex items-center gap-1.5 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={editingDraft.enabled}
                              onChange={(e) => setEditingDraft((d) => ({ ...d, enabled: e.target.checked }))}
                            />
                            on
                          </label>
                          <input
                            type="number"
                            value={editingDraft.priority}
                            onChange={(e) => setEditingDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
                            className="w-16 rounded-xl border border-slate-200 px-2 py-2 text-sm text-slate-900"
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="mt-1 text-sm font-semibold text-slate-900">{item.name}</p>
                        {item.description ? (
                          <p className="mt-0.5 text-xs text-slate-500">{item.description}</p>
                        ) : null}
                        <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-400">
                          {item.routeExpression ? <span>route: {item.routeExpression}</span> : null}
                          {parent ? (
                            <span className="inline-flex items-center gap-1">
                              <ArrowRight className="h-3 w-3" />
                              child of {parent.name}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Circle className="h-2 w-2" />
                              root
                            </span>
                          )}
                          {item.knowledgeBaseIds.length > 0 ? (
                            <span>kbs: {item.knowledgeBaseIds.join(", ")}</span>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {inEdit ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleUpdate()}
                          disabled={saving}
                          className="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-60"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingId(null); setEditingDraft(EMPTY_DRAFT); }}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.intentId);
                            setEditingDraft({
                              name: item.name,
                              description: item.description,
                              parentIntentId: item.parentIntentId ?? "",
                              routeExpression: item.routeExpression,
                              enabled: item.enabled,
                              priority: item.priority
                            });
                          }}
                          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(item.intentId)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-red-200 bg-white text-red-500 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </ReadModelState>

      {editingId && !activeEditItem ? (
        <p className="text-xs text-amber-700">This intent no longer exists.</p>
      ) : null}
    </section>
  );
}
