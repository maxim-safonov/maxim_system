import { readOptionalEnv, requireEnv } from "../_shared/env.ts";
import {
  DailySessionRecord,
  EveningSessionMetadata,
  EveningInsightCandidate,
  syncEveningSessionToNotion,
} from "../_shared/evening.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import {
  jsonResponse,
  methodNotAllowed,
  serverError,
} from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import {
  callRpc,
  getRows,
  insertRow,
  updateRows,
} from "../_shared/supabase.ts";
import {
  analyzeEveningReply,
  classifyInboxItem,
  getOpenRouterModel,
} from "../_shared/openrouter.ts";
import {
  downloadTelegramFile,
  sendTelegramMessage,
} from "../_shared/telegram.ts";
import { uploadObject } from "../_shared/storage.ts";
import { getLocalDateString } from "../_shared/time.ts";

const openrouterBaseUrl = readOptionalEnv(
  "OPENROUTER_BASE_URL",
  "https://openrouter.ai/api/v1",
);
const openrouterModel = readOptionalEnv(
  "OPENROUTER_MODEL",
  "openai/gpt-4.1-mini",
);
const retryBaseSeconds = Number(
  readOptionalEnv("PROCESS_INBOX_RETRY_BASE_SECONDS", "60"),
);
requireEnv("OPENROUTER_API_KEY");

type ClaimedJob = {
  id: string;
  inbox_item_id: string;
  job_type: string;
  attempt_count: number;
  payload: Record<string, unknown> | null;
  correlation_id: string;
};

type ProcessingJobState = {
  id: string;
  attempt_count: number;
  max_attempts: number;
};

type InboxItem = {
  id: string;
  content_type: string;
  original_text: string | null;
  external_chat_id: string | null;
  created_at: string;
};

type InboxAttachment = {
  id: string;
  attachment_type: string;
  telegram_file_id: string | null;
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  file_name: string | null;
  downloaded_at: string | null;
  last_download_error: string | null;
};

type RelatedEntity = {
  id: string;
  entity_type: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  notion_page_id?: string | null;
  revision?: number;
};

type DailySession = DailySessionRecord;

type NormalizedAnalysis = ReturnType<typeof normalizeAnalysisDecision>;
type SanitizedAnalysisResult = ReturnType<typeof sanitizeAnalysisResult>;

function humanizeEntityType(entityType?: string | null): string {
  switch (entityType) {
    case "goal":
      return "цель";
    case "project":
      return "проект";
    case "task":
      return "задача";
    case "idea":
      return "идея";
    case "memory":
      return "воспоминание";
    case "note":
      return "заметка";
    default:
      return "запись";
  }
}

function buildAgentReply(input: {
  decision?: "create" | "update" | "clarify";
  entityType?: string | null;
  title?: string | null;
  targetTitle?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
  followUpQuestion?: string | null;
}): string {
  const lines: string[] = [];
  const typeLabel = humanizeEntityType(input.entityType);

  if (input.decision === "clarify") {
    lines.push(input.followUpQuestion ?? "Хочу уточнить один момент.");
  } else if (input.decision === "update") {
    lines.push(`Понял это как уточнение к текущей сущности: ${typeLabel}.`);
    if (input.targetTitle) {
      lines.push(`Обновляю: ${input.targetTitle}`);
    }
  } else if (
    input.entityType === "goal" || input.entityType === "project" ||
    input.entityType === "task"
  ) {
    lines.push(`Зафиксировал как ${typeLabel}.`);
  } else {
    lines.push(`Сохранил как ${typeLabel}.`);
  }

  if (input.title) {
    lines.push(`Название: ${input.title}`);
  }

  if (input.decision !== "clarify") {
    lines.push(`Кратко: ${input.summary}`);
  }

  const nextStep = input.payload?.next_step;
  if (typeof nextStep === "string" && nextStep.trim()) {
    lines.push(`Следующий шаг: ${nextStep.trim()}`);
  }

  const desiredOutcome = input.payload?.desired_outcome;
  if (
    typeof desiredOutcome === "string" && desiredOutcome.trim() &&
    input.entityType === "goal"
  ) {
    lines.push(`Ожидаемый результат: ${desiredOutcome.trim()}`);
  }

  if (input.followUpQuestion && input.decision !== "clarify") {
    lines.push(input.followUpQuestion);
  }

  return lines.join("\n");
}

function pickTelegramReply(input: {
  llmReply?: string | null;
  decision?: "create" | "update" | "clarify";
  entityType?: string | null;
  title?: string | null;
  targetTitle?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
  followUpQuestion?: string | null;
}): string {
  const llmReply = input.llmReply?.trim();
  if (llmReply) {
    return llmReply;
  }

  return buildAgentReply({
    decision: input.decision,
    entityType: input.entityType,
    title: input.title,
    targetTitle: input.targetTitle,
    summary: input.summary,
    payload: input.payload,
    followUpQuestion: input.followUpQuestion,
  });
}

function mergePayload(
  existingPayload: Record<string, unknown> | null | undefined,
  incomingPayload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(existingPayload ?? {}),
    ...(incomingPayload ?? {}),
  };
}

