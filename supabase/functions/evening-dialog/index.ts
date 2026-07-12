import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo } from "../_shared/log.ts";

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    logInfo("evening_dialog_started", { correlationId });

    // TODO: detect whether today's evening dialog has already been opened.
    // TODO: prepare a prompt context from inbox, proposed entities, and unfinished items.
    // TODO: enqueue or send the daily reflection message in Telegram.

    return jsonResponse({
      ok: true,
      correlationId,
      status: "scheduled",
    });
  } catch (error) {
    logError("evening_dialog_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    return serverError();
  }
});
