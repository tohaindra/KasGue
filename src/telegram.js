const telegramOffsets = { email: 0, finance: 0 };
const botPolling = { email: false, finance: false };

export function getBotPollingState() {
  return { ...botPolling };
}

export async function telegramAPI(botToken, method, payload = {}) {
  if (!botToken) throw new Error("Telegram bot token wajib diisi.");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function sendTelegramChat(botToken, chatId, text, options = {}) {
  return telegramAPI(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options,
  });
}

export async function answerTelegramCallback(botToken, callbackQueryId, text = "") {
  return telegramAPI(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

export async function clearTelegramInlineKeyboard(botToken, chatId, messageId) {
  return telegramAPI(botToken, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function getTelegramFile(botToken, fileId) {
  const data = await telegramAPI(botToken, "getFile", { file_id: fileId });
  return data.result;
}

export async function downloadTelegramFile(botToken, filePath) {
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!response.ok) throw new Error(await response.text());
  return Buffer.from(await response.arrayBuffer());
}

export function isAllowedChat(chatId, allowedChatIds) {
  if (!allowedChatIds.length) return true;
  return allowedChatIds.includes(String(chatId));
}

export async function pollTelegramBot(kind, botToken, handler) {
  if (!botToken || botPolling[kind]) return;
  botPolling[kind] = true;

  while (botPolling[kind]) {
    try {
      const data = await telegramAPI(botToken, "getUpdates", {
        offset: telegramOffsets[kind],
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of data.result || []) {
        telegramOffsets[kind] = update.update_id + 1;
        await handler(update.message || null, update);
      }
    } catch (error) {
      const detail = error.cause?.code || error.cause?.message || "";
      console.error(`[telegram:${kind}]`, [error.message, detail].filter(Boolean).join(" - "));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