function isPlaceholderValue(value?: string | null): boolean {
  if (!value) {
    return false;
  }

  return [
    "string",
    "string|null",
    "create|update|clarify",
    "note|task|idea|goal|project|memory|finance|event|unknown",
  ].includes(value.trim());
}

function inferEntityTypeFromText(text?: string | null): string {
  if (!text) {
    return "note";
  }

  if (/\bпроект\b/i.test(text)) {
    return "project";
  }

  if (/\bзадач[аеиу]\b/i.test(text)) {
    return "task";
  }

  if (/\bцель\b/i.test(text) || /\bхочу\b/i.test(text)) {
    return "goal";
  }

  return "note";
}

function sanitizeAnalysisResult(input: {
  result: Awaited<ReturnType<typeof classifyInboxItem>>["result"];
  originalText?: string | null;
}): {
  classification: string;
  summary: string;
  confidence: number;
  suggestedTitle?: string | null;
  suggestedEntityType?: string | null;
  suggestedPayload?: Record<string, unknown>;
  followUpQuestion?: string | null;
  agentReply?: string | null;
  decision?: "create" | "update" | "clarify";
  targetEntityId?: string | null;
} {
  const fallbackSummary = input.originalText?.trim() ||
    "Новая запись пользователя";
  const fallbackType = !isPlaceholderValue(input.result.suggestedEntityType)
    ? input.result.suggestedEntityType
    : !isPlaceholderValue(input.result.classification)
    ? input.result.classification
    : inferEntityTypeFromText(input.originalText);

  return {
    classification: !isPlaceholderValue(input.result.classification)
      ? input.result.classification
      : fallbackType ?? "note",
    summary: !isPlaceholderValue(input.result.summary)
      ? input.result.summary
      : fallbackSummary,
    confidence: input.result.confidence ?? 0.5,
    suggestedTitle: !isPlaceholderValue(input.result.suggestedTitle)
      ? input.result.suggestedTitle ?? null
      : null,
    suggestedEntityType: !isPlaceholderValue(input.result.suggestedEntityType)
      ? input.result.suggestedEntityType ?? null
      : fallbackType ?? "note",
    suggestedPayload: input.result.suggestedPayload ?? {},
    followUpQuestion: !isPlaceholderValue(input.result.followUpQuestion)
      ? input.result.followUpQuestion ?? null
      : null,
    agentReply: !isPlaceholderValue(input.result.agentReply)
      ? input.result.agentReply ?? null
      : null,
    decision: input.result.decision === "create" ||
        input.result.decision === "update" ||
        input.result.decision === "clarify"
      ? input.result.decision
      : undefined,
    targetEntityId: !isPlaceholderValue(input.result.targetEntityId)
      ? input.result.targetEntityId ?? null
      : null,
  };
}

function hasUpdateCue(text?: string | null): boolean {
  if (!text) {
    return false;
  }

  return /\b(добавь|дополни|уточни|уточню|обнови|исправь|измени|поменяй|скорректируй)\b/i
    .test(text);
}

