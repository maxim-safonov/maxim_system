import { readOptionalEnv, requireEnv } from "../_shared/env.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import {
  jsonResponse,
  methodNotAllowed,
  serverError,
} from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  callRpc,
  getRows,
  insertRow,
  updateRows,
} from "../_shared/supabase.ts";
import {
  classifyInboxItem,
  getOpenRouterModel,
} from "../_shared/openrouter.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";

const openrouterBaseUrl = readOptionalEnv(
  "OPENROUTER_BASE_URL",
  "https://openrouter.ai/api/v1",
);
const openrouterModel = readOptionalEnv(
  "OPENROUTER_MODEL",
  "openai/gpt-4.1-mini",
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

type InboxItem = {
  id: string;
  content_type: string;
  original_text: string | null;
  external_chat_id: string | null;
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
      select: "id,content_type,original_text,external_chat_id",
      limit: 1,
    });

    const inboxItem = inboxItems[0];
    if (!inboxItem) {
      throw new Error(`Inbox item not found for job ${claimedJob.id}`);
    }

    const relatedEntities = await getRows<RelatedEntity>("proposed_entities", {
      status: "eq.proposed",
      select: "id,entity_type,title,summary,payload,notion_page_id,revision",
      order: "updated_at.desc",
      limit: 25,
    });

    let analysis: Awaited<ReturnType<typeof classifyInboxItem>>;
    try {
      analysis = await classifyInboxItem({
        contentType: inboxItem.content_type,
        text: inboxItem.original_text,
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
          text: inboxItem.original_text,
          relatedEntities,
        }),
      };
    }

    const sanitizedAnalysis: SanitizedAnalysisResult = sanitizeAnalysisResult({
      result: analysis.result,
      originalText: inboxItem.original_text,
    });

    const normalizedAnalysis: NormalizedAnalysis = normalizeAnalysisDecision({
      text: inboxItem.original_text,
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
