import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    logInfo("weekly_review_started", { correlationId });

    // TODO: aggregate weekly context from inbox_items, item_analysis, and proposed_entities.
    // TODO: generate the weekly review summary through the DeepSeek adapter.
    // TODO: send the result to Telegram and persist a scheduler_runs record.

    return jsonResponse({
      ok: true,
      correlationId,
      status: "scheduled",
    });
  } catch (error) {
    logError("weekly_review_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    return serverError();
  }
});
