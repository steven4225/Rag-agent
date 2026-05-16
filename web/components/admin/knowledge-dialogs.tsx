"use client";

import { useState } from "react";

type CreateDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
};

export function CreateKnowledgeBaseDialog({ open, onClose, onCreate }: CreateDialogProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await onCreate(trimmed);
      setName("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create knowledge base");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900">Create knowledge base</h3>
        <p className="mt-1 text-sm text-slate-500">Add a new knowledge base to the platform.</p>
        <div className="mt-4">
          <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
            placeholder="Knowledge base name"
            className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            autoFocus
          />
        </div>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!name.trim() || loading}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

type RenameDialogProps = {
  open: boolean;
  knowledgeBaseId: string;
  currentName: string;
  onClose: () => void;
  onRename: (knowledgeBaseId: string, name: string) => Promise<void>;
};

export function RenameKnowledgeBaseDialog({ open, knowledgeBaseId, currentName, onClose, onRename }: RenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) return;
    setLoading(true);
    setError(null);
    try {
      await onRename(knowledgeBaseId, trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename knowledge base");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900">Rename knowledge base</h3>
        <p className="mt-1 text-sm text-slate-500">Change the display name for this knowledge base.</p>
        <div className="mt-4">
          <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
            className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            autoFocus
          />
        </div>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleRename()}
            disabled={!name.trim() || name.trim() === currentName || loading}
            className="rounded-full bg-slate-900 px-4 py-2 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

type DeleteDialogProps = {
  open: boolean;
  knowledgeBaseId: string;
  name: string;
  onClose: () => void;
  onDelete: (knowledgeBaseId: string) => Promise<void>;
};

export function DeleteKnowledgeBaseDialog({ open, knowledgeBaseId, name, onClose, onDelete }: DeleteDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleDelete = async () => {
    setLoading(true);
    setError(null);
    try {
      await onDelete(knowledgeBaseId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete knowledge base");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900">Delete knowledge base</h3>
        <p className="mt-1 text-sm text-slate-500">
          Are you sure you want to delete <span className="font-semibold text-slate-900">{name}</span>? This action cannot be undone.
        </p>
        {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 px-4 py-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={loading}
            className="rounded-full bg-red-600 px-4 py-2 text-xs text-white hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
