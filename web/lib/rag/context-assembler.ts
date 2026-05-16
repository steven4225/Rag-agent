import type { RetrievalChunk, ToolCall } from "@/lib/contracts";
import type { AssembledContext } from "@/lib/rag/types";

function buildKbContext(chunks: RetrievalChunk[]) {
  if (chunks.length === 0) {
    return "";
  }

  return chunks
    .map(
      (chunk, index) =>
        `${index + 1}. [${chunk.knowledgeBaseId}] ${chunk.title}\n${chunk.content}\nscore=${chunk.score.toFixed(2)}`
    )
    .join("\n\n");
}

function buildToolContext(toolCalls: ToolCall[]) {
  if (toolCalls.length === 0) {
    return "";
  }

  return toolCalls
    .map((toolCall, index) => {
      const summary =
        typeof toolCall.output === "object" && toolCall.output && "summary" in toolCall.output
          ? String(toolCall.output.summary)
          : "tool output placeholder";
      return `${index + 1}. ${toolCall.toolName}\nargs=${JSON.stringify(toolCall.args)}\n${summary}`;
    })
    .join("\n\n");
}

export function assembleContext(input: {
  evidence: RetrievalChunk[];
  toolCalls: ToolCall[];
}): AssembledContext {
  const kbContext = buildKbContext(input.evidence);
  const toolContext = buildToolContext(input.toolCalls);

  let scene: AssembledContext["scene"] = "direct";
  if (kbContext && toolContext) {
    scene = "mixed";
  } else if (kbContext) {
    scene = "kb";
  } else if (toolContext) {
    scene = "mcp";
  }

  return {
    scene,
    kbContext,
    toolContext,
    evidence: input.evidence
  };
}
