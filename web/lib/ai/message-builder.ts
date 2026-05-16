import type { ModelMessage } from "ai";

import type { RagHistoryMessage } from "@/lib/rag/types";
import type { PromptArtifact } from "@/lib/rag/types";

function normalizeHistory(history: RagHistoryMessage[]) {
  return history.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function buildContextMessage(prompt: PromptArtifact) {
  if (prompt.sections.length === 0) {
    return null;
  }

  return {
    role: "system" as const,
    content: `Grounding context for this answer:\n\n${prompt.sections.join("\n\n")}`
  };
}

export function buildModelMessages(input: {
  prompt: PromptArtifact;
  history: RagHistoryMessage[];
  summary?: string;
}): ModelMessage[] {
  const messages: ModelMessage[] = [];

  if (input.prompt.systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: input.prompt.systemPrompt
    });
  }

  if (input.summary) {
    messages.push({
      role: "system",
      content: input.summary
    });
  }

  const contextMessage = buildContextMessage(input.prompt);
  if (contextMessage) {
    messages.push(contextMessage);
  }

  messages.push(...normalizeHistory(input.history));
  messages.push({
    role: "user",
    content: input.prompt.userPrompt
  });

  return messages;
}
