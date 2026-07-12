type TelegramMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat?: { id?: number | string };
  from?: { id?: number | string };
  voice?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number };
  audio?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number; title?: string };
  document?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number; file_name?: string };
  video?: { file_id?: string; file_unique_id?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id?: string; file_unique_id?: string; file_size?: number }>;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

export type ParsedAttachment = {
  attachmentType: string;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  mimeType?: string;
  fileName?: string;
  fileSizeBytes?: number;
};

export type ParsedTelegramUpdate = {
  updateId?: string;
  messageId?: string;
  chatId?: string;
  userId?: string;
  contentType: string;
  originalText?: string;
  messageTimestamp?: string;
  attachments: ParsedAttachment[];
};

function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.edited_message ?? update.channel_post;
}

export function parseTelegramUpdate(update: TelegramUpdate): ParsedTelegramUpdate {
  const message = pickMessage(update);
  const attachments: ParsedAttachment[] = [];

  let contentType = "unknown";
  if (message?.text) {
    contentType = "text";
  } else if (message?.voice) {
    contentType = "voice";
    attachments.push({
      attachmentType: "voice",
      telegramFileId: message.voice.file_id,
      telegramFileUniqueId: message.voice.file_unique_id,
      mimeType: message.voice.mime_type,
      fileSizeBytes: message.voice.file_size,
    });
  } else if (message?.audio) {
    contentType = "audio";
    attachments.push({
      attachmentType: "audio",
      telegramFileId: message.audio.file_id,
      telegramFileUniqueId: message.audio.file_unique_id,
      mimeType: message.audio.mime_type,
      fileName: message.audio.title,
      fileSizeBytes: message.audio.file_size,
    });
  } else if (message?.document) {
    contentType = "document";
    attachments.push({
      attachmentType: "document",
      telegramFileId: message.document.file_id,
      telegramFileUniqueId: message.document.file_unique_id,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name,
      fileSizeBytes: message.document.file_size,
    });
  } else if (message?.video) {
    contentType = "video";
    attachments.push({
      attachmentType: "video",
      telegramFileId: message.video.file_id,
      telegramFileUniqueId: message.video.file_unique_id,
      mimeType: message.video.mime_type,
      fileSizeBytes: message.video.file_size,
    });
  } else if (message?.photo?.length) {
    contentType = "photo";
    const bestPhoto = message.photo[message.photo.length - 1];
    attachments.push({
      attachmentType: "photo",
      telegramFileId: bestPhoto.file_id,
      telegramFileUniqueId: bestPhoto.file_unique_id,
      fileSizeBytes: bestPhoto.file_size,
    });
  }

  return {
    updateId: update.update_id !== undefined ? String(update.update_id) : undefined,
    messageId: message?.message_id !== undefined ? String(message.message_id) : undefined,
    chatId: message?.chat?.id !== undefined ? String(message.chat.id) : undefined,
    userId: message?.from?.id !== undefined ? String(message.from.id) : undefined,
    contentType,
    originalText: message?.text ?? message?.caption,
    messageTimestamp: message?.date ? new Date(message.date * 1000).toISOString() : undefined,
    attachments,
  };
}
