"use client";

import { useMemo, useState } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createSampleQuestion, getSampleQuestionReadModel, updateSampleQuestion } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";

type SampleQuestionDraft = {
  question: string;
  knowledgeBaseId: string;
  enabled: boolean;
};

const EMPTY_DRAFT: SampleQuestionDraft = {
  question: "",
  knowledgeBaseId: "",
  enabled: true
};

function toNullableKnowledgeBaseId(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export default function SampleQuestionsPage() {
  const { data, status, error, reload } = useApiResource(getSampleQuestionReadModel);
  const items = data?.items ?? [];

  const [createDraft, setCreateDraft] = useState<SampleQuestionDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<SampleQuestionDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeEditItem = useMemo(() => items.find((item) => item.questionId === editingId) ?? null, [editingId, items]);

  async function handleCreate() {
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await createSampleQuestion({
        question: createDraft.question,
        knowledgeBaseId: toNullableKnowledgeBaseId(createDraft.knowledgeBaseId),
        enabled: createDraft.enabled
      });
      setCreateDraft(EMPTY_DRAFT);
      setFeedback("Sample question created.");
      await reload();
    } catch (createError) {
      setSubmitError(createError instanceof Error ? createError.message : "Failed to create sample question.");
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
      await updateSampleQuestion({
        questionId: editingId,
        question: editingDraft.question,
        knowledgeBaseId: toNullableKnowledgeBaseId(editingDraft.knowledgeBaseId),
        enabled: editingDraft.enabled
      });
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setFeedback("Sample question updated.");
      await reload();
    } catch (updateError) {
      setSubmitError(updateError instanceof Error ? updateError.message : "Failed to update sample question.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Sample Questions</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Create Sample Question</p>
        <div className="mt-3 space-y-3">
          <textarea
            value={createDraft.question}
            onChange={(event) => setCreateDraft((current) => ({ ...current, question: event.target.value }))}
            placeholder="sample question"
            rows={3}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <input
              value={createDraft.knowledgeBaseId}
              onChange={(event) => setCreateDraft((current) => ({ ...current, knowledgeBaseId: event.target.value }))}
              placeholder="knowledge base id (optional)"
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
            const inEdit = item.questionId === editingId;
            return (
              <article key={item.questionId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{item.questionId}</p>
                {inEdit ? (
                  <div className="mt-2 space-y-3">
                    <textarea
                      value={editingDraft.question}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, question: event.target.value }))}
                      rows={3}
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                      <input
                        value={editingDraft.knowledgeBaseId}
                        onChange={(event) => setEditingDraft((current) => ({ ...current, knowledgeBaseId: event.target.value }))}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                        placeholder="knowledge base id (optional)"
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
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{item.question}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      KB: {item.knowledgeBaseId ?? "global"} / {item.enabled ? "Enabled" : "Disabled"}
                    </p>
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
                        setEditingId(item.questionId);
                        setEditingDraft({
                          question: item.question,
                          knowledgeBaseId: item.knowledgeBaseId ?? "",
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
        <p className="text-xs text-amber-700">This sample question no longer exists in current read-model snapshot.</p>
      ) : null}
    </section>
  );
}
