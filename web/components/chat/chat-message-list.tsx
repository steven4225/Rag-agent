"use client";

import { ReadModelState } from "@/components/common/read-model-state";
import { FeedbackButtons } from "@/components/chat/feedback-buttons";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { ThinkingIndicator } from "@/components/chat/thinking-indicator";
import type { Message, ToolCall } from "@/lib/contracts";
import { readUnifiedMessageMetadata } from "@/lib/read-model/metadata-mapper";

type Props = {
  messages: Message[];
  status: "idle" | "loading" | "success" | "error";
  error: string | null;
  streamingAssistantText: string;
  streamingToolCalls: ToolCall[];
  thinkingContent?: string | null;
};

function ToolCallPanel({ calls }: { calls: ToolCall[] }) {
  if (calls.length === 0) return null;

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-white/70 p-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Tool calls</p>
      {calls.map((call) => (
        <div key={call.toolCallId} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
          <p className="font-medium">{call.toolName}</p>
          <p className="mt-0.5 text-slate-500">status: {call.status}</p>
          <p className="mt-0.5 break-all text-slate-500">args: {JSON.stringify(call.args)}</p>
          {call.output && typeof call.output === "object" && "summary" in call.output ? (
            <p className="mt-0.5 text-slate-500">result: {String(call.output.summary)}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ChatMessageList(props: Props) {
  return (
    <ReadModelState status={props.status} error={props.error} empty={props.messages.length === 0 && !props.streamingAssistantText && !props.thinkingContent}>
      <div className="space-y-4">
        {props.thinkingContent ? (
          <ThinkingIndicator content={props.thinkingContent} />
        ) : null}

        {props.messages.map((message) => {
          const metadata = readUnifiedMessageMetadata(message);
          const toolCalls = metadata.toolCalls;
          const boundary = metadata.retrievalBoundary;

          return (
            <article
              key={message.messageId}
              className={[
                "group max-w-3xl rounded-[24px] px-5 py-4 text-sm leading-7 shadow-sm",
                message.role === "assistant"
                  ? "border border-slate-200 bg-white text-slate-800"
                  : "ml-auto bg-slate-950 text-white",
              ].join(" ")}
            >
              <p className="mb-1 text-xs uppercase tracking-[0.2em] opacity-70">{message.role}</p>
              {message.role === "assistant" ? (
                <MarkdownRenderer content={message.content} />
              ) : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
              {boundary ? <p className="mt-2 text-xs opacity-70">Retrieval boundary: {boundary.mode}{boundary.endpoint ? ` -> ${boundary.endpoint}` : ""}</p> : null}
              {metadata.retrievalSource ? <p className="mt-1 text-xs opacity-70">Retrieval source: {metadata.retrievalSource}</p> : null}
              {metadata.fallbackReason ? <p className="mt-1 text-xs opacity-70">Fallback reason: {metadata.fallbackReason}</p> : null}
              {metadata.generation ? <p className="mt-1 text-xs opacity-70">Generation: {metadata.generation.provider} / {metadata.generation.model}</p> : null}
              <ToolCallPanel calls={toolCalls} />
              {message.role === "assistant" && message.content ? (
                <div className="mt-3 border-t border-slate-100 pt-2">
                  <FeedbackButtons
                    messageId={message.messageId}
                    content={message.content}
                    feedback={(message.metadata?.feedback as "like" | "dislike" | null) ?? null}
                    onFeedback={(messageId, value) => {
                      fetch("/api/feedback", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ messageId, value }),
                      }).catch(err => console.warn("feedback failed", err));
                    }}
                  />
                </div>
              ) : null}
            </article>
          );
        })}

        {props.streamingAssistantText ? (
          <article className="group max-w-3xl rounded-[24px] border border-dashed border-slate-300 bg-white px-5 py-4 text-sm text-slate-700 shadow-sm">
            <p className="mb-1 text-xs uppercase tracking-[0.2em] opacity-70">assistant (streaming)</p>
            <MarkdownRenderer content={props.streamingAssistantText} />
            <ToolCallPanel calls={props.streamingToolCalls} />
          </article>
        ) : null}
      </div>
    </ReadModelState>
  );
}
