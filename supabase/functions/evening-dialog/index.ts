import { readOptionalEnv } from "../_shared/env.ts";
import { DailySessionRecord, EveningSessionMetadata, syncEveningSessionToNotion } from "../_shared/evening.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { buildEveningDigest } from "../_shared/openrouter.ts";
import { getRows, insertRow, updateRows } from "../_shared/supabase.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import { getConfiguredTimezone, getLocalDateString, minutesSince } from "../_shared/time.ts";

const reminderMinutes = Number(
  readOptionalEnv("EVENING_DIALOG_REMINDER_MINUTES", "90"),
);

type SchedulerRun = {
  id: string;
};

type DailySession = DailySessionRecord;

type InboxItem = {
  id: string;
  external_chat_id: string | null;
  preliminary_summary: string | null;
  original_text: string | null;
  created_at: string;
  message_timestamp: string | null;
  content_type?: string | null;
};

type ProposedEntity = {
  id: string;
  inbox_item_id: string;
  entity_type: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
};

function compactUnique(values: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) {
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(trimmed);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isLowSignalText(value?: string | null): boolean {
  const text = value?.trim().toLowerCase();
  if (!text) {
    return true;
  }

  return [
    "пользователь просит добавить что-то, но не уточняет что именно",
    "пользователь подтверждает сохранение как заметку, но содержание неясно",
    "да, запомни просто как заметка",
    "сохрани в заметку",
    "добавь это тоже",
    "ок",
    "ага",
  ].includes(text);
}

function isDirectiveLikeText(value?: string | null): boolean {
  const text = normalizeWhitespace(value ?? "").toLowerCase();
  if (!text) {
    return true;
  }

  return [
    "добавь",
    "сохрани",
    "запомни",
    "купи",
    "закажи",
    "проверь",
    "напомни",
    "запустить",
  ].some((marker) => text.startsWith(marker) || text.includes(` ${marker}`));
}

function isLikelyUtilityText(value?: string | null): boolean {
  const text = value?.trim().toLowerCase();
  if (!text) {
    return true;
  }

  if (text.includes("http://") || text.includes("https://")) {
    return true;
  }

  return [
    "codex webhook smoke test",
    "откуда это взято. я такого не говорил тебе",
  ].some((marker) => text.includes(marker)) || isDirectiveLikeText(text);
}

function buildConversationHighlights(items: InboxItem[]): string[] {
  return compactUnique(
    items
      .map((item) => item.original_text ?? item.preliminary_summary)
      .filter((value) =>
        Boolean(value) && !isLowSignalText(value) && !isLikelyUtilityText(value)
      )
      .map((value) => normalizeWhitespace(value!)),
    4,
  );
}

function buildFallbackTopics(
  highlights: string[],
  activeProjects: string[],
): string[] {
  const rawTopics = [
    ...activeProjects,
    ...highlights.map((item) => item.split(/[.!?]/)[0] ?? item),
  ];

  return compactUnique(rawTopics, 3).map((item) => normalizeWhitespace(item));
}

function extractTopicHints(values: string[]): string[] {
  const source = values.join(" ").toLowerCase();
  const hints: string[] = [];

  if (source.includes("работ")) {
    hints.push("работа");
  }

  if (source.includes("свидан") || source.includes("девушк")) {
    hints.push("свидание");
  }

  if (
    source.includes("не знаю") || source.includes("непонят") ||
    source.includes("висит в воздухе")
  ) {
    hints.push("неясность");
  }

  if (source.includes("интерв")) {
    hints.push("подготовка к интервью");
  }

  return compactUnique(hints, 4);
}

function sanitizeTopics(topics: string[], recentSignals: string[], activeProjects: string[]): string[] {
  const compactTopics = topics
    .map((topic) => normalizeWhitespace(topic))
    .filter((topic) => topic && topic.length <= 40 && !/[.!?]/.test(topic));

  const hints = extractTopicHints([
    ...compactTopics,
    ...recentSignals,
    ...activeProjects,
  ]);

  return compactUnique([
    ...compactTopics,
    ...hints,
  ], 4);
}

function buildFallbackSummary(topics: string[], recentSignals: string[]): string {
  const source = recentSignals.join(" ").toLowerCase();

  if (topics.includes("работа") && topics.includes("свидание") && topics.includes("неясность")) {
    return "Похоже, день крутился вокруг тяжёлой работы, темы свидания и ощущения, что с чем-то важным пока нет ясности.";
  }

  if (topics.includes("работа") && topics.includes("свидание")) {
    return "Похоже, сегодня рядом были тяжёлая работа и личная тема со свиданием, которая пока не отпускает.";
  }

  if (topics.includes("работа")) {
    return "Похоже, день во многом был завязан на работе и потребовал много сил.";
  }

  if (topics.includes("свидание")) {
    return "Похоже, личная тема со свиданием сегодня осталась заметной и до конца не закрылась.";
  }

  if (source.includes("не знаю") || source.includes("висит в воздухе")) {
    return "Похоже, сегодня особенно чувствовалась неясность вокруг следующего шага.";
  }

  return recentSignals[0] ?? "";
}

function buildOpeningMessage(input: {
  topics: string[];
  daySummary: string;
}): string {
  if (!input.topics.length && !input.daySummary.trim()) {
    return "Привет! Сегодня ты мне не писал — расскажи, как прошёл день?\n\nЧто было главным?";
  }

  const lines = ["Привет! Вечер, время подвести итоги."];

  if (input.topics.length) {
    lines.push(`Сегодня ты писал мне про ${input.topics.join(", ")}.`);
  }

  if (input.daySummary.trim()) {
    lines.push(input.daySummary.trim());
  }

  lines.push("");
  lines.push("Как в целом прошёл день? Что было главным?");

  return lines.join("\n");
}

function buildReminderMessage(metadata?: EveningSessionMetadata | null): string {
  const topic = metadata?.topics?.[0];
  if (topic) {
    return `Мягко напомню про вечерний чек-ин. Если хочешь, можно просто в двух словах: как сегодня сложилась тема ${topic} и что было для тебя главным?`;
  }

  return "Мягко напомню про вечерний чек-ин. Когда будет удобно, просто напиши в свободной форме: как прошёл день и что было главным.";
}

function isMeaningfulEveningReply(item: Pick<InboxItem, "original_text" | "preliminary_summary">): boolean {
  const text = item.original_text?.trim() ?? item.preliminary_summary?.trim() ?? "";
  if (!text || isLowSignalText(text) || isLikelyUtilityText(text)) {
    return false;
  }

  return text.length >= 12;
}

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  let schedulerRunId: string | null = null;

  try {
    const now = new Date();
    const sessionDate = getLocalDateString(now);
    const scheduledFor = `${sessionDate}T21:00:00`;

    const runRows = await insertRow<SchedulerRun>(
      "scheduler_runs",
      {
        job_name: "evening-dialog",
        scheduled_for: scheduledFor,
        status: "started",
        payload: {
          timezone: getConfiguredTimezone(),
          correlationId,
        },
        correlation_id: correlationId,
      },
      {
        onConflict: "job_name,scheduled_for",
        select: "id",
      },
    );
    schedulerRunId = runRows[0]?.id ?? null;

    logInfo("evening_dialog_started", {
      correlationId,
      sessionDate,
      schedulerRunId,
    });

    const sessionRows = await getRows<DailySession>("daily_sessions", {
      session_date: `eq.${sessionDate}`,
      select:
        "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
      limit: 1,
    });
    const session = sessionRows[0];

    const recentItems = await getRows<InboxItem>("inbox_items", {
      external_chat_id: "not.is.null",
      select:
        "id,external_chat_id,preliminary_summary,original_text,created_at,message_timestamp,content_type",
      order: "created_at.desc",
      limit: 100,
    });
    const latestChatId = recentItems.find((item) => item.external_chat_id)?.external_chat_id ?? null;

    if (!latestChatId) {
      throw new Error("No Telegram chat id found for evening dialog");
    }

    if (session?.responded_at) {
      if (schedulerRunId) {
        await updateRows(
          "scheduler_runs",
          { id: `eq.${schedulerRunId}` },
          {
            status: "completed",
            completed_at: new Date().toISOString(),
            result: {
              action: "already_completed",
              sessionDate,
            },
          },
        );
      }

      return jsonResponse({
        ok: true,
        correlationId,
        status: "already_completed",
        sessionDate,
      });
    }

    if (session?.sent_at) {
      const minutesFromSend = minutesSince(session.sent_at, now);
      const shouldRemind = Boolean(
        session.chat_id &&
        !session.reminder_sent_at &&
        minutesFromSend !== null &&
        minutesFromSend >= reminderMinutes
      );

      if (shouldRemind && session.chat_id) {
        await sendTelegramMessage(
          session.chat_id,
          buildReminderMessage(session.metadata),
        );

        await updateRows(
          "daily_sessions",
          { id: `eq.${session.id}` },
          {
            reminder_sent_at: now.toISOString(),
            status: "reminder_sent",
          },
        );

        if (schedulerRunId) {
          await updateRows(
            "scheduler_runs",
            { id: `eq.${schedulerRunId}` },
            {
              status: "completed",
              completed_at: new Date().toISOString(),
              result: {
                action: "reminder_sent",
                sessionDate,
              },
            },
          );
        }

        return jsonResponse({
          ok: true,
          correlationId,
          status: "reminder_sent",
          sessionDate,
        });
      }

      if (schedulerRunId) {
        await updateRows(
          "scheduler_runs",
          { id: `eq.${schedulerRunId}` },
          {
            status: "skipped",
            completed_at: new Date().toISOString(),
            result: {
              action: "no_action",
              sessionDate,
            },
          },
        );
      }

      return jsonResponse({
        ok: true,
        correlationId,
        status: "no_action",
        sessionDate,
      });
    }

    const todayItems = recentItems
      .filter((item) =>
        getLocalDateString(new Date(item.message_timestamp ?? item.created_at)) ===
          sessionDate
      )
      .filter((item) => item.external_chat_id === latestChatId)
      .reverse();

    const activeEntities = await getRows<ProposedEntity>("proposed_entities", {
      status: "eq.proposed",
      select: "id,inbox_item_id,entity_type,title,summary,payload",
      order: "updated_at.desc",
      limit: 50,
    });

    const recentInboxIds = new Set(todayItems.map((item) => item.id));
    const scopedEntities = activeEntities.filter((entity) =>
      recentInboxIds.has(entity.inbox_item_id)
    );

    const highlights = buildConversationHighlights(todayItems.slice(-10));
    const openLoops = compactUnique(
      scopedEntities
        .filter((entity) =>
          entity.entity_type === "task" || entity.entity_type === "project"
        )
        .map((entity) =>
          entity.payload?.next_step as string | undefined ?? entity.title ??
            entity.summary
        )
        .filter((value) => value && !isLikelyUtilityText(value)),
      3,
    ).map((value) => normalizeWhitespace(value));
    const activeProjects = compactUnique(
      scopedEntities
        .filter((entity) => entity.entity_type === "project")
        .map((entity) => entity.title ?? entity.summary),
      3,
    ).map((value) => normalizeWhitespace(value));
    const recentUserSignals = compactUnique(
      todayItems
        .filter((item) => item.content_type === "text")
        .map((item) => item.original_text)
        .filter((value) => value && !isLowSignalText(value) && !isLikelyUtilityText(value))
        .map((value) => normalizeWhitespace(value!)),
      4,
    );

    let topics: string[] = [];
    let daySummary = "";

    if (todayItems.length) {
      try {
        const digest = await buildEveningDigest({
          dateLabel: now.toISOString(),
          messages: todayItems
            .filter((item) => item.content_type === "text")
            .map((item) => ({
              text: normalizeWhitespace(item.original_text ?? item.preliminary_summary ?? ""),
              time: item.message_timestamp ?? item.created_at,
            }))
            .filter((item) => item.text),
        });
        topics = digest.topics;
        daySummary = digest.daySummary;
      } catch (error) {
        logWarn("evening_dialog_digest_fallback_used", {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    topics = sanitizeTopics(
      topics.length ? topics : buildFallbackTopics(highlights, activeProjects),
      recentUserSignals,
      activeProjects,
    );
    if (!daySummary || daySummary.length > 180) {
      daySummary = buildFallbackSummary(topics, recentUserSignals);
    }

    const promptText = buildOpeningMessage({
      topics,
      daySummary,
    });

    await sendTelegramMessage(latestChatId, promptText);

    const metadata: EveningSessionMetadata = {
      scenario: "evening-check-in-v2",
      daySummary,
      topics,
      recentSignals: recentUserSignals,
      openLoops,
      activeProjects,
      stage: "awaiting_reflection",
      clarificationAsked: false,
      insightCandidates: [],
    };

    const inserted = await insertRow<DailySession>(
      "daily_sessions",
      {
        session_date: sessionDate,
        status: "sent",
        prompt_text: promptText,
        summary_text: daySummary,
        chat_id: latestChatId,
        sent_at: now.toISOString(),
        metadata: {
          timezone: getConfiguredTimezone(),
          schedulerRunId,
          ...metadata,
        },
      },
      {
        onConflict: "session_date",
        select:
          "id,session_date,status,prompt_text,summary_text,chat_id,sent_at,reminder_sent_at,responded_at,source_inbox_item_id,notion_page_id,notion_synced_at,metadata",
      },
    );
    const createdSession = inserted[0];

    if (createdSession) {
      const notionSync = await syncEveningSessionToNotion({
        session: createdSession,
        userVisibleSummary: daySummary || "Вечерний чек-ин запущен",
      });

      await updateRows(
        "daily_sessions",
        { id: `eq.${createdSession.id}` },
        {
          notion_page_id: notionSync.notionPageId,
          notion_synced_at: notionSync.notionSyncedAt,
          notion_last_error: notionSync.notionLastError,
        },
      );
    }

    if (schedulerRunId) {
      await updateRows(
        "scheduler_runs",
        { id: `eq.${schedulerRunId}` },
        {
          status: "completed",
          completed_at: new Date().toISOString(),
          result: {
            action: "sent",
            sessionDate,
            topics,
          },
        },
      );
    }

    return jsonResponse({
      ok: true,
      correlationId,
      status: "sent",
      sessionDate,
      hasTodayMessages: todayItems.some((item) => isMeaningfulEveningReply(item)),
    });
  } catch (error) {
    logError("evening_dialog_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (schedulerRunId) {
      await updateRows(
        "scheduler_runs",
        { id: `eq.${schedulerRunId}` },
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