function tokenizeText(text?: string | null): string[] {
  if (!text) {
    return [];
  }

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function entitySearchText(entity: RelatedEntity): string {
  return [
    entity.title ?? "",
    entity.summary ?? "",
    JSON.stringify(entity.payload ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}

function chooseUpdateTarget(
  text: string | null | undefined,
  entityType: string | null | undefined,
  relatedEntities: RelatedEntity[],
): RelatedEntity | null {
  const tokens = tokenizeText(text);
  const candidates = relatedEntities.filter((entity) =>
    entity.entity_type === "goal" || entity.entity_type === "project"
  ).filter((entity) => !entityType || entity.entity_type === entityType);

  if (!candidates.length) {
    return null;
  }

  const scored = candidates.map((entity, index) => {
    const haystack = entitySearchText(entity);
    const overlap = tokens.reduce((score, token) => {
      return haystack.includes(token) ? score + 1 : score;
    }, 0);

    return {
      entity,
      overlap,
      index,
    };
  }).sort((left, right) => {
    if (right.overlap !== left.overlap) {
      return right.overlap - left.overlap;
    }

    return left.index - right.index;
  });

  const best = scored[0];
  if (!best) {
    return null;
  }

  if (best.overlap >= 1) {
    return best.entity;
  }

  if (hasUpdateCue(text) && scored.length === 1) {
    return best.entity;
  }

  return null;
}

function normalizeAnalysisDecision(input: {
  text?: string | null;
  result: SanitizedAnalysisResult;
  relatedEntities: RelatedEntity[];
}): {
  decision: "create" | "update" | "clarify";
  targetEntityId: string | null;
} {
  if (input.result.decision === "update" && input.result.targetEntityId) {
    return {
      decision: "update",
      targetEntityId: input.result.targetEntityId,
    };
  }

  const suggestedType = input.result.suggestedEntityType;
  const looksLikeUpdate = hasUpdateCue(input.text) ||
    input.result.classification === "goal_update" ||
    input.result.classification === "project_update";

  if (!looksLikeUpdate) {
    return {
      decision: input.result.decision ?? "create",
      targetEntityId: input.result.targetEntityId ?? null,
    };
  }

  const target = chooseUpdateTarget(
    input.text,
    suggestedType,
    input.relatedEntities,
  );

  if (target) {
    return {
      decision: "update",
      targetEntityId: target.id,
    };
  }

  return {
    decision: input.result.decision ?? "create",
    targetEntityId: input.result.targetEntityId ?? null,
  };
}

function buildFallbackAnalysis(input: {
  text?: string | null;
  relatedEntities: RelatedEntity[];
}): Awaited<ReturnType<typeof classifyInboxItem>>["result"] {
  const text = input.text?.trim() ?? "";
  const target = chooseUpdateTarget(text, undefined, input.relatedEntities);

  if (hasUpdateCue(text) && target) {
    return {
      classification: `${target.entity_type}_update`,
      summary: text || "Пользователь прислал уточнение к существующей записи",
      confidence: 0.35,
      suggestedTitle: target.title ?? undefined,
      suggestedEntityType: target.entity_type,
      suggestedPayload: {},
      followUpQuestion: null,
      agentReply: `Понял, это уточнение к текущей записи${
        target.title ? ` «${target.title}»` : ""
      }.`,
      decision: "update",
      targetEntityId: target.id,
    };
  }

  if (hasUpdateCue(text)) {
    return {
      classification: "clarify",
      summary: text || "Нужно уточнение",
      confidence: 0.3,
      suggestedTitle: undefined,
      suggestedEntityType: "note",
      suggestedPayload: {},
      followUpQuestion:
        "Уточни, пожалуйста, к какой именно цели или проекту это добавить?",
      agentReply:
        "Уточни, пожалуйста, к какой именно цели или проекту это добавить?",
      decision: "clarify",
      targetEntityId: null,
    };
  }

  if (/\bпроект\b/i.test(text)) {
    return {
      classification: "project",
      summary: text || "Новый проект",
      confidence: 0.3,
      suggestedTitle: undefined,
      suggestedEntityType: "project",
      suggestedPayload: {},
      followUpQuestion: null,
      agentReply: "Зафиксировал это как проект.",
      decision: "create",
      targetEntityId: null,
    };
  }

  if (/\bцель\b/i.test(text) || /\bхочу\b/i.test(text)) {
    return {
      classification: "goal",
      summary: text || "Новая цель",
      confidence: 0.3,
      suggestedTitle: undefined,
      suggestedEntityType: "goal",
      suggestedPayload: {},
      followUpQuestion: null,
      agentReply: "Зафиксировал это как цель.",
      decision: "create",
      targetEntityId: null,
    };
  }

  return {
    classification: "note",
    summary: text || "Новая заметка",
    confidence: 0.25,
    suggestedTitle: undefined,
    suggestedEntityType: "note",
    suggestedPayload: {},
    followUpQuestion: null,
    agentReply: "Сохранил это как заметку.",
    decision: "create",
    targetEntityId: null,
  };
}

function buildAttachmentContext(attachments: InboxAttachment[]): string | null {
  if (!attachments.length) {
    return null;
  }

  const labels = attachments.map((attachment) => {
    const name = attachment.file_name?.trim();
    if (name) {
      return `${attachment.attachment_type}: ${name}`;
    }

    return attachment.attachment_type;
  });

  return `Входящее сообщение без текста. Вложения: ${labels.join(", ")}.`;
}

function countWords(value?: string | null): number {
  return (value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function normalizeText(value?: string | null): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function looksLikeDisengagedReply(value?: string | null): boolean {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return true;
  }

  return [
    "не хочу",
    "не сейчас",
    "потом",
    "не знаю",
    "без комментариев",
    "отстань",
    "не буду",
  ].some((marker) => text.includes(marker));
}

function looksLikeCrisisReply(value?: string | null): boolean {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return false;
  }

  return [
    "не хочу жить",
    "хочу умереть",
    "всё бессмысленно",
    "не вижу смысла",
    "хочу исчезнуть",
    "очень плохо",
    "паника",
  ].some((marker) => text.includes(marker));
}

function looksLikeClarificationAboutQuestion(value?: string | null): boolean {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return false;
  }

  return [
    "ты про что",
    "про что ты",
    "что ты имеешь в виду",
    "что ты имеешь ввиду",
    "что именно ты имеешь в виду",
    "в смысле",
    "не понял вопрос",
    "не понял, о чем ты",
    "о чем ты",
    "какую неясность",
  ].some((marker) => text.includes(marker));
}

function buildClarificationExplanation(input: {
  topics: string[];
  userReflection?: string | null;
  clarificationQuestion?: string | null;
}): string {
  const baseReflection = normalizeText(input.userReflection);
  const topic = input.topics[0];

  if (topic === "неясность" || input.clarificationQuestion?.toLowerCase().includes("неясност")) {
    if (baseReflection) {
      return `Я про тот момент, где у тебя осталось ощущение, что что-то нужно делать, но пока непонятно что именно. Если коротко: что там сейчас ощущается самым подвешенным?`;
    }

    return "Я имею в виду тот момент, где как будто есть незакрытый вопрос, но пока нет ясного следующего шага. Что там сейчас ощущается самым подвешенным?";
  }

  if (topic === "свидание") {
    return "Я про тему свидания: там сейчас больше всего вопрос в чувствах, в следующем шаге или просто в общей неопределённости?";
  }

  if (topic === "работа") {
    return "Я про рабочую часть дня: что там осталось самым тяжёлым или незавершённым для тебя?";
  }

  return "Я имею в виду ту часть дня, которая для тебя осталась не до конца понятной или незавершённой. Если коротко, что там сейчас главное?";
}

function buildFallbackEveningReply(input: {
  daySummary: string;
  topics: string[];
  userReply: string;
  clarificationAlreadyAsked: boolean;
}) {
  const normalizedReply = normalizeText(input.userReply);
  const repeatedTopic = input.topics.find((topic) =>
    normalizedReply.toLowerCase().includes(topic.toLowerCase())
  ) ?? null;

  if (looksLikeCrisisReply(normalizedReply)) {
    return {
      classification: "crisis" as const,
      userReflection: normalizedReply,
      needsClarification: false,
      clarificationQuestion: null,
      repeatedTopic,
      insightText: null,
      closingText:
        "Похоже, тебе сейчас правда очень тяжело. Если станет совсем небезопасно оставаться с этим одному, пожалуйста, свяжись с близким человеком или с местной службой поддержки прямо сейчас.",
    };
  }

  if (looksLikeDisengagedReply(normalizedReply)) {
    return {
      classification: "disengaged" as const,
      userReflection: normalizedReply,
      needsClarification: false,
      clarificationQuestion: null,
      repeatedTopic,
      insightText: null,
      closingText: "Ок, не буду давить. Отдохни, я рядом, если захочешь вернуться к этому завтра.",
    };
  }

  if (countWords(normalizedReply) < 15 && !input.clarificationAlreadyAsked) {
    return {
      classification: "brief" as const,
      userReflection: normalizedReply,
      needsClarification: true,
      clarificationQuestion: repeatedTopic
        ? `Что в теме ${repeatedTopic} было для тебя самым важным лично сегодня?`
        : "Что из этого было самым важным лично для тебя?",
      repeatedTopic,
      insightText: null,
      closingText: "",
    };
  }

  return {
    classification: "substantive" as const,
    userReflection: normalizedReply,
    needsClarification: false,
    clarificationQuestion: null,
    repeatedTopic,
    insightText: repeatedTopic
      ? `Смотрю, тема ${repeatedTopic} сегодня всплывала не раз. Это что-то, к чему стоит вернуться отдельно, как думаешь?`
      : null,
    closingText: repeatedTopic
      ? `Спасибо, что поделился. Сохранил это; если завтра захочешь вернуться к теме ${repeatedTopic}, я напомню. Доброй ночи.`
      : "Спасибо, что поделился. Сохранил это. Доброй ночи.",
  };
}

async function findActiveEveningSession(
  chatId: string,
  createdAt: string,
): Promise<DailySession | null> {
  const sessionDate = getLocalDateString(new Date(createdAt));
  const sessions = await getRows<DailySession>("daily_sessions", {
    session_date: `eq.${sessionDate}`,
    chat_id: `eq.${chatId}`,
    select:
      "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
    limit: 1,
  });

  const session = sessions[0];
  if (!session?.sent_at || session.responded_at) {
    return null;
  }

  if (new Date(createdAt).getTime() <= new Date(session.sent_at).getTime()) {
    return null;
  }

  return session;
}

async function handleEveningReply(input: {
  session: DailySession;
  inboxItem: InboxItem;
  textForAnalysis: string;
  correlationId: string;
}): Promise<{
  consumed: boolean;
  summary: string;
  classification: string;
}> {
  const normalizedText = normalizeText(input.textForAnalysis);
  if (!normalizedText || input.inboxItem.content_type !== "text") {
    return {
      consumed: false,
      summary: "",
      classification: "",
    };
  }

  const metadata = (input.session.metadata ?? {}) as EveningSessionMetadata;
  const clarificationAlreadyAsked = Boolean(metadata.clarificationAsked);

  let replyPlan;
  try {
    replyPlan = await analyzeEveningReply({
      daySummary: metadata.daySummary ?? input.session.summary_text ?? "",
      topics: metadata.topics ?? [],
      userReply: normalizedText,
      clarificationAlreadyAsked,
    });
  } catch (error) {
    logWarn("process_inbox_evening_reply_fallback_used", {
      correlationId: input.correlationId,
      sessionId: input.session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    replyPlan = buildFallbackEveningReply({
      daySummary: metadata.daySummary ?? input.session.summary_text ?? "",
      topics: metadata.topics ?? [],
      userReply: normalizedText,
      clarificationAlreadyAsked,
    });
  }

  const insightCandidates: EveningInsightCandidate[] = metadata.insightCandidates ?? [];
  if (replyPlan.insightText) {
    insightCandidates.push({
      text: replyPlan.insightText,
      topic: replyPlan.repeatedTopic,
      confirmed_by_user: false,
    });
  }

  if (
    clarificationAlreadyAsked &&
    looksLikeClarificationAboutQuestion(normalizedText)
  ) {
    const explanation = buildClarificationExplanation({
      topics: metadata.topics ?? [],
      userReflection: metadata.userReflection,
      clarificationQuestion: metadata.clarificationQuestion ?? null,
    });

    await sendTelegramMessage(input.inboxItem.external_chat_id!, explanation);

    const updatedMetadata: EveningSessionMetadata = {
      ...metadata,
      stage: "awaiting_clarification",
      clarificationReply: normalizedText,
      clarificationReplySourceId: input.inboxItem.id,
    };

    const updatedRows = await updateRows<DailySession>(
      "daily_sessions",
      { id: `eq.${input.session.id}` },
      {
        status: "clarifying",
        source_inbox_item_id: input.inboxItem.id,
        metadata: updatedMetadata,
      },
      {
        select:
          "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
      },
    );

    const updatedSession = updatedRows[0] ?? {
      ...input.session,
      status: "clarifying",
      source_inbox_item_id: input.inboxItem.id,
      metadata: updatedMetadata,
    };

    const notionSync = await syncEveningSessionToNotion({
      session: updatedSession,
      userVisibleSummary: metadata.daySummary ?? input.session.summary_text ?? "Вечерний чек-ин",
      updateSummary: "Пользователь попросил пояснить уточняющий вопрос",
      updateText: normalizedText,
      updateSourceId: input.inboxItem.id,
    });

    await updateRows(
      "daily_sessions",
      { id: `eq.${input.session.id}` },
      {
        notion_page_id: notionSync.notionPageId,
        notion_synced_at: notionSync.notionSyncedAt,
        notion_last_error: notionSync.notionLastError,
      },
    );

    return {
      consumed: true,
      summary: normalizedText,
      classification: "evening_dialog_clarification_explained",
    };
  }

  if (replyPlan.needsClarification && replyPlan.clarificationQuestion) {
    await sendTelegramMessage(input.inboxItem.external_chat_id!, replyPlan.clarificationQuestion);

    const updatedMetadata: EveningSessionMetadata = {
      ...metadata,
      stage: "awaiting_clarification",
      clarificationAsked: true,
      clarificationQuestion: replyPlan.clarificationQuestion,
      userReflection: replyPlan.userReflection,
      userReflectionSourceId: input.inboxItem.id,
      insightCandidates,
    };

    const updatedRows = await updateRows<DailySession>(
      "daily_sessions",
      { id: `eq.${input.session.id}` },
      {
        status: "clarifying",
        source_inbox_item_id: input.inboxItem.id,
        metadata: updatedMetadata,
      },
      {
        select:
          "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
      },
    );

    const updatedSession = updatedRows[0] ?? {
      ...input.session,
      status: "clarifying",
      metadata: updatedMetadata,
      source_inbox_item_id: input.inboxItem.id,
    };

    const notionSync = await syncEveningSessionToNotion({
      session: updatedSession,
      userVisibleSummary: metadata.daySummary ?? input.session.summary_text ?? "Вечерний чек-ин",
      updateSummary: "Пользователь ответил коротко, задан один уточняющий вопрос",
      updateText: replyPlan.userReflection,
      updateSourceId: input.inboxItem.id,
    });

    await updateRows(
      "daily_sessions",
      { id: `eq.${input.session.id}` },
      {
        notion_page_id: notionSync.notionPageId,
        notion_synced_at: notionSync.notionSyncedAt,
        notion_last_error: notionSync.notionLastError,
      },
    );

    return {
      consumed: true,
      summary: replyPlan.userReflection,
      classification: "evening_dialog_brief",
    };
  }

  const closingParts = [
    replyPlan.insightText,
    replyPlan.closingText,
  ].filter((value) => value && value.trim());
  const finalMessage = closingParts.join("\n\n");

  if (finalMessage) {
    await sendTelegramMessage(input.inboxItem.external_chat_id!, finalMessage);
  }

  const updatedMetadata: EveningSessionMetadata = {
    ...metadata,
    stage: "completed",
    userReflection: clarificationAlreadyAsked
      ? metadata.userReflection ?? replyPlan.userReflection
      : replyPlan.userReflection,
    userReflectionSourceId: clarificationAlreadyAsked
      ? metadata.userReflectionSourceId ?? input.inboxItem.id
      : input.inboxItem.id,
    clarificationReply: clarificationAlreadyAsked ? replyPlan.userReflection : metadata.clarificationReply,
    clarificationReplySourceId: clarificationAlreadyAsked ? input.inboxItem.id : metadata.clarificationReplySourceId,
    insightCandidates,
  };

  const updatedRows = await updateRows<DailySession>(
    "daily_sessions",
    { id: `eq.${input.session.id}` },
    {
      responded_at: new Date().toISOString(),
      status: "completed",
      source_inbox_item_id: input.inboxItem.id,
      metadata: updatedMetadata,
    },
    {
      select:
        "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
    },
  );

  const updatedSession = updatedRows[0] ?? {
    ...input.session,
    responded_at: new Date().toISOString(),
    status: "completed",
    source_inbox_item_id: input.inboxItem.id,
    metadata: updatedMetadata,
  };

  const notionSync = await syncEveningSessionToNotion({
    session: updatedSession,
    userVisibleSummary: metadata.daySummary ?? input.session.summary_text ?? "Вечерний чек-ин",
    updateSummary: "Пользователь завершил вечерний чек-ин",
    updateText: clarificationAlreadyAsked
      ? `${metadata.userReflection ?? ""}\n${replyPlan.userReflection}`.trim()
      : replyPlan.userReflection,
    updateSourceId: input.inboxItem.id,
  });

  await updateRows(
    "daily_sessions",
    { id: `eq.${input.session.id}` },
    {
      notion_page_id: notionSync.notionPageId,
      notion_synced_at: notionSync.notionSyncedAt,
      notion_last_error: notionSync.notionLastError,
    },
  );

  return {
    consumed: true,
    summary: replyPlan.userReflection,
    classification: `evening_dialog_${replyPlan.classification}`,
  };
}

function isRetryableError(errorMessage: string): boolean {
  return [
    "timed out",
    "429",
    "500",
    "502",
    "503",
    "504",
    "network",
    "fetch",
    "connection",
    "uploadObject",
    "downloadTelegramFile",
    "OpenRouter API error: 5",
  ].some((token) => errorMessage.toLowerCase().includes(token.toLowerCase()));
}

function computeBackoffSeconds(attemptCount: number): number {
  return retryBaseSeconds * Math.max(1, 2 ** Math.max(0, attemptCount - 1));
}

async function checksumSha256(input: Uint8Array): Promise<string> {
  const normalized = Uint8Array.from(input);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalized,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureAttachmentsStored(
  attachments: InboxAttachment[],
  correlationId: string,
): Promise<void> {
  for (const attachment of attachments) {
    if (attachment.downloaded_at || !attachment.telegram_file_id) {
      continue;
    }

    try {
      const file = await downloadTelegramFile(attachment.telegram_file_id);
      await uploadObject({
        bucket: attachment.storage_bucket,
        path: attachment.storage_path,
        body: file.body,
        contentType: attachment.mime_type ?? file.contentType,
      });

      await updateRows(
        "inbox_attachments",
        {
          id: `eq.${attachment.id}`,
        },
        {
          checksum_sha256: await checksumSha256(file.body),
          downloaded_at: new Date().toISOString(),
          last_download_error: null,
          metadata: {
            telegram_file_path: file.filePath,
            stored_via: "process-inbox",
          },
        },
      );
    } catch (error) {
      await updateRows(
        "inbox_attachments",
        {
          id: `eq.${attachment.id}`,
        },
        {
          last_download_error: error instanceof Error ? error.message : String(error),
        },
      );

      logWarn("process_inbox_attachment_capture_failed", {
        correlationId,
        attachmentId: attachment.id,
      });

      throw error;
    }
  }
}

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);
  let claimedJob: ClaimedJob | undefined;

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    const workerName = `process-inbox:${correlationId}`;
    logInfo("process_inbox_started", {
      correlationId,
      openrouterBaseUrl,
      openrouterModel,
    });

    const claimedJobs = await callRpc<ClaimedJob[]>(
      "claim_next_processing_job",
      {
        worker_name: workerName,
      },
    );

    claimedJob = claimedJobs?.[0];
    if (!claimedJob) {
      return jsonResponse({
        ok: true,
        correlationId,
        status: "idle",
      });
    }

    await updateRows(
      "inbox_items",
      {
        id: `eq.${claimedJob.inbox_item_id}`,
      },
      {
        processing_status: "processing",
        processing_started_at: new Date().toISOString(),
        locked_at: new Date().toISOString(),
        locked_by: workerName,
        updated_by: "system",
      },
    );

    const inboxItems = await getRows<InboxItem>("inbox_items", {
      id: `eq.${claimedJob.inbox_item_id}`,
      select: "id,content_type,original_text,external_chat_id,created_at",
      limit: 1,
    });
    const inboxItem = inboxItems[0];
    if (!inboxItem) {
      throw new Error(`Inbox item not found for job ${claimedJob.id}`);
    }

    const attachments = await getRows<InboxAttachment>("inbox_attachments", {
      inbox_item_id: `eq.${inboxItem.id}`,
      select:
        "id,attachment_type,telegram_file_id,storage_bucket,storage_path,mime_type,file_name,downloaded_at,last_download_error",
      order: "created_at.asc",
      limit: 20,
    });
    await ensureAttachmentsStored(attachments, correlationId);

    const relatedEntities = await getRows<RelatedEntity>("proposed_entities", {
      status: "eq.proposed",
      select: "id,entity_type,title,summary,payload,notion_page_id,revision",
      order: "updated_at.desc",
      limit: 25,
    });

    const textForAnalysis = inboxItem.original_text?.trim() ||
      buildAttachmentContext(attachments);

    if (inboxItem.external_chat_id && textForAnalysis) {
      const activeEveningSession = await findActiveEveningSession(
        inboxItem.external_chat_id,
        inboxItem.created_at,
      );

      if (activeEveningSession) {
        const eveningReply = await handleEveningReply({
          session: activeEveningSession,
          inboxItem,
          textForAnalysis,
          correlationId,
        });

        if (eveningReply.consumed) {
          await insertRow(
            "item_analysis",
            {
              inbox_item_id: inboxItem.id,
              analysis_type: "evening_dialog",
              model_provider: "openrouter",
              model_name: getOpenRouterModel(),
              output_text: eveningReply.summary,
              output_json: {
                classification: eveningReply.classification,
                summary: eveningReply.summary,
              },
              confidence: 0.8,
            },
            {
              select: "id",
            },
          );

          await updateRows(
            "inbox_items",
            {
              id: `eq.${inboxItem.id}`,
            },
            {
              processing_status: "processed",
              processed_at: new Date().toISOString(),
              preliminary_type: eveningReply.classification,
              preliminary_summary: eveningReply.summary,
              ai_confidence: 0.8,
              locked_at: null,
              locked_by: null,
              next_retry_at: null,
              last_error_message: null,
              updated_by: "ai",
            },
          );

          await updateRows(
            "processing_jobs",
            {
              id: `eq.${claimedJob.id}`,
            },
            {
              status: "completed",
              completed_at: new Date().toISOString(),
              locked_at: null,
              locked_by: null,
              next_retry_at: null,
              last_error_message: null,
              result: {
                classification: eveningReply.classification,
                summary: eveningReply.summary,
              },
            },
          );

          return jsonResponse({
            ok: true,
            correlationId,
            status: "processed_evening_dialog",
            jobId: claimedJob.id,
            inboxItemId: inboxItem.id,
          });
        }
      }
    }

    let analysis: Awaited<ReturnType<typeof classifyInboxItem>>;
    try {
      analysis = await classifyInboxItem({
        contentType: inboxItem.content_type,
        text: textForAnalysis,
        relatedEntities: relatedEntities
          .filter((entity) =>
            entity.entity_type === "goal" || entity.entity_type === "project"
          )
          .map((entity) => ({
            id: entity.id,
            entityType: entity.entity_type,
            title: entity.title,
            summary: entity.summary,
            payload: entity.payload ?? {},
          })),
      });
    } catch (classificationError) {
      logError("process_inbox_llm_fallback_used", {
        correlationId,
        inboxItemId: inboxItem.id,
        error: classificationError instanceof Error
          ? classificationError.message
          : String(classificationError),
      });

      analysis = {
        rawText: "FALLBACK_ANALYSIS",
        result: buildFallbackAnalysis({
          text: textForAnalysis,
          relatedEntities,
        }),
      };
    }

    const sanitizedAnalysis: SanitizedAnalysisResult = sanitizeAnalysisResult({
      result: analysis.result,
      originalText: textForAnalysis,
    });

    const normalizedAnalysis: NormalizedAnalysis = normalizeAnalysisDecision({
      text: textForAnalysis,
      result: sanitizedAnalysis,
      relatedEntities,
    });

    await insertRow(
      "item_analysis",
      {
        inbox_item_id: inboxItem.id,
        analysis_type: "classification",
        model_provider: "openrouter",
        model_name: getOpenRouterModel(),
        output_text: analysis.rawText,
        output_json: sanitizedAnalysis,
        confidence: sanitizedAnalysis.confidence ?? null,
      },
      {
        select: "id",
      },
    );

    let replyTargetTitle: string | null = null;

    if (
      normalizedAnalysis.decision === "update" &&
      normalizedAnalysis.targetEntityId
    ) {
      const targetEntity = relatedEntities.find((entity) =>
        entity.id === normalizedAnalysis.targetEntityId
      );

      if (targetEntity) {
        replyTargetTitle = targetEntity.title ?? targetEntity.summary ?? null;

        await updateRows(
          "proposed_entities",
          {
            id: `eq.${targetEntity.id}`,
          },
          {
            inbox_item_id: inboxItem.id,
            title: sanitizedAnalysis.suggestedTitle ?? targetEntity.title,
            summary: sanitizedAnalysis.summary,
            payload: mergePayload(
              targetEntity.payload,
              sanitizedAnalysis.suggestedPayload ?? {},
            ),
            confidence: sanitizedAnalysis.confidence ?? null,
            updated_by: "ai",
            revision: (targetEntity.revision ?? 1) + 1,
            notion_synced_at: null,
            notion_last_error: null,
          },
        );
      } else {
        await insertRow(
          "proposed_entities",
          {
            inbox_item_id: inboxItem.id,
            entity_type: sanitizedAnalysis.suggestedEntityType ?? "unknown",
            status: "proposed",
            title: sanitizedAnalysis.suggestedTitle ?? null,
            summary: sanitizedAnalysis.summary,
            payload: sanitizedAnalysis.suggestedPayload ?? {},
            confidence: sanitizedAnalysis.confidence ?? null,
            created_by: "ai",
            updated_by: "system",
          },
          {
            select: "id",
          },
        );
      }
    } else if (normalizedAnalysis.decision !== "clarify") {
      await insertRow(
        "proposed_entities",
        {
          inbox_item_id: inboxItem.id,
          entity_type: sanitizedAnalysis.suggestedEntityType ?? "unknown",
          status: "proposed",
          title: sanitizedAnalysis.suggestedTitle ?? null,
          summary: sanitizedAnalysis.summary,
          payload: sanitizedAnalysis.suggestedPayload ?? {},
          confidence: sanitizedAnalysis.confidence ?? null,
          created_by: "ai",
          updated_by: "system",
        },
        {
          select: "id",
        },
      );
    }

    await updateRows(
      "inbox_items",
      {
        id: `eq.${inboxItem.id}`,
      },
      {
        processing_status: "processed",
        processed_at: new Date().toISOString(),
        preliminary_type: sanitizedAnalysis.classification,
        preliminary_summary: sanitizedAnalysis.summary,
        ai_confidence: sanitizedAnalysis.confidence ?? null,
        locked_at: null,
        locked_by: null,
        next_retry_at: null,
        last_error_message: null,
        updated_by: "ai",
      },
    );

    await updateRows(
      "processing_jobs",
      {
        id: `eq.${claimedJob.id}`,
      },
      {
        status: "completed",
        completed_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        next_retry_at: null,
        last_error_message: null,
        result: {
          classification: sanitizedAnalysis.classification,
          summary: sanitizedAnalysis.summary,
        },
      },
    );

    if (inboxItem.external_chat_id) {
      try {
        await sendTelegramMessage(
          inboxItem.external_chat_id,
          pickTelegramReply({
            llmReply: sanitizedAnalysis.agentReply ?? null,
            entityType: sanitizedAnalysis.suggestedEntityType ??
              sanitizedAnalysis.classification,
            decision: normalizedAnalysis.decision,
            title: sanitizedAnalysis.suggestedTitle ?? null,
            summary: sanitizedAnalysis.summary,
            payload: sanitizedAnalysis.suggestedPayload ?? {},
            followUpQuestion: sanitizedAnalysis.followUpQuestion ?? null,
            targetTitle: replyTargetTitle,
          }),
        );
      } catch (replyError) {
        logError("process_inbox_reply_failed", {
          correlationId,
          inboxItemId: inboxItem.id,
          error: replyError instanceof Error
            ? replyError.message
            : String(replyError),
        });
      }
    }

    return jsonResponse({
      ok: true,
      correlationId,
      status: "processed",
      jobId: claimedJob.id,
      inboxItemId: inboxItem.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (claimedJob) {
      try {
        const [jobState] = await getRows<ProcessingJobState>("processing_jobs", {
          id: `eq.${claimedJob.id}`,
          select: "id,attempt_count,max_attempts",
          limit: 1,
        });

        const canRetry = jobState
          ? jobState.attempt_count < jobState.max_attempts &&
            isRetryableError(message)
          : false;

        if (canRetry) {
          const retryAt = new Date(
            Date.now() + computeBackoffSeconds(jobState.attempt_count) * 1000,
          ).toISOString();

          await updateRows(
            "processing_jobs",
            {
              id: `eq.${claimedJob.id}`,
            },
            {
              status: "pending",
              next_retry_at: retryAt,
              locked_at: null,
              locked_by: null,
              last_error_message: message,
            },
          );

          await updateRows(
            "inbox_items",
            {
              id: `eq.${claimedJob.inbox_item_id}`,
            },
            {
              processing_status: "pending",
              retry_count: jobState.attempt_count,
              next_retry_at: retryAt,
              last_error_message: message,
              locked_at: null,
              locked_by: null,
              updated_by: "system",
            },
          );

          logWarn("process_inbox_retry_scheduled", {
            correlationId,
            claimedJobId: claimedJob.id,
            retryAt,
          });

          return jsonResponse({
            ok: false,
            correlationId,
            status: "retry_scheduled",
            retryAt,
          }, { status: 202 });
        }

        await updateRows(
          "processing_jobs",
          {
            id: `eq.${claimedJob.id}`,
          },
          {
            status: "failed",
            failed_at: new Date().toISOString(),
            locked_at: null,
            locked_by: null,
            last_error_message: message,
          },
        );

        await updateRows(
          "inbox_items",
          {
            id: `eq.${claimedJob.inbox_item_id}`,
          },
          {
            processing_status: "failed",
            failed_at: new Date().toISOString(),
            last_error_message: message,
            locked_at: null,
            locked_by: null,
            updated_by: "system",
          },
        );
      } catch (recoveryError) {
        logError("process_inbox_failure_recovery_failed", {
          correlationId,
          claimedJobId: claimedJob.id,
          error: recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError),
        });
      }
    }

    logError("process_inbox_failed", {
      correlationId,
      error: message,
    });

    return serverError(message);
  }
});
