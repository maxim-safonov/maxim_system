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
