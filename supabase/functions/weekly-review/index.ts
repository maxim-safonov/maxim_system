import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { summarizeWeeklyReview } from "../_shared/openrouter.ts";
import { getRows, insertRow, updateRows } from "../_shared/supabase.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import {
  getConfiguredTimezone,
  getLocalDateString,
  getWeekStartDateString,
} from "../_shared/time.ts";

type SchedulerRun = {
  id: string;
};

type WeeklyReviewRow = {
  id: string;
  week_start_date: string;
  status: string;
  sent_at: string | null;
  chat_id: string | null;
};

type ProcessedItem = {
  id: string;
  preliminary_summary: string | null;
  preliminary_type: string | null;
  created_at: string;
  external_chat_id: string | null;
};

type ProposedEntity = {
  id: string;
  entity_type: string;
  title: string | null;
  summary: string | null;
};

function fallbackWeeklyReview(input: {
  weekStartDate: string;
  weekEndDate: string;
  processedItems: ProcessedItem[];
  proposedEntities: ProposedEntity[];
}): string {
  const lines = [
    `Недельный обзор за ${input.weekStartDate} - ${input.weekEndDate}`,
    "",
    `Обработано входящих: ${input.processedItems.length}`,
    `Новых предложенных сущностей: ${input.proposedEntities.length}`,
    "",
    "Что выделилось:",
  ];

  const highlights = input.processedItems
    .map((item) => item.preliminary_summary)
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);

  if (!highlights.length) {
    lines.push("Пока без ярко выраженных событий недели.");
  } else {
    lines.push(...highlights.map((item, index) => `${index + 1}. ${item}`));
  }

  lines.push("");
  lines.push("Фокус на следующую неделю:");

  const priorities = input.proposedEntities
    .map((entity) => entity.title ?? entity.summary)
    .filter((item): item is string => Boolean(item))
    .slice(0, 3);

  if (!priorities.length) {
    lines.push("1. Разобрать новые входящие и уточнить приоритеты.");
  } else {
    lines.push(...priorities.map((item, index) => `${index + 1}. ${item}`));
  }

  return lines.join("\n");
}

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  let schedulerRunId: string | null = null;

  try {
    const now = new Date();
    const weekStartDate = getWeekStartDateString(now);
    const weekEndDate = getLocalDateString(now);
    const scheduledFor = `${weekEndDate}T18:00:00`;

    const runRows = await insertRow<SchedulerRun>(
      "scheduler_runs",
      {
        job_name: "weekly-review",
        scheduled_for: scheduledFor,
        status: "started",
        payload: {
          timezone: getConfiguredTimezone(),
          correlationId,
          weekStartDate,
        },
        correlation_id: correlationId,
      },
      {
        onConflict: "job_name,scheduled_for",
        select: "id",
      },
    );
    schedulerRunId = runRows[0]?.id ?? null;

    logInfo("weekly_review_started", {
      correlationId,
      weekStartDate,
      schedulerRunId,
    });

    const existingReview = await getRows<WeeklyReviewRow>("weekly_reviews", {
      week_start_date: `eq.${weekStartDate}`,
      select: "id,week_start_date,status,sent_at,chat_id",
      limit: 1,
    });
    if (existingReview[0]?.sent_at) {
      if (schedulerRunId) {
        await updateRows(
          "scheduler_runs",
          {
            id: `eq.${schedulerRunId}`,
          },
          {
            status: "skipped",
            completed_at: new Date().toISOString(),
            result: {
              action: "already_sent",
              weekStartDate,
            },
          },
        );
      }

      return jsonResponse({
        ok: true,
        correlationId,
        status: "already_sent",
        weekStartDate,
      });
    }

    const processedItems = await getRows<ProcessedItem>("inbox_items", {
      processing_status: "eq.processed",
      created_at: `gte.${weekStartDate}T00:00:00`,
      select:
        "id,preliminary_summary,preliminary_type,created_at,external_chat_id",
      order: "created_at.desc",
      limit: 50,
    });

    const proposedEntities = await getRows<ProposedEntity>("proposed_entities", {
      created_at: `gte.${weekStartDate}T00:00:00`,
      select: "id,entity_type,title,summary",
      order: "created_at.desc",
      limit: 30,
    });

    const latestChatId = processedItems.find((item) => item.external_chat_id)
      ?.external_chat_id ?? null;
    if (!latestChatId) {
      throw new Error("No Telegram chat id found for weekly review");
    }

    let reviewText: string;
    try {
      reviewText = await summarizeWeeklyReview({
        weekStartDate,
        weekEndDate,
        processedItems: processedItems.map((item) => ({
          summary: item.preliminary_summary,
          type: item.preliminary_type,
          createdAt: item.created_at,
        })),
        proposedEntities: proposedEntities.map((entity) => ({
          entityType: entity.entity_type,
          title: entity.title,
          summary: entity.summary,
        })),
      });
    } catch (error) {
      logWarn("weekly_review_summary_fallback_used", {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      reviewText = fallbackWeeklyReview({
        weekStartDate,
        weekEndDate,
        processedItems,
        proposedEntities,
      });
    }

    await sendTelegramMessage(latestChatId, reviewText);

    await insertRow(
      "weekly_reviews",
      {
        week_start_date: weekStartDate,
        status: "sent",
        title: `Weekly review ${weekStartDate}`,
        summary_text: reviewText,
        chat_id: latestChatId,
        sent_at: now.toISOString(),
        source_scheduler_run_id: schedulerRunId,
        metadata: {
          timezone: getConfiguredTimezone(),
          processedItemCount: processedItems.length,
          proposedEntityCount: proposedEntities.length,
        },
      },
      {
        onConflict: "week_start_date",
      },
    );

    if (schedulerRunId) {
      await updateRows(
        "scheduler_runs",
        {
          id: `eq.${schedulerRunId}`,
        },
        {
          status: "completed",
          completed_at: new Date().toISOString(),
          result: {
            action: "sent",
            weekStartDate,
            processedItemCount: processedItems.length,
          },
        },
      );
    }

    return jsonResponse({
      ok: true,
      correlationId,
      status: "sent",
      weekStartDate,
    });
  } catch (error) {
    logError("weekly_review_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (schedulerRunId) {
      await updateRows(
        "scheduler_runs",
        {
          id: `eq.${schedulerRunId}`,
        },
        {
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : String(error),
        },
      );
    }

    return serverError();
  }
});
