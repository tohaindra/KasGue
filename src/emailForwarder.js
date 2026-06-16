import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getConfig } from "./config.js";
import { ensureSchema, getDb } from "./db.js";
import { isAllowedChat, sendTelegramChat } from "./telegram.js";

let scheduler = null;
let schedulerRunning = false;

function scoreWithRules(email, config) {
  const text = `${email.sender}\n${email.subject}\n${email.body}`.toLowerCase();
  const sender = String(email.sender || "").toLowerCase();
  let score = 10;
  const reasons = [];

  for (const keyword of config.importantKeywords) {
    const needle = keyword.toLowerCase();
    if (needle && text.includes(needle)) {
      score += 18;
      reasons.push(`Mengandung kata kunci '${keyword}'`);
    }
  }
  for (const importantSender of config.importantSenders) {
    const needle = importantSender.toLowerCase();
    if (needle && sender.includes(needle)) {
      score += 35;
      reasons.push(`Pengirim cocok daftar penting: ${importantSender}`);
    }
  }
  if (String(email.subject || "").toLowerCase().includes("re:")) {
    score += 8;
    reasons.push("Bagian dari percakapan aktif");
  }
  if (email.body.length < 120 && /(urgent|asap|segera)/i.test(text)) {
    score += 12;
    reasons.push("Pesan singkat dengan sinyal urgensi");
  }
  if (!reasons.length) reasons.push("Tidak ada sinyal prioritas kuat dari aturan lokal");
  const finalScore = Math.min(score, 100);
  return {
    score: finalScore,
    shouldForward: finalScore >= config.forwardThreshold,
    reasons: reasons.slice(0, 5),
    source: "rules",
  };
}

async function scoreWithOpenAI(email, config) {
  if (!config.openAIKey) return scoreWithRules(email, config);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openAIKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.openAIModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You classify inbox email priority. Reply with compact JSON only." },
        {
          role: "user",
          content: JSON.stringify({
            sender: email.sender,
            subject: email.subject,
            date: email.date,
            body_preview: email.body.slice(0, 2500),
            instruction:
              "Nilai apakah email ini penting untuk diteruskan ke Telegram pengguna. Balas JSON valid: score 0-100, should_forward boolean, reasons array pendek.",
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return {
    score: Number(parsed.score || 0),
    shouldForward: Boolean(parsed.should_forward),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    source: "openai",
  };
}

async function classifyEmail(email, config) {
  if (!config.useOpenAI) return scoreWithRules(email, config);
  try {
    return await scoreWithOpenAI(email, config);
  } catch (error) {
    const fallback = scoreWithRules(email, config);
    return {
      ...fallback,
      source: "rules_fallback",
      reasons: [`AI gagal dipakai, fallback aturan lokal: ${error.message}`, ...fallback.reasons],
    };
  }
}

async function fetchRecentEmails(config) {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.emailAddress, pass: config.emailPassword },
  });
  await client.connect();
  const lock = await client.getMailboxLock(config.mailbox || "INBOX");

  try {
    const total = client.mailbox.exists || 0;
    const from = Math.max(1, total - config.scanLimit + 1);
    const emails = [];
    for await (const message of client.fetch(`${from}:*`, { uid: true, source: true, envelope: true })) {
      const parsed = await simpleParser(message.source);
      emails.push({
        uid: String(message.uid),
        messageId: parsed.messageId || String(message.uid),
        sender: parsed.from?.text || "",
        subject: parsed.subject || "",
        date: parsed.date?.toISOString() || "",
        body: String(parsed.text || parsed.html || "").slice(0, 5000),
      });
    }
    return emails.reverse();
  } finally {
    lock.release();
    await client.logout();
  }
}

function buildTelegramMessage(email, verdict) {
  const reasons = verdict.reasons.map((reason) => `- ${reason}`).join("\n");
  const preview = email.body.replace(/\s+/g, " ").slice(0, 700);
  return [
    "Email penting terdeteksi",
    "",
    `Skor: ${verdict.score}/100 (${verdict.source})`,
    `Dari: ${email.sender}`,
    `Subjek: ${email.subject}`,
    `Tanggal: ${email.date}`,
    "",
    "Alasan:",
    reasons,
    "",
    "Preview:",
    preview,
  ].join("\n");
}

async function sendEmailForwarderTelegram(config, text) {
  if (!config.emailTelegramBotToken || !config.emailTelegramChatId) {
    throw new Error("EMAIL_TELEGRAM_BOT_TOKEN dan EMAIL_TELEGRAM_CHAT_ID wajib diisi.");
  }
  return sendTelegramChat(config.emailTelegramBotToken, config.emailTelegramChatId, text);
}

async function wasProcessed(db, messageId) {
  const [rows] = await db.query("SELECT id FROM processed_emails WHERE message_id = ? LIMIT 1", [messageId]);
  return rows.length > 0;
}

