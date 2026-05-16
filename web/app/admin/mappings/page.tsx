"use client";

import { useMemo, useState } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createMapping, getMappingReadModel, updateMapping } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

type MappingDraft = {
  sourceTerm: string;
  targetTerm: string;
  enabled: boolean;
};

const EMPTY_DRAFT: MappingDraft = {
  sourceTerm: "",
  targetTerm: "",
  enabled: true
};

export default function MappingsPage() {
  const { data, status, error, reload } = useApiResource(getMappingReadModel);
  const items = data?.items ?? [];

  const [createDraft, setCreateDraft] = useState<MappingDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<MappingDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeEditItem = useMemo(() => items.find((item) => item.mappingId === editingId) ?? null, [editingId, items]);

  async function handleCreate() {
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await createMapping({
        sourceTerm: createDraft.sourceTerm,
        targetTerm: createDraft.targetTerm,
        enabled: createDraft.enabled
      });
      setCreateDraft(EMPTY_DRAFT);
      setFeedback("Mapping created.");
      await reload();
    } catch (createError) {
      setSubmitError(createError instanceof Error ? createError.message : "Failed to create mapping.");
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
      await updateMapping({
        mappingId: editingId,
        sourceTerm: editingDraft.sourceTerm,
        targetTerm: editingDraft.targetTerm,
        enabled: editingDraft.enabled
      });
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setFeedback("Mapping updated.");
      await reload();
    } catch (updateError) {
      setSubmitError(updateError instanceof Error ? updateError.message : "Failed to update mapping.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Mappings</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Create Mapping</p>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <input
            value={createDraft.sourceTerm}
            onChange={(event) => setCreateDraft((current) => ({ ...current, sourceTerm: event.target.value }))}
            placeholder="source term"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.targetTerm}
            onChange={(event) => setCreateDraft((current) => ({ ...current, targetTerm: event.target.value }))}
            placeholder="target term"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={createDraft.enabled}
              onChange={(event) => setCreateDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            enabled
          </label>
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={saving}
          className="mt-3 rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Create"}
        </button>
      </article>

      {feedback ? <p className="text-sm text-emerald-700">{feedback}</p> : null}
      {submitError ? <p className="text-sm text-rose-600">{submitError}</p> : null}

      <ReadModelState status={status} error={error} empty={items.length === 0}>
        <div className="space-y-3">
          {items.map((item) => {
            const inEdit = item.mappingId === editingId;
            return (
              <article key={item.mappingId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{item.mappingId}</p>
                {inEdit ? (
                  <div className="mt-2 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                    <input
                      value={editingDraft.sourceTerm}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, sourceTerm: event.target.value }))}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <input
                      value={editingDraft.targetTerm}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, targetTerm: event.target.value }))}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={editingDraft.enabled}
                        onChange={(event) => setEditingDraft((current) => ({ ...current, enabled: event.target.checked }))}
                      />
                      enabled
                    </label>
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {item.sourceTerm} to {item.targetTerm}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{item.enabled ? "Enabled" : "Disabled"}</p>
                  </>
                )}
                <div className="mt-3 flex items-center gap-2">
                  {inEdit ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleUpdate()}
                        disabled={saving}
                        className="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingDraft(EMPTY_DRAFT);
                        }}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.mappingId);
                        setEditingDraft({
                          sourceTerm: item.sourceTerm,
                          targetTerm: item.targetTerm,
                          enabled: item.enabled
                        });
                      }}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </ReadModelState>

      {editingId && !activeEditItem ? (
        <p className="text-xs text-amber-700">This mapping no longer exists in current read-model snapshot.</p>
      ) : null}
    </section>
  );
}
