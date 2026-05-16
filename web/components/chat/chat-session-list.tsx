"use client";

import { useMemo, useState } from "react";
import { Bot, Plus, Search, Shield, X } from "lucide-react";

import { ReadModelState } from "@/components/common/read-model-state";
import type { TenantScopedSessionUser } from "@/lib/auth/session";
import type { Conversation } from "@/lib/contracts";

type Props = {
  conversations: Conversation[];
  activeConversationId: string | null;
  status: "idle" | "loading" | "success" | "error";
  error: string | null;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onCloseSidebar: () => void;
  sidebarOpen: boolean;
  user: TenantScopedSessionUser;
};

export function ChatSessionList(props: Props) {
  const [query, setQuery] = useState("");

  const filteredConversations = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return props.conversations;
    return props.conversations.filter((conversation) => {
      return (
        conversation.title.toLowerCase().includes(keyword) ||
        conversation.conversationId.toLowerCase().includes(keyword)
      );
    });
  }, [props.conversations, query]);

  const displayName = props.user.name || props.user.userId;

  return (
    <aside
      className={[
        "fixed left-0 top-0 z-40 flex h-screen w-[290px] flex-col border-r border-slate-200 bg-[#fafafa] transition-transform lg:static lg:translate-x-0",
        props.sidebarOpen ? "translate-x-0" : "-translate-x-full"
      ].join(" ")}
    >
      <div className="border-b border-slate-200 px-4 pb-4 pt-4">
        <div className="flex items-center justify-between lg:hidden">
          <div />
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500"
            onClick={props.onCloseSidebar}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-[0_12px_26px_rgba(37,99,235,0.28)]">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">Ragent AI</p>
            <p className="text-xs text-slate-500">Chat workspace</p>
          </div>
        </div>
        <button
          className="mt-4 flex w-full items-center gap-3 rounded-2xl bg-slate-950 px-4 py-3 text-left text-sm font-medium text-white transition hover:bg-slate-800"
          onClick={props.onCreateConversation}
          type="button"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/12">
            <Plus className="h-4 w-4" />
          </span>
          <span>
            <span className="block">New conversation</span>
            <span className="block text-xs text-slate-300">Create a fresh thread in the current tenant.</span>
          </span>
        </button>
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-9 pr-4 text-sm text-slate-800 outline-none transition focus:border-blue-300"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-3 py-4">
        {props.error ? (
          <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{props.error}</div>
        ) : null}
        <ReadModelState status={props.status} error={props.error} empty={filteredConversations.length === 0}>
          <div className="h-full space-y-1 overflow-y-auto pr-1">
            {filteredConversations.map((conversation) => {
              const active = conversation.conversationId === props.activeConversationId;
              return (
                <button
                  key={conversation.conversationId}
                  className={[
                    "w-full rounded-2xl border px-3 py-3 text-left transition",
                    active
                      ? "border-blue-200 bg-blue-50 text-blue-900 shadow-[0_10px_24px_rgba(59,130,246,0.12)]"
                      : "border-transparent text-slate-700 hover:border-slate-200 hover:bg-white"
                  ].join(" ")}
                  onClick={() => {
                    props.onSelectConversation(conversation.conversationId);
                    props.onCloseSidebar();
                  }}
                  type="button"
                >
                  <p className="truncate text-sm font-medium">{conversation.title}</p>
                  <p className="mt-1 text-xs text-slate-500">{new Date(conversation.updatedAt).toLocaleString()}</p>
                </button>
              );
            })}
          </div>
        </ReadModelState>
      </div>

      <div className="border-t border-slate-200 px-4 py-4">
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-900">{displayName}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <Shield className="h-3.5 w-3.5" />
              <span>{props.user.role}</span>
              <span className="truncate">/ {props.user.tenantId}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
