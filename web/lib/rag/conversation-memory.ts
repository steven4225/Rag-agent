import type { ModelMessage } from "ai";

import type { Message } from "@/lib/contracts";
import {
  CONTEXT_BUDGET,
  estimateMessagesTokens,
  estimateTokens,
  fitToBudget,
  RECENT_RATIO,
} from "@/lib/rag/token-budget";

export type MemoryContext = {
  summaryText: string;
  recentMessages: ModelMessage[];
  tokenUsage: { summary: number; recent: number; total: number };
};

export type SummarizationInput = {
  existingSummary: string;
  newMessages: Pick<Message, "role" | "content">[];
};

/**
 * Manages multi-turn conversation memory with token-budgeted context
 * assembly and incremental summarization.
 *
 * Three-tier context:
 *   1. Summary (compressed older turns, injected into system prompt)
 *   2. Recent messages (token-budgeted raw history)
 *   3. Current query (handled by the caller)
 */
export class ConversationMemoryManager {
  private readonly summary: string;
  private readonly lastSummarizedId: string;
  private readonly messages: Message[];

  constructor(summary: string, lastSummarizedId: string, messages: Message[]) {
    this.summary = summary;
    this.lastSummarizedId = lastSummarizedId;
    this.messages = messages;
  }

  buildContext(): MemoryContext {
    const recentBudget = Math.floor(CONTEXT_BUDGET * RECENT_RATIO);
    // Take user+assistant pairs from most recent to oldest
    const pairs = this.messagePairs();
    const recentPairs = fitToBudget(pairs, (pair) => estimateTokens(pair.content), recentBudget);
    const recentMessages: ModelMessage[] = [];
    for (const pair of recentPairs) {
      recentMessages.push(
        { role: pair.role as "user" | "assistant", content: pair.content },
      );
    }

    const summaryText = this.summary ? `此前对话摘要：${this.summary}` : "";
    const summaryTokens = estimateTokens(summaryText);
    const recentTokens = estimateMessagesTokens(recentMessages);

    return {
      summaryText,
      recentMessages,
      tokenUsage: { summary: summaryTokens, recent: recentTokens, total: summaryTokens + recentTokens },
    };
  }

  needsSummarization(): boolean {
    // Trigger summarization when total estimated tokens exceed budget.
    // Don't re-summarize if there's no new content beyond the last summary.
    const totalTokens = estimateTokens(
      this.messages.map((m) => m.content).join("\n"),
    );
    if (totalTokens <= CONTEXT_BUDGET) return false;

    const unsummarized = this.messagesAfterLastSummary();
    return unsummarized.length >= 4; // At least 2 turns of new content
  }

  buildIncrementalSummaryInput(): SummarizationInput | null {
    const unsummarized = this.messagesAfterLastSummary();
    if (unsummarized.length === 0) return null;

    return {
      existingSummary: this.summary,
      newMessages: unsummarized.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
  }

  /** Returns the id of the last message already covered by the summary. */
  lastSummarizedMessageId(): string {
    return this.lastSummarizedId;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private messagesAfterLastSummary(): Message[] {
    if (!this.lastSummarizedId) return this.messages;
    const idx = this.messages.findIndex((m) => m.messageId === this.lastSummarizedId);
    if (idx < 0) return this.messages;
    return this.messages.slice(idx + 1);
  }

  private messagePairs(): { role: string; content: string }[] {
    // Group consecutive user+assistant messages into pairs for budget allocation.
    // Each pair is a single unit — we don't split a user message from its reply.
    const pairs: { role: string; content: string }[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") {
        const userContent = this.messages[i].content;
        const assistantContent =
          i + 1 < this.messages.length && this.messages[i + 1].role === "assistant"
            ? "\n" + this.messages[i + 1].content
            : "";
        pairs.push({
          role: this.messages[i].role,
          content: userContent + assistantContent,
        });
        i += assistantContent ? 1 : 0;
      }
    }
    return pairs;
  }
}
