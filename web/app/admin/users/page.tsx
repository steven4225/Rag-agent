"use client";

import { useMemo, useState } from "react";

import { ReadModelState } from "@/components/common/read-model-state";
import { createUser, getUserReadModel, updateUser } from "@/lib/client/web-api";
import { useApiResource } from "@/lib/client/use-api-resource";
import type { UserRole } from "@/lib/contracts";

type UserDraft = {
  userId: string;
  name: string;
  role: UserRole;
  tenantId: string;
  orgId: string;
};

const EMPTY_DRAFT: UserDraft = {
  userId: "",
  name: "",
  role: "user",
  tenantId: "",
  orgId: ""
};

function toNullableScope(value: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export default function UsersPage() {
  const { data, status, error, reload } = useApiResource(getUserReadModel);
  const items = data?.items ?? [];

  const [createDraft, setCreateDraft] = useState<UserDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<UserDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const activeEditItem = useMemo(() => items.find((item) => item.userId === editingId) ?? null, [editingId, items]);

  async function handleCreate() {
    setSubmitError(null);
    setFeedback(null);
    setSaving(true);
    try {
      await createUser({
        userId: createDraft.userId,
        name: createDraft.name,
        role: createDraft.role,
        tenantId: toNullableScope(createDraft.tenantId),
        orgId: toNullableScope(createDraft.orgId)
      });
      setCreateDraft(EMPTY_DRAFT);
      setFeedback("User created.");
      await reload();
    } catch (createError) {
      setSubmitError(createError instanceof Error ? createError.message : "Failed to create user.");
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
      await updateUser({
        userId: editingId,
        name: editingDraft.name,
        role: editingDraft.role,
        tenantId: toNullableScope(editingDraft.tenantId),
        orgId: toNullableScope(editingDraft.orgId)
      });
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setFeedback("User updated.");
      await reload();
    } catch (updateError) {
      setSubmitError(updateError instanceof Error ? updateError.message : "Failed to update user.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Users</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <article className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Create User</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input
            value={createDraft.userId}
            onChange={(event) => setCreateDraft((current) => ({ ...current, userId: event.target.value }))}
            placeholder="user id"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.name}
            onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="name"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <select
            value={createDraft.role}
            onChange={(event) => setCreateDraft((current) => ({ ...current, role: event.target.value as UserRole }))}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <input
            value={createDraft.tenantId}
            onChange={(event) => setCreateDraft((current) => ({ ...current, tenantId: event.target.value }))}
            placeholder="tenant id (optional)"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
          />
          <input
            value={createDraft.orgId}
            onChange={(event) => setCreateDraft((current) => ({ ...current, orgId: event.target.value }))}
            placeholder="org id (optional)"
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
            const inEdit = item.userId === editingId;
            return (
              <article key={item.userId} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{item.userId}</p>
                {inEdit ? (
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <input
                      value={editingDraft.name}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="name"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <select
                      value={editingDraft.role}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, role: event.target.value as UserRole }))}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                    <input
                      value={editingDraft.tenantId}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, tenantId: event.target.value }))}
                      placeholder="tenant id"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                    <input
                      value={editingDraft.orgId}
                      onChange={(event) => setEditingDraft((current) => ({ ...current, orgId: event.target.value }))}
                      placeholder="org id"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{item.name}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      role: {item.role} / tenant: {item.tenantId ?? "null"} / org: {item.orgId ?? "null"}
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
                        setEditingId(item.userId);
                        setEditingDraft({
                          userId: item.userId,
                          name: item.name,
                          role: item.role,
                          tenantId: item.tenantId ?? "",
                          orgId: item.orgId ?? ""
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
        <p className="text-xs text-amber-700">This user no longer exists in current read-model snapshot.</p>
      ) : null}
    </section>
  );
}
