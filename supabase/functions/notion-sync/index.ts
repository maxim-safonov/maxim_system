import { requireEnv } from "../_shared/env.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { createChildPage, parseNotionTargets } from "../_shared/notion.ts";
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

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    logInfo("notion_sync_started", { correlationId });

    const inboxPageId = notionTargets.Inbox ?? notionTargets.inbox;
    if (!inboxPageId) {
      throw new Error("NOTION_DATABASE_IDS does not contain Inbox page id");
    }

    const items = await getRows<InboxItemForSync>("inbox_items", {
      processing_status: "eq.processed",
      notion_page_id: "is.null",
      is_archived: "eq.false",
      select: "id,original_text,preliminary_type,preliminary_summary,created_at,notion_page_id",
      order: "created_at.asc",
      limit: 10,
    });

    let syncedCount = 0;

    for (const item of items) {
      try {
        const titleBase =
          item.preliminary_summary ??
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
            notion_last_error: itemError instanceof Error ? itemError.message : String(itemError),
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
