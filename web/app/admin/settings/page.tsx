"use client";

import { useMemo, useState } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createSetting, getSettingReadModel, updateSetting } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

type SettingDraft = {
  key: string;
  value: string;
  description: string;
};

const EMPTY_DRAFT: SettingDraft = {
  key: "",
  value: "",
  description: ""
};

export default function SettingsPage() {
  const { data, status, error, reload } = useApiResource(getSettingReadModel);
  const items = data?.items ?? [];

  const [createDraft, setCreateDraft] = useState<SettingDraft>(EMPTY_DRAFT);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<SettingDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeEditItem = useMemo(() => items.find((item) => item.key === editingKey) ?? null, [editingKey, items]);

  async function handleCreate() {
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await createSetting({
        key: createDraft.key,
        value: createDraft.value,
        description: createDraft.description
      });
      setCreateDraft(EMPTY_DRAFT);
      setFeedback("Setting created.");
      await reload();
    } catch (createError) {
      setSubmitError(createError instanceof Error ? createError.message : "Failed to create setting.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate() {
    if (!editingKey) return;
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await updateSetting({
        key: editingKey,
        value: editingDraft.value,
        description: editingDraft.description
      });
      setEditingKey(null);
      setEditingDraft(EMPTY_DRAFT);
      setFeedback("Setting updated.");
      await reload();
    } catch (updateError) {
      setSubmitError(updateError instanceof Error ? updateError.message : "Failed to update setting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Create Setting</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <input
            value={createDraft.key}
            onChange={(event) => setCreateDraft((current) => ({ ...current, key: event.target.value }))}
            placeholder="key"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.value}
            onChange={(event) => setCreateDraft((current) => ({ ...current, value: event.target.value }))}
            placeholder="value"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.description}
            onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
            placeholder="description"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
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
            const inEdit = item.key === editingKey;
            return (
              <article key={item.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{item.key}</p>
                {inEdit ? (
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <input
                      value={editingDraft.value}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, value: event.target.value }))}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      placeholder="value"
                    />
                    <input
                      value={editingDraft.description}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, description: event.target.value }))}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                      placeholder="description"
                    />
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{item.value}</p>
                    <p className="mt-1 text-xs text-slate-500">{item.description}</p>
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
                          setEditingKey(null);
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
                        setEditingKey(item.key);
                        setEditingDraft({
                          key: item.key,
                          value: item.value,
                          description: item.description
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

      {editingKey && !activeEditItem ? (
        <p className="text-xs text-amber-700">This setting no longer exists in current read-model snapshot.</p>
      ) : null}
    </section>
  );
}
