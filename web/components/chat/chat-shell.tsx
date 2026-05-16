"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, PanelLeft, Sparkles } from "lucide-react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatSessionList } from "@/components/chat/chat-session-list";
import { WelcomeScreen } from "@/components/chat/welcome-screen";
import type { TenantScopedSessionUser } from "@/lib/auth/session";
import type { ChatStreamEvent, Conversation, Message, ToolCall } from "@/lib/contracts";
import { createConversation, getConversations, getMessages, sendChatStream } from "@/lib/client/web-api";

type Props = {
  initialConversationId?: string;
  user: TenantScopedSessionUser;
};

export function ChatShell({ initialConversationId, user }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [conversationStatus, setConversationStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [conversationError, setConversationError] = useState<string | null>(null);

  const [messageStatus, setMessageStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [messageError, setMessageError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.conversationId === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );

  const loadConversations = useCallback(async (preferredConversationId?: string) => {
    setConversationStatus("loading");
    setConversationError(null);

    try {
      const response = await getConversations();
      setConversations(response.items);
      const candidateId = preferredConversationId ?? initialConversationId;
      const hasCandidate = candidateId ? response.items.some((item) => item.conversationId === candidateId) : false;

      setActiveConversationId(
        (current) => (hasCandidate ? candidateId : current) ?? response.items[0]?.conversationId ?? null
      );
      setConversationStatus("success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load conversations.";
      setConversationStatus("error");
      setConversationError(message);
    }
  }, [initialConversationId]);

  const loadMessages = useCallback(async (conversationId: string) => {
    setMessageStatus("loading");
    setMessageError(null);

    try {
      const response = await getMessages(conversationId);
      setMessages(response.items);
      setMessageStatus("success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load messages.";
      setMessageStatus("error");
      setMessageError(message);
      setMessages([]);
    }
  }, []);

  const onCreateConversation = async () => {
    try {
      setConversationError(null);
      const created = await createConversation();
      await loadConversations(created.conversationId);
      setSidebarOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create conversation.";
      setConversationError(message);
    }
  };

  const onCancel = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setStreamingAssistantText("");
    setStreamingToolCalls([]);
    setThinkingContent(null);
  }, []);

  const onSend = async () => {
    const value = draft.trim();
    if (!value || !activeConversationId || sending) return;

    setSending(true);
    setSendError(null);
    setStreamingAssistantText("");
    setStreamingToolCalls([]);
    setThinkingContent(null);
    cancelledRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sendChatStream(
        {
          conversationId: activeConversationId,
          message: value
        },
        (event: ChatStreamEvent) => {
          if (cancelledRef.current) return;

          if (event.type === "chat.started") {
            setActiveTraceId(event.traceId);
            setMessages((current) => [...current, event.userMessage]);
            return;
          }

          if (event.type === "thinking.delta") {
            setThinkingContent((current) => (current ?? "") + event.delta);
            return;
          }

          if (event.type === "thinking.completed") {
            setThinkingContent(null);
            return;
          }

          if (event.type === "tool.call") {
            setStreamingToolCalls((current) => {
              const index = current.findIndex((item) => item.toolCallId === event.toolCall.toolCallId);
              if (index < 0) {
                return [...current, event.toolCall];
              }
              return current.map((item) => (item.toolCallId === event.toolCall.toolCallId ? event.toolCall : item));
            });
            return;
          }

          if (event.type === "message.delta") {
            setStreamingAssistantText((current) => current + event.delta);
            return;
          }

          if (event.type === "message.completed") {
            setMessages((current) => [...current, event.assistantMessage]);
            setStreamingAssistantText("");
            setStreamingToolCalls([]);
            return;
          }

          if (event.type === "chat.error") {
            setSendError(event.message);
          }
        },
        controller.signal
      );
      setDraft("");
      await loadConversations(activeConversationId);
      setMessageStatus("success");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // user cancelled — no error to surface
      } else {
        const message = error instanceof Error ? error.message : "Failed to send message.";
        setSendError(message);
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setMessageStatus("success");
      return;
    }

    void loadMessages(activeConversationId);
  }, [activeConversationId, loadMessages]);

  return (
    <div className="flex min-h-screen bg-[#fafafa] text-slate-900">
      <div
        className={[
          "fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-sm transition lg:hidden",
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        ].join(" ")}
        onClick={() => setSidebarOpen(false)}
      />

      <ChatSessionList
        conversations={conversations}
        activeConversationId={activeConversationId}
        status={conversationStatus}
        error={conversationError}
        onCreateConversation={onCreateConversation}
        onSelectConversation={setActiveConversationId}
        onCloseSidebar={() => setSidebarOpen(false)}
        sidebarOpen={sidebarOpen}
        user={user}
      />

      <main className="flex min-h-screen min-w-0 flex-1 flex-col bg-white">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/92 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 lg:hidden"
                onClick={() => setSidebarOpen((current) => !current)}
                aria-label="Toggle sidebar"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Chat Workspace</p>
                <h1 className="truncate text-base font-semibold text-slate-900 sm:text-lg">
                  {activeConversation?.title ?? "New conversation"}
                </h1>
              </div>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
                Tenant {user.tenantId}
              </div>
              {user.role === "admin" ? (
                <Link
                  href="/admin/dashboard"
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  Admin
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="mx-auto flex h-full w-full max-w-4xl flex-col">
                {messages.length === 0 && !sending && !streamingAssistantText && !thinkingContent ? (
                  <WelcomeScreen
                    onSend={onSend}
                    isStreaming={sending}
                    onCancel={onCancel}
                  />
                ) : (
                  <ChatMessageList
                    messages={messages}
                    status={messageStatus}
                    error={messageError}
                    streamingAssistantText={streamingAssistantText}
                    streamingToolCalls={streamingToolCalls}
                    thinkingContent={thinkingContent}
                  />
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 bg-white/92 px-4 py-4 backdrop-blur sm:px-6">
              <div className="mx-auto max-w-4xl">
                <ChatComposer
                  draft={draft}
                  activeConversationId={activeConversationId}
                  sending={sending}
                  sendError={sendError}
                  onDraftChange={setDraft}
                  onSend={onSend}
                />
              </div>
            </div>
          </section>

          <aside className="hidden w-full border-l border-slate-200 bg-[#fcfcfd] xl:flex xl:max-w-[320px] xl:flex-col">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                <Sparkles className="h-4 w-4" />
              </div>
              <h2 className="mt-4 text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">Planner</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Agent orchestration panel showing conversation state, execution stage, and active trace information.
              </p>
            </div>
            <div className="space-y-3 px-5 py-5">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Active conversation</p>
                <p className="mt-2 text-sm font-medium text-slate-900">{activeConversation?.title ?? "No conversation selected"}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Current stage</p>
                <p className="mt-2 text-sm text-slate-700">
                  {sending && thinkingContent ? "Agent is reasoning..." : sending ? "Streaming response..." : "Idle — send a message to start."}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Execution boundary</p>
                <p className="mt-2 text-sm text-slate-700">Retrieval and tool calls dispatched through the Go execution plane via internal APIs.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Trace</p>
                <p className="mt-2 text-sm text-slate-700">{activeTraceId ?? "No active trace"}</p>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
