import { requireEnv } from "../_shared/env.ts";
import { getCorrelationId } from "../_shared/correlation.ts";
import { jsonResponse, methodNotAllowed, serverError } from "../_shared/http.ts";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import { getRows, insertRow, updateRows } from "../_shared/supabase.ts";
import {
  downloadTelegramFile,
  sendTelegramMessage,
} from "../_shared/telegram.ts";
import {
  ParsedAttachment,
  parseTelegramUpdate,
} from "../_shared/telegram-update.ts";
import {
  getDefaultStorageBucket,
  uploadObject,
} from "../_shared/storage.ts";

const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
const rawBucket = getDefaultStorageBucket();

type InboxItemRow = {
  id: string;
};

type ProcessingJobRow = {
  id: string;
};

type AttachmentRow = {
  id: string;
  storage_path: string;
};

async function checksumSha256(input: Uint8Array): Promise<string> {
  const normalized = Uint8Array.from(input);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalized,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function captureAttachment(
  attachmentRow: AttachmentRow,
  attachment: ParsedAttachment,
): Promise<void> {
  if (!attachment.telegramFileId) {
    return;
  }

  const file = await downloadTelegramFile(attachment.telegramFileId);
  await uploadObject({
    bucket: rawBucket,
    path: attachmentRow.storage_path,
    body: file.body,
    contentType: attachment.mimeType ?? file.contentType,
  });

  await updateRows(
    "inbox_attachments",
    {
      id: `eq.${attachmentRow.id}`,
    },
    {
      checksum_sha256: await checksumSha256(file.body),
      downloaded_at: new Date().toISOString(),
      last_download_error: null,
      metadata: {
        telegram_file_path: file.filePath,
        stored_via: "telegram-webhook",
      },
    },
  );
}

Deno.serve(async (request) => {
  const correlationId = getCorrelationId(request);

  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const providedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (providedSecret !== webhookSecret) {
    logWarn("telegram_webhook_secret_mismatch", { correlationId });
    return jsonResponse(
      {
        ok: false,
        error: "forbidden",
      },
      { status: 403 },
    );
  }

  try {
    const update = await request.json();
    const parsed = parseTelegramUpdate(update);

    logInfo("telegram_webhook_received", {
      correlationId,
      updateId: parsed.updateId ?? null,
      contentType: parsed.contentType,
    });

    let inboxRows = parsed.updateId
      ? await getRows<InboxItemRow>("inbox_items", {
          source: "eq.telegram",
          external_update_id: `eq.${parsed.updateId}`,
          select: "id",
          limit: 1,
        })
      : [];

    if (!inboxRows.length) {
      inboxRows = await insertRow<InboxItemRow>(
        "inbox_items",
        {
          source: "telegram",
          external_update_id: parsed.updateId,
          external_message_id: parsed.messageId,
          external_chat_id: parsed.chatId,
          external_user_id: parsed.userId,
          content_type: parsed.contentType,
          original_text: parsed.originalText ?? null,
          original_payload: update,
          message_timestamp: parsed.messageTimestamp ?? null,
          correlation_id: correlationId,
          preliminary_summary: parsed.originalText?.slice(0, 160) ?? null,
        },
        {
          select: "id",
        },
      );
    }

    const inboxItem = inboxRows[0];
    if (!inboxItem?.id) {
      throw new Error("telegram_webhook_failed_to_resolve_inbox_item");
    }

    for (const attachment of parsed.attachments) {
      const storagePath = `telegram/${inboxItem.id}/${attachment.telegramFileUniqueId ?? attachment.telegramFileId ?? crypto.randomUUID()}`;

      const attachmentRows = await insertRow<AttachmentRow>(
        "inbox_attachments",
        {
          inbox_item_id: inboxItem.id,
          attachment_type: attachment.attachmentType,
          telegram_file_id: attachment.telegramFileId ?? null,
          telegram_file_unique_id: attachment.telegramFileUniqueId ?? null,
          storage_bucket: rawBucket,
          storage_path: storagePath,
          mime_type: attachment.mimeType ?? null,
          file_name: attachment.fileName ?? null,
          file_size_bytes: attachment.fileSizeBytes ?? null,
        },
        {
          onConflict: "storage_bucket,storage_path",
          select: "id,storage_path",
          ignoreDuplicates: true,
        },
      );

      const attachmentRow = attachmentRows[0];
      if (!attachmentRow) {
        continue;
      }

      try {
        await captureAttachment(attachmentRow, attachment);
      } catch (attachmentError) {
        await updateRows(
          "inbox_attachments",
          {
            id: `eq.${attachmentRow.id}`,
          },
          {
            last_download_error: attachmentError instanceof Error
              ? attachmentError.message
              : String(attachmentError),
          },
        );

        logWarn("telegram_webhook_attachment_capture_failed", {
          correlationId,
          inboxItemId: inboxItem.id,
          attachmentId: attachmentRow.id,
        });
      }
    }

    const existingJobs = await getRows<ProcessingJobRow>("processing_jobs", {
      inbox_item_id: `eq.${inboxItem.id}`,
      job_type: "eq.process-inbox",
      select: "id",
      limit: 1,
    });

    if (!existingJobs.length) {
      await insertRow(
        "processing_jobs",
        {
          inbox_item_id: inboxItem.id,
          job_type: "process-inbox",
          status: "pending",
          scheduled_for: new Date().toISOString(),
          payload: {
            source: "telegram-webhook",
          },
          correlation_id: correlationId,
        },
        {
          onConflict: "inbox_item_id,job_type",
          select: "id",
          ignoreDuplicates: true,
        },
      );
    }

    if (parsed.chatId) {
      try {
        await sendTelegramMessage(
          parsed.chatId,
          "Сохранил. Разберу и вернусь с результатом.",
        );
      } catch (replyError) {
        logWarn("telegram_webhook_ack_failed", {
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
      status: "accepted",
    });
  } catch (error) {
    logError("telegram_webhook_failed", {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });

    return serverError();
  }
});
