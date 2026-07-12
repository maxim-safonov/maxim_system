import { readOptionalEnv, requireEnv } from "./env.ts";

const openrouterApiKey = requireEnv("OPENROUTER_API_KEY");
const openrouterBaseUrl = readOptionalEnv(
  "OPENROUTER_BASE_URL",
  "https://openrouter.ai/api/v1",
)!;
const openrouterModel = readOptionalEnv(
  "OPENROUTER_MODEL",
  "openai/gpt-4.1-mini",
)!;

export type InboxAnalysisResult = {
  classification: string;
  summary: string;
  confidence: number;
  suggestedTitle?: string;
  suggestedEntityType?: string;
  suggestedPayload?: Record<string, unknown>;
  followUpQuestion?: string | null;
  decision?: "create" | "update" | "clarify";
  targetEntityId?: string | null;
};

function stripCodeFence(input: string): string {
  return input
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractMessageContent(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = (message as { content?: unknown }).content;
  if (typeof candidate === "string") {
    return candidate.trim() || null;
  }

  if (Array.isArray(candidate)) {
    const joined = candidate
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }

        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          return text;
        }

        const nested = (part as { text?: { value?: unknown } }).text;
        if (
          nested && typeof nested === "object" &&
          typeof nested.value === "string"
        ) {
          return nested.value;
        }

        return "";
      })
      .join("")
      .trim();

    return joined || null;
  }

  return null;
}

export function getOpenRouterModel(): string {
  return openrouterModel;
}

export async function classifyInboxItem(input: {
  contentType: string;
  text?: string | null;
  relatedEntities?: Array<{
    id: string;
    entityType: string;
    title?: string | null;
    summary?: string | null;
    payload?: Record<string, unknown> | null;
  }>;
}): Promise<{
  result: InboxAnalysisResult;
  rawText: string;
}> {
  const prompt = [
    "You classify personal inbox items for a personal life operating system.",
    "Return strict JSON only.",
    'Schema: {"classification":"string","summary":"string","confidence":0.0,"suggestedTitle":"string|null","suggestedEntityType":"note|task|idea|goal|project|memory|finance|event|unknown","suggestedPayload":{},"followUpQuestion":"string|null","decision":"create|update|clarify","targetEntityId":"string|null"}',
    "Use Russian in summary, suggestedTitle, and followUpQuestion.",
    "Do not invent facts that are not present in the message.",
    "Use 'goal' when the message describes a desired future outcome or aspiration over time.",
    "Use 'project' when the message describes a multi-step initiative, workstream, or concrete undertaking.",
    "Use 'task' only for a single actionable item.",
    "Use 'note' for plain information that should just be remembered.",
    "For goal/project/task, include useful suggestedPayload fields when possible, such as area, horizon, desired_outcome, next_step, or status.",
    "Write all user-facing text and all string values inside suggestedPayload in Russian.",
    "If the new message is clearly a continuation, refinement, or clarification of an existing goal or project from the provided relatedEntities list, use decision='update' and set targetEntityId to the matching entity id.",
    "If the message could refer to more than one existing goal/project, or if the intent is unclear, use decision='clarify' and ask one short human follow-up question in Russian.",
    "If this is clearly a new independent item, use decision='create' and targetEntityId=null.",
    "When using decision='update', do not create a duplicate. Reuse the existing entity and provide only the refreshed summary/title/payload that should replace or enrich it.",
    "Only use targetEntityId values that appear in relatedEntities. Otherwise return null.",
  ].join("\n");

  const userContent = JSON.stringify({
    contentType: input.contentType,
    text: input.text ?? null,
    relatedEntities: input.relatedEntities ?? [],
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
    throw new Error(
      `OpenRouter API error: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  const rawText = extractMessageContent(body?.choices?.[0]?.message);
  if (!rawText) {
    throw new Error("OpenRouter API returned empty content");
  }

  const parsed = JSON.parse(stripCodeFence(rawText)) as InboxAnalysisResult;
  return { result: parsed, rawText };
}
