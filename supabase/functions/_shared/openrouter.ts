import { readOptionalEnv, requireEnv } from "./env.ts";

const openrouterApiKey = requireEnv("OPENROUTER_API_KEY");
const openrouterBaseUrl = readOptionalEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")!;
const openrouterModel = readOptionalEnv("OPENROUTER_MODEL", "openai/gpt-4.1-mini")!;

export type InboxAnalysisResult = {
  classification: string;
  summary: string;
  confidence: number;
  suggestedTitle?: string;
  suggestedEntityType?: string;
  suggestedPayload?: Record<string, unknown>;
  followUpQuestion?: string | null;
};

function stripCodeFence(input: string): string {
  return input
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function getOpenRouterModel(): string {
  return openrouterModel;
}

export async function classifyInboxItem(input: {
  contentType: string;
  text?: string | null;
}): Promise<{
  result: InboxAnalysisResult;
  rawText: string;
}> {
  const prompt = [
    "You classify personal inbox items for a personal life operating system.",
    "Return strict JSON only.",
    'Schema: {"classification":"string","summary":"string","confidence":0.0,"suggestedTitle":"string|null","suggestedEntityType":"note|task|idea|goal|project|memory|finance|event|unknown","suggestedPayload":{},"followUpQuestion":"string|null"}',
    "Use Russian in summary, suggestedTitle, and followUpQuestion.",
    "Do not invent facts that are not present in the message.",
  ].join("\n");

  const userContent = JSON.stringify({
    contentType: input.contentType,
    text: input.text ?? null,
  });

  const response = await fetch(`${openrouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openrouterApiKey}`,
      "http-referer": "https://life-os.local",
      "x-title": "Life OS",
    },
    body: JSON.stringify({
      model: openrouterModel,
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${JSON.stringify(body)}`);
  }

  const rawText = body?.choices?.[0]?.message?.content;
  if (!rawText || typeof rawText !== "string") {
    throw new Error("OpenRouter API returned empty content");
  }

  const parsed = JSON.parse(stripCodeFence(rawText)) as InboxAnalysisResult;
  return { result: parsed, rawText };
}
