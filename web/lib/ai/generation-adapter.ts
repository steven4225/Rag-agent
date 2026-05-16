import { generateText, streamText, type ModelMessage } from "ai";

export function resolveChatModel() {
  return process.env.RAGENT_CHAT_MODEL ?? process.env.AI_MODEL ?? "openai/gpt-4o-mini";
}

export function resolveChatModels(): string[] {
  const primary = resolveChatModel();
  const fallbacks = (process.env.RAGENT_CHAT_MODEL_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...fallbacks];
}

export function shouldUseLocalGeneration() {
  if ((process.env.RAGENT_FORCE_LOCAL_GENERATION ?? "").trim().toLowerCase() === "true") {
    return true;
  }

  const providerKeys = [
    process.env.OPENAI_API_KEY,
    process.env.AI_GATEWAY_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.ANTHROPIC_API_KEY
  ];

  return providerKeys.every((value) => !value);
}

function buildLocalAssistantText(messages: ModelMessage[]) {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const prompt =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : "the latest request";
  const groundingMessage = messages.find(
    (message) => message.role === "system" && typeof message.content === "string" && message.content.includes("Grounding context for this answer:")
  );
  const groundingPreview =
    typeof groundingMessage?.content === "string"
      ? groundingMessage.content
          .replace("Grounding context for this answer:", "")
          .trim()
          .split("\n")
          .find((line) => line.trim().length > 0) ?? null
      : null;

  const lines = [
    "Local debug generation is active because no remote model credentials were detected.",
    `The chat route completed successfully for: ${prompt}`,
    "Use the retrieval metadata on this message and the trace records to verify the TS -> retrieval boundary behavior."
  ];

  if (groundingPreview) {
    lines.push(`Grounding preview: ${groundingPreview}`);
  } else {
    lines.push("Grounding preview: none");
  }

  return lines.join("\n");
}

type GenerationInput = {
  messages: ModelMessage[];
};

export async function generateAssistantText(input: GenerationInput) {
  if (shouldUseLocalGeneration()) {
    return {
      text: buildLocalAssistantText(input.messages),
      model: "local-debug-generator"
    };
  }

  const model = resolveChatModel();
  const result = await generateText({
    model,
    messages: input.messages,
    temperature: 0.2
  });

  return {
    text: result.text.trim(),
    model
  };
}

export function streamAssistantText(input: GenerationInput) {
  if (shouldUseLocalGeneration()) {
    const text = buildLocalAssistantText(input.messages);
    const chunks = text.match(/.{1,48}/g) ?? [text];

    return {
      result: {
        textStream: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      },
      model: "local-debug-generator"
    };
  }

  const model = resolveChatModel();
  const result = streamText({
    model,
    messages: input.messages,
    temperature: 0.2
  });

  return {
    result,
    model
  };
}
