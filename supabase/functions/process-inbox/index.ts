import { readOptionalEnv, requireEnv } from "../_shared/env.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";
import { callRpc, getRows, insertRow, updateRows } from "../_shared/supabase.ts";
import { classifyInboxItem, getOpenRouterModel } from "../_shared/openrouter.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";

const openrouterBaseUrl = readOptionalEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
const openrouterModel = readOptionalEnv("OPENROUTER_MODEL", "openai/gpt-4.1-mini");
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

    const claimedJobs = await callRpc<ClaimedJob[]>("claim_next_processing_job", {
      worker_name: workerName,
    });

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

    const analysis = await classifyInboxItem({
      contentType: inboxItem.content_type,
      text: inboxItem.original_text,
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
      await sendTelegramMessage(
        inboxItem.external_chat_id,
        `Разобрал запись.\nТип: ${analysis.result.classification}\nКратко: ${analysis.result.summary}`,
      );
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
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
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
