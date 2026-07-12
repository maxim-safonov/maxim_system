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

    const analysis = await classifyInboxItem({
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

    await insertRow(
      "item_analysis",
      {
        inbox_item_id: inboxItem.id,
        analysis_type: "classification",
        model_provider: "openrouter",
        model_name: getOpenRouterModel(),
        output_text: analysis.rawText,
        output_json: analysis.result,
        confidence: analysis.result.confidence ?? null,
      },
      {
        select: "id",
      },
    );

    let replyTargetTitle: string | null = null;

    if (
      analysis.result.decision === "update" &&
      analysis.result.targetEntityId
    ) {
      const targetEntity = relatedEntities.find((entity) =>
        entity.id === analysis.result.targetEntityId
      );

      if (targetEntity) {
        replyTargetTitle = targetEntity.title ?? targetEntity.summary ?? null;

        await updateRows(
          "proposed_entities",
          {
            id: `eq.${targetEntity.id}`,
          },
          {
            title: analysis.result.suggestedTitle ?? targetEntity.title,
            summary: analysis.result.summary,
            payload: mergePayload(
              targetEntity.payload,
              analysis.result.suggestedPayload ?? {},
            ),
            confidence: analysis.result.confidence ?? null,
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
            entity_type: analysis.result.suggestedEntityType ?? "unknown",
            status: "proposed",
            title: analysis.result.suggestedTitle ?? null,
            summary: analysis.result.summary,
            payload: analysis.result.suggestedPayload ?? {},
            confidence: analysis.result.confidence ?? null,
            created_by: "ai",
            updated_by: "system",
          },
          {
            select: "id",
          },
        );
      }
    } else if (analysis.result.decision !== "clarify") {
      await insertRow(
        "proposed_entities",
        {
          inbox_item_id: inboxItem.id,
          entity_type: analysis.result.suggestedEntityType ?? "unknown",
          status: "proposed",
          title: analysis.result.suggestedTitle ?? null,
          summary: analysis.result.summary,
          payload: analysis.result.suggestedPayload ?? {},
          confidence: analysis.result.confidence ?? null,
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
        preliminary_type: analysis.result.classification,
        preliminary_summary: analysis.result.summary,
        ai_confidence: analysis.result.confidence ?? null,
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
          classification: analysis.result.classification,
          summary: analysis.result.summary,
        },
      },
    );

    if (inboxItem.external_chat_id) {
      try {
        await sendTelegramMessage(
          inboxItem.external_chat_id,
          pickTelegramReply({
            llmReply: analysis.result.agentReply ?? null,
            entityType: analysis.result.suggestedEntityType ??
              analysis.result.classification,
            decision: analysis.result.decision ?? "create",
            title: analysis.result.suggestedTitle ?? null,
            summary: analysis.result.summary,
            payload: analysis.result.suggestedPayload ?? {},
            followUpQuestion: analysis.result.followUpQuestion ?? null,
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
