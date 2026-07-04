import "dotenv/config";

const defaults = {
  HOST: "127.0.0.1",
  PORT: "8765",
  EMAIL_PROVIDER: "gmail",
  IMAP_HOST: "imap.gmail.com",
  IMAP_PORT: "993",
  EMAIL_MAILBOX: "INBOX",
  SCAN_LIMIT: "20",
  FORWARD_THRESHOLD: "70",
  POLL_INTERVAL_SECONDS: "300",
  EMAIL_FORWARDER_ENABLED: "false",
  USE_OPENAI: "false",
  OPENAI_MODEL: "gpt-4.1-mini",
  FINANCE_OPENAI_MODEL: "",
  RECEIPT_OCR_MODEL: "gpt-4.1-mini",
  GOOGLE_SHEETS_ENABLED: "false",
  GOOGLE_SHEET_NAME: "Laporan Keuangan",
  GOOGLE_SHEETS_TEMPLATE_ID: "",
  GOOGLE_SHEETS_SHARE_WITH_USER: "true",
  GOOGLE_SHEETS_SHARE_ROLE: "writer",
  SAVING_GOAL_FEATURE_ENABLED: "false",
  BACKEND_API_URL: "",
  WEB_BASE_URL: "",
  SUBSCRIPTION_PUBLIC_WEB_BASE_URL: "",
  INTERNAL_API_KEY: "",
  IMPORTANT_KEYWORDS:
    "urgent,penting,invoice,payment,pembayaran,deadline,approval,kontrak,meeting,proposal",
  IMPORTANT_SENDERS: "",
};

export function env(name) {
  return process.env[name] ?? defaults[name] ?? "";
}

export function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getConfig() {
  return {
    mysql: {
      host: env("MYSQL_HOST") || "127.0.0.1",
      port: Number(env("MYSQL_PORT") || 3306),
      user: env("MYSQL_USER") || "root",
      password: env("MYSQL_PASSWORD"),
      database: env("MYSQL_DATABASE") || "email_forwarder",
    },
    emailProvider: env("EMAIL_PROVIDER"),
    imapHost: env("IMAP_HOST"),
    imapPort: Number(env("IMAP_PORT")),
    emailAddress: env("EMAIL_ADDRESS"),
    emailPassword: env("EMAIL_PASSWORD"),
    mailbox: env("EMAIL_MAILBOX"),
    emailTelegramBotToken: env("EMAIL_TELEGRAM_BOT_TOKEN"),
    emailTelegramChatId: env("EMAIL_TELEGRAM_CHAT_ID"),
    emailTelegramAllowedChatIds: splitList(env("EMAIL_TELEGRAM_ALLOWED_CHAT_IDS")),
    financeTelegramBotToken: env("FINANCE_TELEGRAM_BOT_TOKEN"),
    financeAdminChatIds: splitList(
      env("FINANCE_ADMIN_CHAT_IDS") || env("FINANCE_TELEGRAM_ALLOWED_CHAT_IDS"),
    ),
    scanLimit: Number(env("SCAN_LIMIT")),
    forwardThreshold: Number(env("FORWARD_THRESHOLD")),
    pollIntervalSeconds: Number(env("POLL_INTERVAL_SECONDS")),
    emailForwarderEnabled: String(env("EMAIL_FORWARDER_ENABLED")).toLowerCase() === "true",
    useOpenAI: String(env("USE_OPENAI")).toLowerCase() === "true",
    openAIKey: env("OPENAI_API_KEY"),
    openAIModel: env("OPENAI_MODEL"),
    financeOpenAIModel: env("FINANCE_OPENAI_MODEL") || env("OPENAI_MODEL"),
    receiptOcrModel: env("RECEIPT_OCR_MODEL") || "gpt-4.1-mini",
    googleSheetsEnabled: String(env("GOOGLE_SHEETS_ENABLED")).toLowerCase() === "true",
    googleServiceAccountKeyFile: env("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
    googleSheetId: env("GOOGLE_SHEET_ID"),
    googleSheetName: env("GOOGLE_SHEET_NAME") || "Laporan Keuangan",
    googleSheetsTemplateId: env("GOOGLE_SHEETS_TEMPLATE_ID"),
    googleSheetsShareWithUser:
      String(env("GOOGLE_SHEETS_SHARE_WITH_USER")).toLowerCase() !== "false",
    googleSheetsShareRole: env("GOOGLE_SHEETS_SHARE_ROLE") || "writer",
    savingGoalFeatureEnabled:
      String(env("SAVING_GOAL_FEATURE_ENABLED")).toLowerCase() === "true",
    backendApiUrl: env("BACKEND_API_URL") || `http://127.0.0.1:${env("PORT") || "8765"}`,
    webBaseUrl: env("WEB_BASE_URL"),
    subscriptionPublicWebBaseUrl: env("SUBSCRIPTION_PUBLIC_WEB_BASE_URL"),
    internalApiKey: env("INTERNAL_API_KEY"),
    importantKeywords: splitList(env("IMPORTANT_KEYWORDS")),
    importantSenders: splitList(env("IMPORTANT_SENDERS")),
  };
}
