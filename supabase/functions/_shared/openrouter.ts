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
  agentReply?: string | null;
  decision?: "create" | "update" | "clarify";
  targetEntityId?: string | null;
};

function stripCodeFence(input: string): string {
  return input
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJsonObject(input: string): string {
  const trimmed = stripCodeFence(input);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function sanitizeJsonLike(input: string): string {
  return input
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

function extractStringField(input: string, field: string): string | undefined {
  const match = input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, "s"));
  return match?.[1];
}

function extractNullableStringField(
  input: string,
  field: string,
): string | null | undefined {
  if (new RegExp(`"${field}"\\s*:\\s*null`, "s").test(input)) {
    return null;
  }

  return extractStringField(input, field);
}

function extractNumberField(input: string, field: string): number | undefined {
  const match = input.match(
    new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "s"),
  );
  return match ? Number(match[1]) : undefined;
}

function extractObjectField(
  input: string,
  field: string,
): Record<string, unknown> | undefined {
  const startMatch = input.match(new RegExp(`"${field}"\\s*:\\s*\\{`, "s"));
  if (!startMatch || startMatch.index === undefined) {
    return undefined;
  }

  const braceStart = input.indexOf("{", startMatch.index);
  if (braceStart === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = braceStart; i < input.length; i++) {
    const char = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(input.slice(braceStart, i + 1)) as Record<
            string,
            unknown
          >;
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function recoverAnalysisResult(rawText: string): InboxAnalysisResult | null {
  const base = extractJsonObject(rawText);
  const classification = extractStringField(base, "classification");
  const summary = extractStringField(base, "summary");

  if (!classification || !summary) {
    return null;
  }

  const decision = extractNullableStringField(base, "decision");
  const targetEntityId = extractNullableStringField(base, "targetEntityId");

  return {
    classification,
    summary,
    confidence: extractNumberField(base, "confidence") ?? 0.5,
    suggestedTitle: extractNullableStringField(base, "suggestedTitle") ??
      undefined,
    suggestedEntityType:
      extractNullableStringField(base, "suggestedEntityType") ??
        undefined,
    suggestedPayload: extractObjectField(base, "suggestedPayload") ?? {},
    followUpQuestion: extractNullableStringField(base, "followUpQuestion"),
    agentReply: extractNullableStringField(base, "agentReply") ?? null,
    decision: decision === "update" || decision === "clarify" ||
        decision === "create"
      ? decision
      : "create",
    targetEntityId,
  };
}

function parseAnalysisResult(rawText: string): InboxAnalysisResult {
  const candidates = [
    stripCodeFence(rawText),
    extractJsonObject(rawText),
    sanitizeJsonLike(extractJsonObject(rawText)),
    sanitizeJsonLike(stripCodeFence(rawText)),
  ];

  let lastError: string | null = null;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as InboxAnalysisResult;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const recovered = recoverAnalysisResult(rawText);
  if (recovered) {
    return recovered;
  }

  throw new Error(
    `Failed to parse OpenRouter JSON response: ${
      lastError ?? "unknown error"
    }. Raw: ${rawText.slice(0, 500)}`,
  );
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
    "You classify personal inbox items for a personal life operating system and write a warm Telegram reply.",
    "Return strict JSON only.",
    'Schema: {"classification":"string","summary":"string","confidence":0.0,"suggestedTitle":"string|null","suggestedEntityType":"note|task|idea|goal|project|memory|finance|event|unknown","suggestedPayload":{},"followUpQuestion":"string|null","agentReply":"string|null","decision":"create|update|clarify","targetEntityId":"string|null"}',
    "Use Russian in summary, suggestedTitle, followUpQuestion, and agentReply.",
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
    "agentReply should sound natural, human, and concise, like a thoughtful assistant in Telegram.",
    "Avoid robotic labels like 'Тип' or 'Кратко' unless they genuinely help.",
    "For create: briefly acknowledge what was captured and optionally mention the next useful step.",
    "For update: say that you understood this as an update to the current goal/project and what changed.",
    "For clarify: agentReply should mainly be the clarification question.",
    "Keep agentReply short: one or two short sentences, no more than 220 characters.",
    "Do not mention JSON, schema, databases, Notion, Supabase, or internal processing.",
  ].join("\n");

  const userContent = JSON.stringify({
    contentType: input.contentType,
    text: input.text ?? null,
    relatedEntities: input.relatedEntities ?? [],
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 45000);

  try {
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
      signal: abortController.signal,
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

    const parsed = parseAnalysisResult(rawText);
    return { result: parsed, rawText };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenRouter request timed out after 45 seconds");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