async function saveProcessed(db, email, verdict, forwarded) {
  await db.query(
    `
      INSERT INTO processed_emails
        (message_id, uid, sender, subject, email_date, score, should_forward, forwarded, source, reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        score = VALUES(score),
        should_forward = VALUES(should_forward),
        forwarded = forwarded OR VALUES(forwarded),
        source = VALUES(source),
        reasons = VALUES(reasons)
    `,
    [
      email.messageId,
      email.uid,
      email.sender,
      email.subject,
      email.date,
      verdict.score,
      verdict.shouldForward,
      forwarded,
      verdict.source,
      JSON.stringify(verdict.reasons),
    ],
  );
}

export async function scanOnce({ send = true } = {}) {
  const config = getConfig();
  if (!config.emailForwarderEnabled) {
    return { ok: true, disabled: true, results: [], message: "Email forwarder sedang nonaktif." };
  }

  const db = await getDb();
  await ensureSchema(db);
  let scannedCount = 0;
  let forwardedCount = 0;

  try {
    const emails = await fetchRecentEmails(config);
    const results = [];
    for (const email of emails) {
      const verdict = await classifyEmail(email, config);
      const alreadyProcessed = await wasProcessed(db, email.messageId);
      let forwarded = false;
      let skippedReason = "";

      if (alreadyProcessed) {
        skippedReason = "Sudah pernah diproses";
      } else if (verdict.shouldForward && send) {
        await sendEmailForwarderTelegram(config, buildTelegramMessage(email, verdict));
        forwarded = true;
        forwardedCount += 1;
      } else if (verdict.shouldForward) {
        skippedReason = "Mode preview, belum dikirim";
      }

      await saveProcessed(db, email, verdict, forwarded);
      scannedCount += 1;
      results.push({ ...email, ...verdict, forwarded, skippedReason });
    }
    await db.query("INSERT INTO scan_runs (status, scanned_count, forwarded_count) VALUES ('ok', ?, ?)", [
      scannedCount,
      forwardedCount,
    ]);
    return { ok: true, results };
  } catch (error) {
    await db.query(
      "INSERT INTO scan_runs (status, scanned_count, forwarded_count, error_text) VALUES ('error', ?, ?, ?)",
      [scannedCount, forwardedCount, error.stack || error.message],
    );
    throw error;
  } finally {
    await db.end();
  }
}

export async function handleEmailTelegramMessage(message) {
  if (!message?.text || !message.chat?.id) return;
  const config = getConfig();
  if (!config.emailForwarderEnabled) return;
  const chatId = message.chat.id;
  if (!isAllowedChat(chatId, config.emailTelegramAllowedChatIds)) return;
  const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    return sendTelegramChat(config.emailTelegramBotToken, chatId, "Halo. Saya bot Email Forwarder.\n\nCommand:\n/email_scan - scan email dan kirim email penting\n/email_preview - scan email tanpa kirim\n/email_status - status scan email terakhir");
  }
  if (command === "/email_scan" || command === "/scan") {
    const result = await scanOnce({ send: true });
    return sendTelegramChat(config.emailTelegramBotToken, chatId, `Scan selesai. Email dicek: ${result.results.length}.`);
  }
  if (command === "/email_preview" || command === "/preview") {
    const result = await scanOnce({ send: false });
    return sendTelegramChat(config.emailTelegramBotToken, chatId, `Preview selesai. Email dicek: ${result.results.length}.`);
  }
  if (command === "/email_status" || command === "/status") {
    const status = await getEmailStatus();
    if (!status.lastRun) return sendTelegramChat(config.emailTelegramBotToken, chatId, "Belum ada scan email.");
    return sendTelegramChat(
      config.emailTelegramBotToken,
      chatId,
      `Scan terakhir: ${status.lastRun.status}\nDicek: ${status.lastRun.scanned_count}\nDikirim: ${status.lastRun.forwarded_count}\nWaktu: ${status.lastRun.created_at}`,
    );
  }
  return sendTelegramChat(config.emailTelegramBotToken, chatId, "Command tidak dikenal. Pakai /email_scan, /email_preview, atau /email_status.");
}

export async function getEmailStatus() {
  const db = await getDb();
  await ensureSchema(db);
  try {
    const [runs] = await db.query("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1");
    const [emails] = await db.query(
      "SELECT message_id, uid, sender, subject, email_date, score, should_forward, forwarded, source, reasons, created_at FROM processed_emails ORDER BY id DESC LIMIT 30",
    );
    return { lastRun: runs[0] || null, emails };
  } finally {
    await db.end();
  }
}

export function getSchedulerRunning() {
  return schedulerRunning;
}

export function startScheduler() {
  if (!getConfig().emailForwarderEnabled) {
    schedulerRunning = false;
    return;
  }
  if (scheduler) return;
  schedulerRunning = true;
  const tick = async () => {
    try {
      await scanOnce({ send: true });
    } catch (error) {
      console.error(error);
    }
  };
  tick();
  scheduler = setInterval(tick, getConfig().pollIntervalSeconds * 1000);
}

export function stopScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  schedulerRunning = false;
}

export async function testEmailTelegram() {
  const config = getConfig();
  if (!config.emailForwarderEnabled) {
    return { ok: true, disabled: true, message: "Email forwarder sedang nonaktif." };
  }
  await sendEmailForwarderTelegram(config, "Tes dari Email Telegram AI Forwarder berhasil.");
  return { ok: true };
}
