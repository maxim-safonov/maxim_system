import { requireEnv } from "../_shared/env.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import {
  jsonResponse,
  methodNotAllowed,
  serverError,
} from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import {
  appendPageUpdate,
  createChildPage,
  parseNotionTargets,
  updatePageTitle,
} from "../_shared/notion.ts";
import { getRows, updateRows } from "../_shared/supabase.ts";

requireEnv("NOTION_API_KEY");
const notionTargets = parseNotionTargets(requireEnv("NOTION_DATABASE_IDS"));

type InboxItemForSync = {
  id: string;
  original_text: string | null;
  preliminary_type: string | null;
  preliminary_summary: string | null;
  created_at: string;
  notion_page_id: string | null;
};

type ProposedEntityForSync = {
  id: string;
  inbox_item_id: string;
  entity_type: string;
  status: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  notion_page_id: string | null;
  notion_synced_at?: string | null;
};

type InboxSource = {
  id: string;
  original_text: string | null;
};

function detailValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildEntityDetails(
  entity: ProposedEntityForSync,
): Array<{ label: string; value: string }> {
  const payload = entity.payload ?? {};
  const details: Array<{ label: string; value: string }> = [];

  const area = detailValue(payload.area);
  if (area) {
    details.push({ label: "Сфера", value: area });
  }

  const status = detailValue(payload.status);
  if (status) {
    details.push({ label: "Статус", value: status });
  }

  const horizon = detailValue(payload.horizon);
  if (horizon) {
    details.push({ label: "Горизонт", value: horizon });
  }

  const desiredOutcome = detailValue(payload.desired_outcome);
  if (desiredOutcome) {
    details.push({ label: "Ожидаемый результат", value: desiredOutcome });
  }

  const nextStep = detailValue(payload.next_step);
  if (nextStep) {
    details.push({ label: "Следующий шаг", value: nextStep });
  }

  return details;
}

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    logInfo("notion_sync_started", { correlationId });

    const inboxPageId = notionTargets.Inbox ?? notionTargets.inbox;
    const goalsPageId = notionTargets.Goals ?? notionTargets.goals;
    const projectsPageId = notionTargets.Projects ?? notionTargets.projects;
    if (!inboxPageId) {
      throw new Error("NOTION_DATABASE_IDS does not contain Inbox page id");
    }

    const items = await getRows<InboxItemForSync>("inbox_items", {
      processing_status: "eq.processed",
      notion_page_id: "is.null",
      is_archived: "eq.false",
      select:
        "id,original_text,preliminary_type,preliminary_summary,created_at,notion_page_id",
      order: "created_at.asc",
      limit: 10,
    });

    let syncedCount = 0;

    for (const item of items) {
      try {
        const titleBase = item.preliminary_summary ??
          item.original_text ??
          `Inbox item ${item.id.slice(0, 8)}`;
        const title = titleBase.slice(0, 90);

        const notionPage = await createChildPage({
          parentPageId: inboxPageId,
          title,
          summary: item.preliminary_summary,
          sourceId: item.id,
          originalText: item.original_text,
        });

        await updateRows(
          "inbox_items",
          {
            id: `eq.${item.id}`,
          },
          {
            notion_page_id: notionPage.id,
            notion_synced_at: new Date().toISOString(),
            notion_last_error: null,
          },
        );

        syncedCount += 1;
      } catch (itemError) {
        await updateRows(
          "inbox_items",
          {
            id: `eq.${item.id}`,
          },
          {
            notion_last_error: itemError instanceof Error
              ? itemError.message
              : String(itemError),
          },
        );
      }
    }

    const proposedEntities = await getRows<ProposedEntityForSync>(
      "proposed_entities",
      {
        status: "eq.proposed",
        select:
          "id,inbox_item_id,entity_type,status,title,summary,payload,notion_page_id,notion_synced_at",
        order: "created_at.asc",
        limit: 50,
      },
    );

    for (
      const entity of proposedEntities.filter((item) =>
        !item.notion_page_id || !item.notion_synced_at
      )
    ) {
      const parentPageId = entity.entity_type === "goal"
        ? goalsPageId
        : entity.entity_type === "project"
        ? projectsPageId
        : null;

      if (!parentPageId) {
        continue;
      }

      try {
        const sourceRows = await getRows<InboxSource>("inbox_items", {
          id: `eq.${entity.inbox_item_id}`,
          select: "id,original_text",
          limit: 1,
        });
        const source = sourceRows[0];
        const title = (entity.title ?? entity.summary ??
          `${entity.entity_type} ${entity.id.slice(0, 8)}`).slice(0, 90);
        const details = buildEntityDetails(entity);

        if (entity.notion_page_id) {
          await updatePageTitle({
            pageId: entity.notion_page_id,
            title,
          });

          await appendPageUpdate({
            blockId: entity.notion_page_id,
            summary: entity.summary,
            sourceId: entity.id,
            originalText: source?.original_text ?? null,
            details,
          });
        } else {
          const notionPage = await createChildPage({
            parentPageId,
            title,
            summary: entity.summary,
            sourceId: entity.id,
            originalText: source?.original_text ?? null,
            details,
          });

          await updateRows(
            "proposed_entities",
            {
              id: `eq.${entity.id}`,
            },
            {
              notion_page_id: notionPage.id,
              notion_synced_at: new Date().toISOString(),
              notion_last_error: null,
            },
          );
        }

        if (entity.notion_page_id) {
          await updateRows(
            "proposed_entities",
            {
              id: `eq.${entity.id}`,
            },
            {
              notion_synced_at: new Date().toISOString(),
              notion_last_error: null,
            },
          );
        }

        syncedCount += 1;
      } catch (entityError) {
        await updateRows(
          "proposed_entities",
          {
            id: `eq.${entity.id}`,
          },
          {
            notion_last_error: entityError instanceof Error
              ? entityError.message
              : String(entityError),
          },
        );
      }
    }

    return jsonResponse({
      ok: true,
      correlationId,
      status: "completed",
      syncedCount,
    });
  } catch (error) {
    logError("notion_sync_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    return serverError();
  }
});
