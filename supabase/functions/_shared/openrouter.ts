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

export type EveningDigestResult = {
  topics: string[];
  daySummary: string;
};

export type EveningReplyResult = {
  classification: "disengaged" | "crisis" | "brief" | "substantive";
  userReflection: string;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  repeatedTopic: string | null;
  insightText: string | null;
  closingText: string;
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

function parseJsonPayload<T>(rawText: string): T {
  const candidates = [
    stripCodeFence(rawText),
    extractJsonObject(rawText),
    sanitizeJsonLike(extractJsonObject(rawText)),
    sanitizeJsonLike(stripCodeFence(rawText)),
  ];

  let lastError: string | null = null;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `Failed to parse OpenRouter JSON payload: ${
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

async function callOpenRouterText(
  prompt: string,
  userContent: string,
  options: {
    maxTokens?: number;
    temperature?: number;
  } = {},
): Promise<string> {
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
        max_tokens: options.maxTokens ?? 800,
        temperature: options.temperature ?? 0.2,
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

    return rawText;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenRouter request timed out after 45 seconds");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

  const rawText = await callOpenRouterText(prompt, userContent);
  const parsed = parseAnalysisResult(rawText);
  return { result: parsed, rawText };
}

export async function summarizeEveningContext(input: {
  dateLabel: string;
  highlights: string[];
  openLoops: string[];
  activeProjects: string[];
  recentUserSignals: string[];
}): Promise<string> {
  const prompt = [
    "You write a genuinely human evening check-in message for a personal Telegram assistant.",
    "Write in Russian.",
    "Sound warm, grounded, tactful, and psychologically natural.",
    "Do not sound like a coach, manager, productivity app, therapist cliche, or AI assistant.",
    "The user should feel understood, not analyzed.",
    "Base the message only on the supplied context, but transform it into natural human language.",
    "Never quote raw command-like phrases such as notes, capture requests, shopping reminders, or terse inbox fragments.",
    "Prefer emotional and lived signals over todo-like fragments when both are available.",
    "Structure:",
    "1. one short opening line that gently reflects the texture of the day;",
    "2. one short line that names either something good or something still unresolved;",
    "3. three very short questions, each on its own line.",
    "The three questions should ask about:",
    "- what felt like the main result of the day;",
    "- what is still hanging in the air;",
    "- what the person wants to lean into tomorrow.",
    "Avoid over-specificity unless the context is clearly personal and lived.",
    "Do not mention systems, databases, Notion, prompts, or internal mechanics.",
    "Return only the final Russian text for the user.",
  ].join("\n");

  return await callOpenRouterText(prompt, JSON.stringify(input), {
    maxTokens: 280,
    temperature: 0.6,
  });
}

export async function buildEveningDigest(input: {
  dateLabel: string;
  messages: Array<{
    text: string;
    time: string;
  }>;
}): Promise<EveningDigestResult> {
  const prompt = [
    "You compress a user's day into a short evening digest for a personal Telegram assistant.",
    "Return strict JSON only.",
    'Schema: {"topics":["string"],"daySummary":"string"}',
    "Write in Russian.",
    "Topics should be short, human, and concrete, 1 to 4 items total.",
    "daySummary should be 1 or 2 short sentences, warm and factual.",
    "Use only what is actually present in the messages.",
    "Do not mention AI, prompts, databases, or analysis.",
  ].join("\n");

  const rawText = await callOpenRouterText(prompt, JSON.stringify(input), {
    maxTokens: 220,
    temperature: 0.25,
  });

  const parsed = parseJsonPayload<Partial<EveningDigestResult>>(rawText);
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 4)
    : [];
  const daySummary = typeof parsed.daySummary === "string"
    ? parsed.daySummary.trim()
    : "";

  if (!topics.length && !daySummary) {
    throw new Error("Empty evening digest");
  }

  return {
    topics,
    daySummary,
  };
}

export async function analyzeEveningReply(input: {
  daySummary: string;
  topics: string[];
  userReply: string;
  clarificationAlreadyAsked: boolean;
}): Promise<EveningReplyResult> {
  const prompt = [
    "You analyze a user's evening check-in reply for a personal Telegram assistant.",
    "Return strict JSON only.",
    'Schema: {"classification":"disengaged|crisis|brief|substantive","userReflection":"string","needsClarification":true,"clarificationQuestion":"string|null","repeatedTopic":"string|null","insightText":"string|null","closingText":"string"}',
    "Write all strings in Russian.",
    "The assistant should be warm, short, and psychologically careful.",
    "Use classification='disengaged' if the user does not want to continue.",
    "Use classification='crisis' if the reply sounds emotionally dangerous or crisis-like.",
    "Use classification='brief' if the reply is very short or too generic and one clarifying question would help.",
    "Use classification='substantive' if the answer is already meaningful enough.",
    "Set needsClarification=true only for classification='brief' and only if clarificationAlreadyAsked is false.",
    "clarificationQuestion must be only one short question.",
    "insightText is optional and should only appear when the same topic clearly repeats across the day summary and the evening reply.",
    "The insight must be observation plus question, not diagnosis or interpretation.",
    "closingText should fit the classification:",
    "- disengaged: a soft release, no pressure;",
    "- crisis: supportive and calm, suggest reaching out for help if needed;",
    "- substantive: thank them, optionally mention the repeated topic if present, and wish a good night;",
    "- brief with clarification: closingText should be empty.",
    "Do not invent facts.",
  ].join("\n");

  const rawText = await callOpenRouterText(prompt, JSON.stringify(input), {
    maxTokens: 320,
    temperature: 0.25,
  });

  const parsed = parseJsonPayload<Partial<EveningReplyResult>>(rawText);
  const classification =
    parsed.classification === "disengaged" || parsed.classification === "crisis" ||
      parsed.classification === "brief" || parsed.classification === "substantive"
      ? parsed.classification
      : "substantive";

  return {
    classification,
    userReflection: typeof parsed.userReflection === "string"
      ? parsed.userReflection.trim()
      : input.userReply.trim(),
    needsClarification: Boolean(parsed.needsClarification) &&
      classification === "brief" && !input.clarificationAlreadyAsked,
    clarificationQuestion: typeof parsed.clarificationQuestion === "string"
      ? parsed.clarificationQuestion.trim()
      : null,
    repeatedTopic: typeof parsed.repeatedTopic === "string"
      ? parsed.repeatedTopic.trim()
      : null,
    insightText: typeof parsed.insightText === "string"
      ? parsed.insightText.trim()
      : null,
    closingText: typeof parsed.closingText === "string"
      ? parsed.closingText.trim()
      : "",
  };
}

export async function summarizeWeeklyReview(input: {
  weekStartDate: string;
  weekEndDate: string;
  processedItems: Array<{
    summary: string | null;
    type: string | null;
    createdAt: string;
  }>;
  proposedEntities: Array<{
    entityType: string;
    title: string | null;
    summary: string | null;
  }>;
}): Promise<string> {
  const prompt = [
    "You prepare a weekly review message for a personal Telegram assistant.",
    "Write in Russian.",
    "Structure the message for Telegram with short sections.",
    "Cover: key events, progress, open loops, ideas/materials, and suggested priorities for next week.",
    "Do not invent facts.",
    "Return plain text only.",
  ].join("\n");

  return await callOpenRouterText(prompt, JSON.stringify(input), {
    maxTokens: 700,
    temperature: 0.35,
  });
}
