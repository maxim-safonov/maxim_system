import { requireEnv } from "./env.ts";

const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sendTelegramMessage failed: ${response.status} ${body}`);
  }
}

type TelegramFileInfo = {
  file_path?: string;
};

type TelegramFileApiResponse = {
  ok: boolean;
  result?: TelegramFileInfo;
};

export async function downloadTelegramFile(fileId: string): Promise<{
  body: Uint8Array;
  filePath: string;
  contentType?: string | null;
}> {
  const metadataResponse = await fetch(`https://api.telegram.org/bot${telegramBotToken}/getFile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      file_id: fileId,
    }),
  });

  const metadata = await metadataResponse.json() as TelegramFileApiResponse;
  if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
    throw new Error(
      `downloadTelegramFile metadata failed: ${metadataResponse.status} ${JSON.stringify(metadata)}`,
    );
  }

  const fileResponse = await fetch(
    `https://api.telegram.org/file/bot${telegramBotToken}/${metadata.result.file_path}`,
  );

  if (!fileResponse.ok) {
    const body = await fileResponse.text();
    throw new Error(`downloadTelegramFile content failed: ${fileResponse.status} ${body}`);
  }

  return {
    body: new Uint8Array(await fileResponse.arrayBuffer()),
    filePath: metadata.result.file_path,
    contentType: fileResponse.headers.get("content-type"),
  };
}
