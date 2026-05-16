"use client";

type Props = {
  draft: string;
  activeConversationId: string | null;
  sending: boolean;
  sendError: string | null;
  onDraftChange: (value: string) => void;
  onSend: () => void;
};

export function ChatComposer(props: Props) {
  return (
    <div className="rounded-[28px] border border-slate-200 bg-[#f8fafc] p-4 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
      <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Message</label>
      <textarea
        className="min-h-32 w-full resize-none rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-400 focus:border-blue-300"
        placeholder="Send a message to verify streaming chat orchestration..."
        value={props.draft}
        onChange={(event) => props.onDraftChange(event.target.value)}
      />
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">
          {props.activeConversationId ? "Using /api/chat/stream in TS control plane." : "Create a conversation first."}
        </p>
        <button
          className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={props.onSend}
          type="button"
          disabled={!props.activeConversationId || props.sending || !props.draft.trim()}
        >
          {props.sending ? "Streaming..." : "Send"}
        </button>
      </div>
      {props.sendError ? <p className="mt-2 text-xs text-rose-700">{props.sendError}</p> : null}
    </div>
  );
}
