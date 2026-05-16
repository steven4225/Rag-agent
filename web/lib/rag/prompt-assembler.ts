import type { PromptArtifact } from "@/lib/rag/types";

const BASE_SYSTEM_PROMPT =
  "You are the TS orchestration layer for an enterprise RAG product. Ground answers in provided evidence, separate tool evidence from knowledge evidence, and keep the Go execution boundary replaceable.";

const SCENE_INSTRUCTIONS: Record<PromptArtifact["scene"], string> = {
  direct: "No external evidence is available. Answer conservatively and state uncertainty when needed.",
  kb: "Use knowledge-base evidence first and avoid inventing unsupported details.",
  mcp: "Use tool / MCP evidence first and describe it as live or operational context when relevant.",
  mixed: "Blend knowledge-base evidence with tool / MCP evidence and make their sources distinguishable."
};

export function assemblePrompt(input: {
  scene: PromptArtifact["scene"];
  userMessage: string;
  rewrittenQuery: string;
  kbContext: string;
  toolContext: string;
}): PromptArtifact {
  const sections = [
    `Rewrite query: ${input.rewrittenQuery}`,
    input.kbContext ? `Knowledge context:\n${input.kbContext}` : "",
    input.toolContext ? `Tool context:\n${input.toolContext}` : ""
  ].filter(Boolean);

  return {
    scene: input.scene,
    systemPrompt: `${BASE_SYSTEM_PROMPT}\n\nScene: ${input.scene}\n${SCENE_INSTRUCTIONS[input.scene]}`,
    userPrompt: input.userMessage,
    sections
  };
}
