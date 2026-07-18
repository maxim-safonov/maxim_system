import { requireEnv } from "./env.ts";
import {
  appendPageUpdate,
  createChildPage,
  parseNotionTargets,
  updatePageTitle,
} from "./notion.ts";

const notionTargets = parseNotionTargets(requireEnv("NOTION_DATABASE_IDS"));
const eveningRootPageId = notionTargets.Evening ?? notionTargets.evening ?? null;

export type EveningInsightCandidate = {
  text: string;
  topic?: string | null;
  confirmed_by_user: boolean;
};

export type EveningSessionMetadata = {
  scenario?: string;
  daySummary?: string;
  topics?: string[];
  recentSignals?: string[];
  openLoops?: string[];
  activeProjects?: string[];
  stage?: "awaiting_reflection" | "awaiting_clarification" | "completed";
  clarificationAsked?: boolean;
  clarificationQuestion?: string | null;
  userReflection?: string | null;
  userReflectionSourceId?: string | null;
  clarificationReply?: string | null;
  clarificationReplySourceId?: string | null;
  insightCandidates?: EveningInsightCandidate[];
};

export type DailySessionRecord = {
  id: string;
  session_date: string;
  status: string;
  prompt_text: string | null;
  summary_text: string | null;
  chat_id: string | null;
  sent_at: string | null;
  reminder_sent_at: string | null;
  responded_at: string | null;
  source_inbox_item_id?: string | null;
  notion_page_id?: string | null;
  notion_synced_at?: string | null;
  metadata?: EveningSessionMetadata | null;
};

function normalizeText(value?: string | null): string {
  return value?.trim() ?? "";
}

function joinValues(values?: string[] | null): string {
  return (values ?? []).map((value) => value.trim()).filter(Boolean).join(" | ");
}

function buildDetails(metadata: EveningSessionMetadata, session: DailySessionRecord) {
  return [
    {
      label: "Статус",
      value: session.status,
    },
    {
      label: "Этап",
      value: metadata.stage ?? "unknown",
    },
    {
      label: "Темы дня",
      value: joinValues(metadata.topics),
    },
    {
      label: "Сводка дня",
      value: normalizeText(metadata.daySummary),
    },
    {
      label: "Главные сигналы",
      value: joinValues(metadata.recentSignals),
    },
    {
      label: "Незакрытые хвосты",
      value: joinValues(metadata.openLoops),
    },
    {
      label: "Активные проекты",
      value: joinValues(metadata.activeProjects),
    },
    {
      label: "Рефлексия пользователя",
      value: normalizeText(metadata.userReflection),
    },
    {
      label: "Уточнение пользователя",
      value: normalizeText(metadata.clarificationReply),
    },
    {
      label: "Кандидаты в инсайты",
      value: (metadata.insightCandidates ?? [])
        .map((item) =>
          item.topic
            ? `${item.text} [${item.topic}]`
            : item.text
        )
        .join(" | "),
    },
  ].filter((item) => item.value.trim());
}

export async function syncEveningSessionToNotion(input: {
  session: DailySessionRecord;
  userVisibleSummary: string;
  updateSummary?: string | null;
  updateText?: string | null;
  updateSourceId?: string | null;
}): Promise<{
  notionPageId: string | null;
  notionSyncedAt: string | null;
  notionLastError: string | null;
}> {
  if (!eveningRootPageId) {
    return {
      notionPageId: input.session.notion_page_id ?? null,
      notionSyncedAt: input.session.notion_synced_at ?? null,
      notionLastError: null,
    };
  }

  const metadata = input.session.metadata ?? {};
  const title = `Evening dialog ${input.session.session_date}`;
  const details = buildDetails(metadata, input.session);

  try {
    if (input.session.notion_page_id) {
      await updatePageTitle({
        pageId: input.session.notion_page_id,
        title,
      });
      await appendPageUpdate({
        blockId: input.session.notion_page_id,
        summary: input.updateSummary ?? input.userVisibleSummary,
        sourceId: input.updateSourceId ?? input.session.id,
        originalText: input.updateText ?? input.session.prompt_text,
        details,
      });

      return {
        notionPageId: input.session.notion_page_id,
        notionSyncedAt: new Date().toISOString(),
        notionLastError: null,
      };
    }

    const page = await createChildPage({
      parentPageId: eveningRootPageId,
      title,
      summary: input.userVisibleSummary,
      sourceId: input.session.id,
      originalText: input.session.prompt_text,
      details,
    });

    return {
      notionPageId: page.id,
      notionSyncedAt: new Date().toISOString(),
      notionLastError: null,
    };
  } catch (error) {
    return {
      notionPageId: input.session.notion_page_id ?? null,
      notionSyncedAt: null,
      notionLastError: error instanceof Error ? error.message : String(error),
    };
  }
}
