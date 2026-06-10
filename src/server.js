import { env, getConfig } from "./config.js";
import { handleEmailTelegramMessage } from "./emailForwarder.js";
import { handleFinanceTelegramMessage } from "./finance.js";
import { createAppServer } from "./httpServer.js";
import { pollTelegramBot } from "./telegram.js";

const server = createAppServer();

server.listen(Number(env("PORT")), env("HOST"), () => {
  console.log(`Email Telegram AI Forwarder Node running at http://${env("HOST")}:${env("PORT")}`);
  const config = getConfig();

  if (
    config.emailTelegramBotToken &&
    config.financeTelegramBotToken &&
    config.emailTelegramBotToken === config.financeTelegramBotToken
  ) {
    console.warn("EMAIL_TELEGRAM_BOT_TOKEN dan FINANCE_TELEGRAM_BOT_TOKEN harus berbeda.");
    return;
  }

  if (config.emailForwarderEnabled) {
    pollTelegramBot("email", config.emailTelegramBotToken, handleEmailTelegramMessage);
  } else {
    console.log("Email forwarder disabled. Set EMAIL_FORWARDER_ENABLED=true to enable it.");
  }

  pollTelegramBot("finance", config.financeTelegramBotToken, handleFinanceTelegramMessage);
});
