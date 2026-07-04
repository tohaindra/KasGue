import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { ensureSchema, getDb } from "./db.js";
import fetch from "node-fetch";
import {
  answerTelegramCallback,
  clearTelegramInlineKeyboard,
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramChat,
} from "./telegram.js";

const financeCategories = {
  makanan: "Makanan & Minuman",
  makan: "Makanan & Minuman",
  minuman: "Makanan & Minuman",
  jajan: "Makanan & Minuman",
  transport: "Transport",
  bensin: "Transport",
  ojek: "Transport",
  utilitas: "Utilitas",
  listrik: "Utilitas",
  entertainment: "Entertainment",
  hiburan: "Entertainment",
  belanja: "Belanja & Hadiah",
  kesehatan: "Kesehatan",
  gaji: "Gaji",
  pemasukan: "Pemasukan",
  income: "Pemasukan",
  lainnya: "Lainnya",
};

const incomeWords = new Set(["gaji", "pemasukan", "income", "masuk", "bonus", "fee"]);
const expenseWords = new Set(["beli", "bayar", "pengeluaran", "keluar", "jajan", "belanja"]);
const savingWords = new Set(["tabungan", "saldo", "simpanan", "deposito"]);
const foodHints = new Set(["apel", "ayam", "bakso", "buah", "kopi", "makan", "makanan", "minum", "minuman", "nanas", "nasi", "roti", "sayur", "snack"]);
const healthHints = ["rumah sakit", "dokter", "klinik", "obat", "apotek", "kesehatan"];
const billHints = ["kartu kredit", "tagihan", "cicilan", "angsuran"];

function extractAmount(text) {
  const match = String(text || "").match(
    /(?:rp\.?\s*)?(\d+(?:[.,]\d{3})*|\d+)(?:\s*(ribuan|ribu|rb|k|jutaan|juta|jt|m))?/i,
  );
  if (!match) return null;
  const suffix = String(match[2] || "").toLowerCase();
  const multiplier =
    suffix === "jutaan" || suffix === "juta" || suffix === "jt" || suffix === "m"
      ? 1000000
      : suffix === "ribuan" || suffix === "ribu" || suffix === "rb" || suffix === "k"
        ? 1000
        : 1;
  return { amount: Number(match[1].replace(/[.,]/g, "")) * multiplier, raw: match[0] };
}

function parseFinanceTransaction(text) {
  const original = String(text || "").trim();
  const words = original.toLowerCase().split(/\s+/);
  const amountInfo = extractAmount(original);
  let categoryKey = null;
  let hasExpenseSignal = false;

  if (healthHints.some((hint) => original.toLowerCase().includes(hint))) {
    categoryKey = "kesehatan";
  }
  const isBillExpense = billHints.some((hint) => original.toLowerCase().includes(hint));

  for (const word of words) {
    const normalized = word.replace(/[^a-z]/g, "");
    if (!categoryKey && financeCategories[normalized]) categoryKey = normalized;
    if (expenseWords.has(normalized)) hasExpenseSignal = true;
    if (!categoryKey && foodHints.has(normalized)) categoryKey = "makanan";
  }

  if (!categoryKey && hasExpenseSignal) categoryKey = "lainnya";
  if (!categoryKey || !amountInfo?.amount) return null;

  return {
    transactionType: incomeWords.has(categoryKey) ? "income" : "expense",
    category: isBillExpense ? "Tagihan & Cicilan" : financeCategories[categoryKey],
    description:
      original
        .replace(new RegExp(`\\b${categoryKey}\\b`, "i"), "")
        .replace(amountInfo.raw, "")
        .replace(/\b(?:dari|pakai|gunakan)\s+(?:target\s+)?(?:tabungan|simpanan)(?:\s+[^,.]+)?$/i, "")
        .replace(/\b(saya|aku|gue|ada|punya|dapat|terima|beli|bayar|pengeluaran|catat)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim() || "Tanpa deskripsi",
    amount: amountInfo.amount,
  };
}

function parseSavingSnapshot(text) {
  const original = String(text || "").trim();
  const lower = original.toLowerCase();
  const amountInfo = extractAmount(original);
  if (!amountInfo?.amount) return null;

  const words = lower.split(/\s+/).map((word) => word.replace(/[^a-z]/g, ""));
  if (!words.some((word) => savingWords.has(word))) return null;
  if (words.some((word) => expenseWords.has(word))) return null;

  const accountMatch = original.match(/\b(?:di|ke|rekening|akun)\s+(.+)$/i);
  const purposeMatch = original.match(
    /\b(?:tabungan|simpanan)\s+(?:untuk\s+)?(.+?)(?=\s+(?:dengan\s+)?saldo\b|\s+(?:sebesar|senilai)\b|\s+\d|\s+di\b|$)/i,
  );
  const purpose = purposeMatch?.[1]?.trim();
  const savingName = purpose
    ? `Tabungan ${purpose.replace(/\b\w/g, (letter) => letter.toUpperCase())}`
    : "Tabungan";
  const accountName = accountMatch?.[1]?.trim() || "Rekening tidak disebutkan";

  return {
    savingName,
    accountName,
    amount: amountInfo.amount,
    description: `Disimpan di ${accountName}`,
  };
}

function parseSavingGoalCreation(text) {
  const original = String(text || "").trim();
  if (!/^buat\s+target\s+tabungan\b/i.test(original)) return null;
  const amountInfo = extractAmount(original);
  if (!amountInfo?.amount) return null;
  const amountIndex = original.toLowerCase().indexOf(amountInfo.raw.toLowerCase());
  const name = original
    .slice(0, amountIndex)
    .replace(/^buat\s+target\s+tabungan\s+/i, "")
    .replace(/\s+sebesar\s*$/i, "")
    .trim();
  const accountName = original
    .slice(amountIndex + amountInfo.raw.length)
    .match(/\bdi\s+(.+?)(?:\s*[,;]\s*|\s+saldo\s+(?:awal|sekarang)\b|$)/i)?.[1]
    ?.trim();
  if (!name || !accountName) return null;
  const initialMatch = original.match(/\bsaldo\s+(?:awal|sekarang)\s+(?:sudah\s+)?(?:rp\.?\s*)?(\d+(?:[.,]\d{3})*|\d+)(?:\s*(ribu|rb|k|juta|jt|m))?/i);
  const initialInfo = initialMatch ? extractAmount(initialMatch[0].replace(/^.*?(?=\d)/, "")) : null;
  return {
    name,
    targetAmount: amountInfo.amount,
    accountName,
    initialAmount: initialInfo?.amount || 0,
  };
}

function parseSavingGoalDeposit(text) {
  const original = String(text || "").trim();
  if (!/^tabung\b/i.test(original)) return null;
  const amountInfo = extractAmount(original);
  const goalName = original.match(/\bke\s+(.+)$/i)?.[1]?.trim();
  if (!amountInfo?.amount || !goalName) return null;
  return { goalName, amount: amountInfo.amount };
}

function formatCurrency(amount) {
  return `Rp ${Number(amount || 0).toLocaleString("id-ID")}`;
}

function formatTelegramDateTime(unixSeconds) {
  const date = unixSeconds ? new Date(Number(unixSeconds) * 1000) : new Date();
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.day}/${value.month}/${value.year} ${value.hour}:${value.minute}`;
}

function buildRecordedMessage({ title, category, type, amount, note, message }) {
  return [
    `${title} tercatat.`,
    "",
    `⏰ Waktu : ${formatTelegramDateTime(message?.date)}`,
    `🗂 Kategori : ${category}`,
    `🧾 Tipe : ${type}`,
    `💰 Jumlah : ${formatCurrency(amount)}`,
    `📋 Catatan: ${note || "Tanpa deskripsi"}`,
  ].join("\n");
}

function compactLocation(value) {
  return String(value || "")
    .split(",")[0]
    .replace(/\b(RT|RW)\.?\s*\d+\/?\d*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSavingGoalRecordedMessage({ category, amount, note, message, goal, remaining }) {
  return [
    "Pengeluaran tercatat.",
    "",
    `⏰ Waktu : ${formatTelegramDateTime(message?.date)}`,
    `🗂 Kategori : ${category}`,
    "🧾 Tipe : Pengeluaran",
    `💰 Jumlah : ${formatCurrency(amount)}`,
    `📋 Catatan : ${note || "Tanpa deskripsi"}`,
    `🏦 Sumber Dana : ${goal.account_name}`,
    `🎯 Target Tabungan : ${goal.name}`,
    `💵 Sisa Tabungan : ${formatCurrency(remaining)}`,
  ].join("\n");
}

function buildExpenseRecordedMessage({
  category,
  amount,
  note,
  message,
  accountName,
  remainingBalance,
}) {
  const lines = [
    "Pengeluaran tercatat.",
    "",
    `⏰ Waktu : ${formatTelegramDateTime(message?.date)}`,
    `🗂 Kategori : ${category}`,
    "🧾 Tipe : Pengeluaran",
    `💰 Jumlah : ${formatCurrency(amount)}`,
    `📋 Catatan : ${note || "Tanpa deskripsi"}`,
    `🏦 Sumber Dana : ${accountName}`,
  ];
  if (remainingBalance !== undefined && remainingBalance !== null) {
    lines.push(`💵 Sisa Tabungan : ${formatCurrency(remainingBalance)}`);
  }
  return lines.join("\n");
}

function savingInputButton() {
  return {
    inline_keyboard: [[{ text: "Menu", callback_data: "menu:show" }]],
  };
}

function buildCommandMenu() {
  return [
    "Menu KasGue",
    "",
    "Laporan & Rekap:",
    "/laporan - laporan bulan ini",
    "/laporan_sheet - generate laporan Google Sheets",
    "/setsheet [link] - daftarkan Spreadsheet milik Anda",
    "/rekap - rekap bulan ini",
    "/rekap minggu - rekap minggu ini",
    "/rekap 2026-06 - rekap bulan tertentu",
    "/rekap kategori makanan - filter kategori",
    "",
    "Tabungan:",
    "/tabungan - lihat tabungan/aset tercatat",
    "/buat_tabungan - menu tabungan dan target",
    "",
    "Akun & Sinkronisasi:",
    "/sync_token - hubungkan Telegram ke aplikasi KasGue",
    "",
    "Bantuan:",
    "/ringkas - saran hemat dari AI",
    "/bantuan - tips keuangan",
  ].join("\n");
}

async function handleMainMenuCallback(config, callbackQuery) {
  await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id);
  await sendTelegramChat(
    config.financeTelegramBotToken,
    callbackQuery.message?.chat?.id,
    buildCommandMenu(),
  );
}

function savingInputMenu() {
  return {
    inline_keyboard: [
      [{ text: "Catat Tabungan Baru", callback_data: "saving:record_asset" }],
      [{ text: "Buat Target Tabungan", callback_data: "saving:create_goal" }],
      [{ text: "Tambah Saldo Target", callback_data: "saving:add_balance" }],
      [{ text: "Lihat Semua Tabungan", callback_data: "saving:view" }],
    ],
  };
}

async function handleSavingInputMenuCallback(db, config, callbackQuery) {
  const action = String(callbackQuery.data || "").split(":")[1];
  if (!action) return false;
  const chatId = callbackQuery.message?.chat?.id;
  await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id);

  if (action === "menu") {
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      "Pilih aktivitas tabungan:",
      { reply_markup: savingInputMenu() },
    );
    return true;
  }

  const messages = {
    create_goal: [
      "Buat Target Tabungan",
      "",
      "Gunakan untuk membuat tujuan menabung. Tuliskan nama target, nominal tujuan, rekening, dan saldo awal jika sudah ada.",
      "",
      "Contoh:",
      "• Buat target tabungan Dana Darurat 20 juta di blu BCA",
      "• Saya mau bikin tabungan Liburan Bali target 10 juta di Bank BCA",
      "• Buat target Beli Laptop 15 juta di Jago, saldo awal 2 juta",
      "",
      "Bot akan mengambil:",
      "🎯 Nama target: Dana Darurat",
      "💰 Target nominal: Rp 20.000.000",
      "🏦 Rekening: blu BCA",
      "💵 Saldo awal: boleh Rp0 atau saldo yang sudah terkumpul",
    ].join("\n"),
    add_balance: [
      "Tambah Saldo Target",
      "",
      "Tuliskan nominal yang ditabung dan nama targetnya.",
      "",
      "Contoh:",
      "• Tabung 500 ribu ke Dana Darurat",
      "• Tambahkan 1 juta ke tabungan Liburan Bali",
      "• Saya menabung 250 ribu untuk Beli Laptop",
    ].join("\n"),
    record_asset: [
      "Catat Tabungan Baru",
      "",
      "Gunakan untuk mencatat rekening/tabungan yang sudah dimiliki tanpa menetapkan target nominal.",
      "",
      "Contoh:",
      "• Saya punya tabungan 7 juta di blu BCA",
      "• Saldo deposito saya 25 juta di Bank BRI",
    ].join("\n"),
  };

  if (action === "view") {
    const [users] = await db.query(
      "SELECT user_id AS id FROM telegram_accounts WHERE telegram_user_id = ? LIMIT 1",
      [Number(callbackQuery.from?.id || 0)],
    );
    const goals = users[0]?.id ? await getActiveSavingGoals(db, users[0].id) : [];
    const assets = users[0]?.id ? await getSavingAssetSummary(db, users[0].id) : [];
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      buildCompleteSavingReport(goals, assets),
      { reply_markup: savingInputButton() },
    );
    return true;
  }

  if (messages[action]) {
    await sendTelegramChat(config.financeTelegramBotToken, chatId, messages[action], {
      reply_markup: savingInputButton(),
    });
    return true;
  }
  return false;
}

function slugify(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lainnya"
  );
}

async function upsertFinanceUser(db, message) {
  const user = message.from || {};
  const chat = message.chat || {};
  const telegramUserId = Number(user.id || 0);
  const [existing] = await db.query(
    "SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ? LIMIT 1",
    [telegramUserId],
  );
  if (!existing.length) {
    const userId = randomUUID();
    await db.query(
      "INSERT INTO users (id, status) VALUES (?, 'telegram_only')",
      [userId],
    );
    await db.query(
      `INSERT INTO telegram_accounts
        (id, user_id, telegram_user_id, telegram_chat_id, telegram_username,
         first_name, last_name, language_code, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        randomUUID(),
        userId,
        telegramUserId,
        Number(chat.id || 0),
        user.username || null,
        user.first_name || null,
        user.last_name || null,
        user.language_code || null,
      ],
    );
  }
  await db.query(
    `
      UPDATE telegram_accounts SET
        telegram_chat_id = ?,
        telegram_username = ?,
        first_name = ?,
        last_name = ?,
        language_code = ?,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE telegram_user_id = ?
    `,
    [
      Number(chat.id || 0),
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      user.language_code || null,
      telegramUserId,
    ],
  );
  const [rows] = await db.query(
    `SELECT u.*, ta.id AS telegram_account_id, ta.telegram_user_id,
            ta.telegram_chat_id, ta.telegram_username, ta.first_name, ta.last_name,
            ta.language_code, ta.access_status, ta.registration_step,
            ta.approved_by_user_id, ta.approved_at, ta.rejected_at, ta.last_seen_at
     FROM telegram_accounts ta
     JOIN users u ON u.id = ta.user_id
     WHERE ta.telegram_user_id = ? LIMIT 1`,
    [telegramUserId],
  );
  return rows[0];
}

async function getOrCreateDefaultAccount(db, userId) {
  const [existing] = await db.query(
    "SELECT id, name FROM bank_wallet_account WHERE user_id = ? AND is_default = TRUE LIMIT 1",
    [userId],
  );
  if (existing.length) return existing[0];
  const accountId = randomUUID();
  await db.query(
    "INSERT INTO bank_wallet_account (id, user_id, name, account_type, currency, is_default) VALUES (?, ?, 'Dompet Utama', 'cash', 'IDR', TRUE)",
    [accountId, userId],
  );
  return { id: accountId, name: "Dompet Utama" };
}

async function getOrCreateAccountByName(
  db,
  userId,
  accountName,
  openingBalance = 0,
  institutionName = null,
) {
  const [existing] = await db.query(
    "SELECT id, name, institution_name FROM bank_wallet_account WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1",
    [userId, accountName],
  );
  if (existing.length) return existing[0];
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO bank_wallet_account
      (id, user_id, name, institution_name, account_type, currency, opening_balance, is_default)
     VALUES (?, ?, ?, ?, 'bank', 'IDR', ?, FALSE)`,
    [accountId, userId, accountName, institutionName, Number(openingBalance || 0)],
  );
  return { id: accountId, name: accountName };
}

async function createSavingGoal(db, financeUser, input) {
  const account = await getOrCreateAccountByName(db, financeUser.id, input.accountName);
  const [existing] = await db.query(
    `SELECT id FROM saving_goals
     WHERE user_id = ? AND LOWER(name) = LOWER(?) AND status = 'active' LIMIT 1`,
    [financeUser.id, input.name],
  );
  if (existing.length) throw new Error(`Target Tabungan ${input.name} sudah ada.`);
  const id = randomUUID();
  await db.query(
    `INSERT INTO saving_goals
      (id, user_id, bank_wallet_account_id, name, target_amount, initial_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      financeUser.id,
      account.id,
      input.name,
      input.targetAmount,
      Number(input.initialAmount || 0),
    ],
  );
  return {
    ...input,
    id,
    accountName: account.name,
    account_name: account.name,
    bank_wallet_account_id: account.id,
    bank_wallet_account_id: account.id,
    balance: Number(input.initialAmount || 0),
  };
}

async function resumePendingExpenseWithGoal(db, config, financeUser, goal, chatId) {
  const [rows] = await db.query(
    `SELECT * FROM transaction_drafts
     WHERE user_id = ? AND status = 'pending' AND expires_at > NOW()
       AND JSON_EXTRACT(context, '$.awaiting_saving_goal_creation') = TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [financeUser.id],
  );
  const draft = rows[0];
  if (!draft) return false;
  const payload = typeof draft.payload === "string" ? JSON.parse(draft.payload) : draft.payload;
  await db.query(
    `UPDATE transaction_drafts
     SET saving_goal_id = ?, bank_wallet_account_id = ?,
         context = JSON_SET(context, '$.awaiting_saving_goal_creation', FALSE)
     WHERE id = ?`,
    [goal.id, goal.bank_wallet_account_id, draft.id],
  );
  await sendTelegramChat(
    config.financeTelegramBotToken,
    chatId,
    buildExpenseConfirmation(payload, goal),
    { reply_markup: expenseConfirmationKeyboard(draft.id, true) },
  );
  return true;
}

async function addSavingGoalDeposit(db, financeUser, input) {
  const goals = await getActiveSavingGoals(db, financeUser.id);
  const normalized = input.goalName.toLowerCase();
  const goal =
    goals.find((item) => item.name.toLowerCase() === normalized) ||
    goals.find((item) => item.name.toLowerCase().includes(normalized));
  if (!goal) throw new Error(`Target Tabungan ${input.goalName} tidak ditemukan.`);
  await db.query(
    `INSERT INTO saving_goal_entries
      (id, saving_goal_id, transaction_id, entry_type, amount, entry_date, note)
     VALUES (?, ?, NULL, 'deposit', ?, CURRENT_DATE(), 'Input dari Telegram')`,
    [randomUUID(), goal.id, input.amount],
  );
  return { ...goal, balance: Number(goal.balance) + Number(input.amount) };
}

async function getOrCreateCategory(db, transactionType, categoryName) {
  const slug = slugify(categoryName);
  const [existing] = await db.query(
    "SELECT id FROM finance_categories WHERE user_id IS NULL AND transaction_type = ? AND slug = ? LIMIT 1",
    [transactionType, slug],
  );
  if (existing.length) return existing[0].id;
  const categoryId = randomUUID();
  await db.query(
    "INSERT INTO finance_categories (id, user_id, transaction_type, slug, name, is_system) VALUES (?, NULL, ?, ?, ?, TRUE)",
    [categoryId, transactionType, slug, categoryName],
  );
  return categoryId;
}

async function saveFinanceTransaction(db, tx, message, savingGoal = null, fundingAccount = null) {
  const chat = message.chat || {};
  const financeUser = await upsertFinanceUser(db, message);
  const defaultAccount = await getOrCreateDefaultAccount(db, financeUser.id);
  const bankWalletAccountId =
    savingGoal?.bank_wallet_account_id ||
    fundingAccount?.bank_wallet_account_id ||
    defaultAccount.id;
  const transactionId = randomUUID();
  const categoryId = await getOrCreateCategory(db, tx.transactionType, tx.category);
  await db.query(
    `
      INSERT INTO transactions
        (id, user_id, bank_wallet_account_id, category_id, transaction_type, amount, currency, description, raw_text, source, source_message_id, source_chat_id, saving_goal_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, 'IDR', ?, ?, 'telegram_bot', ?, ?, ?, NOW())
    `,
    [
      transactionId,
      financeUser.id,
      bankWalletAccountId,
      categoryId,
      tx.transactionType,
      tx.amount,
      tx.description,
      message.text || null,
      Number(message.message_id || 0),
      Number(chat.id || 0),
      savingGoal?.id || null,
    ],
  );
  if (savingGoal) {
    await db.query(
      `INSERT INTO saving_goal_entries
        (id, saving_goal_id, transaction_id, entry_type, amount, entry_date, note)
       VALUES (?, ?, ?, 'expense', ?, CURRENT_DATE(), ?)`,
      [randomUUID(), savingGoal.id, transactionId, tx.amount, tx.description],
    );
  }
  return {
    financeUser,
    transactionId,
    accountName: savingGoal?.account_name || fundingAccount?.account_name || defaultAccount.name,
  };
}

async function saveSavingSnapshot(db, saving, message) {
  const chat = message.chat || {};
  const financeUser = await upsertFinanceUser(db, message);
  await getOrCreateAccountByName(
    db,
    financeUser.id,
    saving.accountName,
    saving.amount,
  );
  await db.query(
    `
      INSERT INTO finance_savings
        (id, user_id, saving_name, account_name, amount, currency, description, raw_text, source, source_message_id, source_chat_id, observed_at)
      VALUES (?, ?, ?, ?, ?, 'IDR', ?, ?, 'telegram', ?, ?, NOW())
    `,
    [
      randomUUID(),
      financeUser.id,
      saving.savingName,
      saving.accountName,
      saving.amount,
      saving.description,
      message.text || null,
      Number(message.message_id || 0),
      Number(chat.id || 0),
    ],
  );
}

function pickLargestPhoto(photos = []) {
  return [...photos].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
}

function getOwnerHintsFromUser(financeUser) {
  const fullName = financeUser?.full_name || [financeUser?.first_name, financeUser?.last_name].filter(Boolean).join(" ");
  return {
    names: [fullName, financeUser?.first_name, financeUser?.last_name].filter(Boolean),
    accounts: [],
  };
}

async function ocrReceiptImage(imageBuffer, ownerHints, mimeType = "image/jpeg") {
  const config = getConfig();
  if (!config.openAIKey) throw new Error("OPENAI_API_KEY wajib diisi untuk OCR struk.");
  const imageDataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openAIKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.receiptOcrModel,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Anda OCR struk belanja Indonesia. Ekstrak hanya data yang terlihat. Balas JSON valid tanpa markdown.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Baca gambar bukti transaksi Indonesia ini. Bisa berupa struk belanja Alfamart/Indomaret atau bukti transfer bank/e-wallet seperti myBCA/BRI Mobile. Pemilik akun/pengguna aplikasi ini kemungkinan bernama: ${ownerHints.names.join(", ") || "(tidak diisi)"}. Hint rekening/akun milik pengguna: ${ownerHints.accounts.join(", ") || "(tidak diisi)"}. Balas JSON: document_type salah satu receipt_expense, transfer_income, transfer_expense, unknown; confidence 0-1; merchant_name, merchant_branch, receipt_number, bank_name, sender_name, sender_account, sender_bank, receiver_name, receiver_account, receiver_bank, transaction_datetime ISO atau null, subtotal, discount_total, tax_total, total_amount, payment_method, items array berisi item_name, quantity, unit_price, line_total, category_name. Untuk bukti transfer: jika bagian Tujuan/Penerima cocok dengan nama atau rekening pemilik akun, document_type harus transfer_income; jika bagian Sumber Dana/Pengirim cocok dengan pemilik akun, document_type transfer_expense. Jika ragu, document_type unknown dan total_amount null.`,
            },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function toMysqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 19).replace("T", " ");
  }
  const cleaned = String(value).replace("T", " ").replace(/Z$/, "").slice(0, 19);
  return /^\d{4}-\d{2}-\d{2}/.test(cleaned) ? cleaned : null;
}

function normalizeComparable(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function includesAnyNeedle(value, needles) {
  const normalizedValue = normalizeComparable(value);
  return needles.some((needle) => {
    const normalizedNeedle = normalizeComparable(needle);
    return normalizedNeedle && normalizedValue.includes(normalizedNeedle);
  });
}

function applyOwnerDirectionOverride(receipt, ownerHints) {
  const ownerNames = ownerHints.names || [];
  const ownerAccounts = ownerHints.accounts || [];
  const receiverText = [receipt.receiver_name, receipt.receiver_account, receipt.receiver_bank].filter(Boolean).join(" ");
  const senderText = [receipt.sender_name, receipt.sender_account, receipt.sender_bank].filter(Boolean).join(" ");

  if (includesAnyNeedle(receiverText, [...ownerNames, ...ownerAccounts])) {
    return { ...receipt, document_type: "transfer_income", direction_override: "receiver_matches_owner" };
  }
  if (includesAnyNeedle(senderText, [...ownerNames, ...ownerAccounts])) {
    return { ...receipt, document_type: "transfer_expense", direction_override: "sender_matches_owner" };
  }
  return receipt;
}

async function saveReceiptFromOcr(
  db,
  receipt,
  message,
  fileId,
  savingGoal = null,
  fundingAccount = null,
) {
  const financeUser = await upsertFinanceUser(db, message);
  const ownerHints = getOwnerHintsFromUser(financeUser);
  receipt = applyOwnerDirectionOverride(receipt, ownerHints);
  const defaultAccount = await getOrCreateDefaultAccount(db, financeUser.id);
  const bankWalletAccountId =
    savingGoal?.bank_wallet_account_id ||
    fundingAccount?.bank_wallet_account_id ||
    defaultAccount.id;
  const totalAmount = asNumber(receipt.total_amount);
  const transactionAt = toMysqlDateTime(receipt.transaction_datetime);
  if (!totalAmount) throw new Error("Total struk tidak terbaca. Coba foto ulang lebih jelas.");

  const documentType = String(receipt.document_type || "receipt_expense").toLowerCase();
  const transactionType = documentType === "transfer_income" ? "income" : "expense";
  const categoryName =
    documentType === "transfer_income"
      ? "Transfer Masuk"
      : documentType === "transfer_expense"
        ? "Transfer Keluar"
        : "Belanja & Hadiah";
  const categoryId = await getOrCreateCategory(db, transactionType, categoryName);

  const description =
    documentType === "transfer_income" || documentType === "transfer_expense"
      ? [
          receipt.bank_name || "Bukti transfer",
          receipt.sender_name ? `dari ${receipt.sender_name}` : "",
          receipt.receiver_name ? `ke ${receipt.receiver_name}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : `${receipt.merchant_name || "Struk belanja"}${receipt.merchant_branch ? ` ${receipt.merchant_branch}` : ""}`.trim();
  const transactionId = randomUUID();
  await db.query(
    `
      INSERT INTO transactions
        (id, user_id, bank_wallet_account_id, category_id, transaction_type, amount, currency, description, raw_text, source, source_message_id, source_chat_id, saving_goal_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, 'IDR', ?, ?, 'telegram_bot', ?, ?, ?, COALESCE(?, NOW()))
    `,
    [
      transactionId,
      financeUser.id,
      bankWalletAccountId,
      categoryId,
      transactionType,
      totalAmount,
      description,
      "OCR receipt",
      Number(message.message_id || 0),
      Number(message.chat?.id || 0),
      savingGoal?.id || null,
      transactionAt,
    ],
  );

  if (savingGoal && transactionType === "expense") {
    await db.query(
      `INSERT INTO saving_goal_entries
        (id, saving_goal_id, transaction_id, entry_type, amount, entry_date, note)
       VALUES (?, ?, ?, 'expense', ?, COALESCE(DATE(?), CURRENT_DATE()), ?)`,
      [randomUUID(), savingGoal.id, transactionId, totalAmount, transactionAt, description],
    );
  }

  const receiptId = randomUUID();
  await db.query(
    `
      INSERT INTO finance_receipts
        (
          id, user_id, transaction_id, merchant_name, merchant_branch, receipt_number,
          document_type, bank_name, sender_name, receiver_name, transaction_at,
          subtotal, discount_total, tax_total, total_amount, payment_method,
          source_chat_id, source_message_id, telegram_file_id, ocr_model, ocr_raw, status
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed')
    `,
    [
      receiptId,
      financeUser.id,
      transactionId,
      receipt.merchant_name || null,
      receipt.merchant_branch || null,
      receipt.receipt_number || null,
      documentType,
      receipt.bank_name || null,
      receipt.sender_name || null,
      receipt.receiver_name || null,
      transactionAt,
      asNumber(receipt.subtotal),
      asNumber(receipt.discount_total),
      asNumber(receipt.tax_total),
      totalAmount,
      receipt.payment_method || null,
      Number(message.chat?.id || 0),
      Number(message.message_id || 0),
      fileId,
      getConfig().receiptOcrModel,
      JSON.stringify(receipt),
    ],
  );

  for (const item of Array.isArray(receipt.items) ? receipt.items : []) {
    if (!item?.item_name) continue;
    await db.query(
      `
        INSERT INTO finance_receipt_items
          (id, receipt_id, item_name, quantity, unit_price, line_total, category_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        receiptId,
        String(item.item_name).slice(0, 255),
        asNumber(item.quantity),
        asNumber(item.unit_price),
        asNumber(item.line_total),
        item.category_name || null,
      ],
    );
  }

  return {
    financeUser,
    transactionId,
    receiptId,
    totalAmount,
    transactionType,
    categoryName,
    documentType,
    accountName: savingGoal?.account_name || fundingAccount?.account_name || defaultAccount.name,
  };
}

async function handleReceiptPhoto(db, config, message) {
  const financeUser = await upsertFinanceUser(db, message);
  const ownerHints = getOwnerHintsFromUser(financeUser);
  const photo = pickLargestPhoto(message.photo);
  if (!photo?.file_id) {
    return sendTelegramChat(config.financeTelegramBotToken, message.chat.id, "Foto struk tidak terbaca. Coba kirim ulang.");
  }
  await sendTelegramChat(config.financeTelegramBotToken, message.chat.id, "Saya baca struknya dulu ya...");
  const file = await getTelegramFile(config.financeTelegramBotToken, photo.file_id);
  const imageBuffer = await downloadTelegramFile(config.financeTelegramBotToken, file.file_path);
  let receipt = await ocrReceiptImage(imageBuffer, ownerHints, "image/jpeg");
  receipt = applyOwnerDirectionOverride(receipt, ownerHints);
  const documentType = String(receipt.document_type || "receipt_expense").toLowerCase();
  if (config.savingGoalFeatureEnabled && documentType !== "transfer_income") {
    const merchantNote =
      receipt.merchant_name || receipt.bank_name
        ? `${receipt.merchant_name || receipt.bank_name}${compactLocation(receipt.merchant_branch) ? ` - ${compactLocation(receipt.merchant_branch)}` : ""}`
        : "Dari gambar";
    const payload = {
      receipt,
      fileId: photo.file_id,
      message: compactTelegramMessage(message),
      category: documentType === "transfer_expense" ? "Transfer Keluar" : "Belanja & Hadiah",
      amount: asNumber(receipt.total_amount),
      note: String(message.caption || "").trim() || merchantNote,
    };
    return await createAndSendExpenseDraft(db, config, financeUser, "receipt_expense", payload);
  }
  const saved = await saveReceiptFromOcr(db, receipt, message, photo.file_id);
  const label = saved.transactionType === "income" ? "Pemasukan" : "Pengeluaran";
  const merchantNote =
    receipt.merchant_name || receipt.bank_name
      ? `${receipt.merchant_name || receipt.bank_name}${compactLocation(receipt.merchant_branch) ? ` - ${compactLocation(receipt.merchant_branch)}` : ""}`
      : "Dari gambar";
  const userCaption = String(message.caption || "").trim();
  return sendTelegramChat(
    config.financeTelegramBotToken,
    message.chat.id,
    buildRecordedMessage({
      title: label,
      category: saved.categoryName,
      type: label,
      amount: saved.totalAmount,
      note: userCaption || merchantNote,
      message,
    }),
    { reply_markup: savingInputButton() },
  );
}

function compactTelegramMessage(message) {
  return {
    message_id: Number(message.message_id || 0),
    date: Number(message.date || Math.floor(Date.now() / 1000)),
    text: message.text || null,
    caption: message.caption || null,
    chat: { id: Number(message.chat?.id || 0) },
    from: {
      id: Number(message.from?.id || 0),
      username: message.from?.username || null,
      first_name: message.from?.first_name || null,
      last_name: message.from?.last_name || null,
      language_code: message.from?.language_code || null,
    },
  };
}

async function getActiveSavingGoals(db, userUuid) {
  const [rows] = await db.query(
    `
      SELECT
        sg.id, sg.name, sg.target_amount, sg.initial_amount, sg.target_date,
        sg.bank_wallet_account_id,
        a.id AS bank_wallet_account_id, a.name AS account_name,
        sg.initial_amount + COALESCE(SUM(
          CASE
            WHEN sge.entry_type IN ('initial_allocation', 'deposit', 'contribution', 'transfer_in') THEN sge.amount
            WHEN sge.entry_type IN ('expense', 'withdrawal', 'transfer_out') THEN -sge.amount
            ELSE 0
          END
        ), 0) AS balance
      FROM saving_goals sg
      JOIN bank_wallet_account a ON a.id = sg.bank_wallet_account_id
      LEFT JOIN saving_goal_entries sge ON sge.saving_goal_id = sg.id
      WHERE sg.user_id = ? AND sg.status = 'active'
      GROUP BY sg.id, sg.name, sg.initial_amount, sg.bank_wallet_account_id, a.id, a.name
      ORDER BY sg.created_at ASC, sg.name ASC
    `,
    [userUuid],
  );
  return rows;
}

async function getSavingFundingAccounts(db, userUuid) {
  const [rows] = await db.query(
    `
      SELECT
        a.id AS bank_wallet_account_id,
        COALESCE(NULLIF(TRIM(a.institution_name), ''), a.name) AS account_name,
        NULL AS institution_name,
        a.opening_balance + COALESCE(SUM(
          CASE
            WHEN t.transaction_type = 'income' THEN t.amount
            WHEN t.transaction_type = 'expense' THEN -t.amount
            ELSE 0
          END
        ), 0) AS balance
      FROM bank_wallet_account a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN transactions t ON t.bank_wallet_account_id = a.id AND t.deleted_at IS NULL
      LEFT JOIN saving_goals sg
        ON sg.bank_wallet_account_id = a.id AND sg.status = 'active'
      WHERE u.id = ?
        AND a.is_default = FALSE
        AND a.archived_at IS NULL
        AND sg.id IS NULL
        AND NOT (
          NULLIF(TRIM(a.institution_name), '') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM bank_wallet_account canonical
            WHERE canonical.user_id = a.user_id
              AND canonical.id <> a.id
              AND canonical.archived_at IS NULL
              AND LOWER(canonical.name) = LOWER(a.institution_name)
          )
        )
      GROUP BY a.id, a.name, a.institution_name, a.opening_balance
      ORDER BY a.created_at ASC, a.name ASC
    `,
    [userUuid],
  );
  return rows;
}

async function getSavingAssetSummary(db, userUuid) {
  const accounts = await getSavingFundingAccounts(db, userUuid);
  return accounts.map((account) => ({
    ...account,
    amount: Number(account.balance || 0),
  }));
}

function findMentionedSavingGoal(text, goals) {
  const normalized = String(text || "").toLowerCase();
  return goals.find((goal) => normalized.includes(String(goal.name).toLowerCase())) || null;
}

async function createTransactionDraft(db, financeUser, draftType, payload, savingGoal = null) {
  const id = randomUUID();
  const categoryId = await getOrCreateCategory(db, "expense", payload.category);
  const occurredAt = new Date(Number(payload.message?.date || Date.now() / 1000) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await db.query(
    `INSERT INTO transaction_drafts
      (id, user_id, bank_wallet_account_id, category_id,
       transaction_type, amount, currency, description, occurred_at,
       source, source_reference, context, draft_type, payload, saving_goal_id, expires_at)
     VALUES (?, ?, ?, ?, 'expense', ?, 'IDR', ?, ?, 'telegram_bot', ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
    [
      id,
      financeUser.id,
      savingGoal?.bank_wallet_account_id || null,
      categoryId,
      payload.amount,
      payload.note || null,
      occurredAt,
      `telegram:${Number(payload.message?.chat?.id || 0)}:${Number(payload.message?.message_id || 0)}`,
      JSON.stringify({
        chat_id: Number(payload.message?.chat?.id || 0),
        message_id: Number(payload.message?.message_id || 0),
      }),
      draftType,
      JSON.stringify(payload),
      savingGoal?.id || null,
    ],
  );
  return id;
}

function buildExpenseConfirmation(payload, goal = null, fundingAccount = null) {
  const lines = [
    "Konfirmasi pengeluaran:",
    "",
    `🗂 Kategori : ${payload.category}`,
    `💰 Jumlah : ${formatCurrency(payload.amount)}`,
    `📋 Catatan : ${payload.note || "Tanpa deskripsi"}`,
  ];
  if (goal) {
    lines.push(`🏦 Sumber Dana : ${goal.account_name}`);
    lines.push(`🎯 Target Tabungan : ${goal.name}`);
    lines.push(`💵 Saldo Saat Ini : ${formatCurrency(goal.balance)}`);
    lines.push(
      `💵 Sisa Setelah Disimpan : ${formatCurrency(Number(goal.balance) - Number(payload.amount))}`,
    );
  } else if (fundingAccount) {
    lines.push(
      `🏦 Sumber Dana : ${fundingAccount.account_name}${fundingAccount.institution_name ? ` - ${fundingAccount.institution_name}` : ""}`,
    );
    lines.push(`💵 Saldo Saat Ini : ${formatCurrency(fundingAccount.balance)}`);
    lines.push(
      `💵 Sisa Setelah Disimpan : ${formatCurrency(
        Number(fundingAccount.balance) - Number(payload.amount),
      )}`,
    );
  }
  return lines.join("\n");
}

function expenseConfirmationKeyboard(draftId, hasGoal, hasFundingAccount = false) {
  return {
    inline_keyboard: [
      [
        { text: "Simpan", callback_data: `sg:save:${draftId}` },
        {
          text: hasGoal || hasFundingAccount ? "Ganti Sumber" : "Ambil dari Tabungan",
          callback_data: `sg:choose:${draftId}`,
        },
      ],
      [{ text: "Batal", callback_data: `sg:cancel:${draftId}` }],
    ],
  };
}

async function createAndSendExpenseDraft(db, config, financeUser, draftType, payload) {
  if (!payload.amount) throw new Error("Nominal pengeluaran tidak terbaca.");
  const goals = await getActiveSavingGoals(db, financeUser.id);
  const fundingAccounts = await getSavingFundingAccounts(db, financeUser.id);
  const sourceText = payload.message?.caption || payload.message?.text || "";
  const mentionedGoal =
    findMentionedSavingGoal(sourceText, goals) ||
    findMentionedSavingGoal(payload.savingGoalName, goals);
  const draftId = await createTransactionDraft(
    db,
    financeUser,
    draftType,
    payload,
    mentionedGoal,
  );
  if (
    !mentionedGoal &&
    (payload.usesSavingGoal || /\b(?:dari|pakai|gunakan)\s+(?:target\s+)?(?:tabungan|simpanan)\b/i.test(sourceText))
  ) {
    return sendSavingGoalChoices(
      config,
      payload.message.chat.id,
      draftId,
      goals,
      fundingAccounts,
    );
  }
  return sendTelegramChat(
    config.financeTelegramBotToken,
    payload.message.chat.id,
    buildExpenseConfirmation(payload, mentionedGoal),
    { reply_markup: expenseConfirmationKeyboard(draftId, Boolean(mentionedGoal)) },
  );
}

async function sendSavingGoalChoices(config, chatId, draftId, goals, fundingAccounts = []) {
  if (!goals.length && !fundingAccounts.length) {
    return sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      [
        "Anda belum memiliki Target Tabungan aktif.",
        "",
        "Pengeluaran belum disimpan. Anda bisa mencatatnya dari Dompet Utama atau membatalkan pencatatan.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Buat Target Tabungan", callback_data: `sg:new:${draftId}` }],
            [{ text: "Catat dari Dompet Utama", callback_data: `sg:save:${draftId}` }],
            [{ text: "Batal", callback_data: `sg:cancel:${draftId}` }],
          ],
        },
      },
    );
  }
  return sendTelegramChat(
    config.financeTelegramBotToken,
    chatId,
    "Pilih sumber tabungan yang akan dipakai:",
    {
      reply_markup: {
        inline_keyboard: [
          ...goals.map((goal, index) => [
            {
              text: `${goal.name} (${formatCurrency(goal.balance)})`,
              callback_data: `sg:goal:${draftId}:${index}`,
            },
          ]),
          ...fundingAccounts.map((account, index) => [
            {
              text: `${account.account_name}${account.institution_name ? ` - ${account.institution_name}` : ""} (${formatCurrency(account.balance)})`,
              callback_data: `sg:account:${draftId}:${index}`,
            },
          ]),
          [{ text: "Batal", callback_data: `sg:cancel:${draftId}` }],
        ],
      },
    },
  );
}

async function getDraftForCallback(db, draftId, telegramUserId) {
  const [rows] = await db.query(
    `SELECT d.*, ta.telegram_user_id
     FROM transaction_drafts d
     JOIN telegram_accounts ta ON ta.user_id = d.user_id
     WHERE d.id = ? AND ta.telegram_user_id = ? AND d.status = 'pending'
       AND d.expires_at > NOW() LIMIT 1`,
    [draftId, Number(telegramUserId || 0)],
  );
  return rows[0] || null;
}

async function getSavingGoalById(db, goalId, userUuid) {
  const goals = await getActiveSavingGoals(db, userUuid);
  return goals.find((goal) => goal.id === goalId) || null;
}

async function getSavingFundingAccountById(db, accountUuid, userUuid) {
  const accounts = await getSavingFundingAccounts(db, userUuid);
  return accounts.find((account) => account.bank_wallet_account_id === accountUuid) || null;
}

async function handleSavingGoalCallback(db, config, callbackQuery) {
  const data = String(callbackQuery.data || "");
  const parts = data.split(":");
  if (parts[0] !== "sg") return false;
  if (!config.savingGoalFeatureEnabled) {
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Fitur Target Tabungan sedang dinonaktifkan.");
    return true;
  }
  const action = parts[1];
  const draftId = parts[2];
  const draft = await getDraftForCallback(db, draftId, callbackQuery.from?.id);
  if (!draft) {
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Konfirmasi sudah kedaluwarsa atau diproses.");
    return true;
  }
  const payload = typeof draft.payload === "string" ? JSON.parse(draft.payload) : draft.payload;
  const chatId = callbackQuery.message?.chat?.id || payload.message?.chat?.id;

  if (action === "cancel") {
    await db.query("UPDATE transaction_drafts SET status = 'cancelled' WHERE id = ?", [draftId]);
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Dibatalkan.");
    await clearTelegramInlineKeyboard(config.financeTelegramBotToken, chatId, callbackQuery.message.message_id);
    await sendTelegramChat(config.financeTelegramBotToken, chatId, "Pencatatan pengeluaran dibatalkan.");
    return true;
  }

  const goals = await getActiveSavingGoals(db, draft.user_id);
  const fundingAccounts = await getSavingFundingAccounts(db, draft.user_id);
  if (action === "choose") {
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id);
    await sendSavingGoalChoices(config, chatId, draftId, goals, fundingAccounts);
    return true;
  }

  if (action === "new") {
    await db.query(
      `UPDATE transaction_drafts
       SET context = JSON_SET(COALESCE(context, JSON_OBJECT()), '$.awaiting_saving_goal_creation', TRUE)
       WHERE id = ?`,
      [draftId],
    );
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id);
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      [
        "Buat Target Tabungan",
        "",
        "Tuliskan nama target, nominal tujuan, dan rekening penyimpanannya.",
        "",
        "Contoh:",
        "• Buat target tabungan Dana Darurat 20 juta di blu BCA",
        "• Saya mau bikin tabungan Biaya Rumah Sakit target 5 juta di Bank BCA",
        "• Buatkan target Liburan 10 juta di Jago",
        "",
        "Setelah target dibuat, pengeluaran ini akan kembali ditampilkan untuk dikonfirmasi.",
      ].join("\n"),
    );
    return true;
  }

  if (action === "goal") {
    const selected = goals[Number(parts[3])];
    if (!selected) {
      await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Target tidak tersedia.");
      return true;
    }
    await db.query(
      "UPDATE transaction_drafts SET saving_goal_id = ?, bank_wallet_account_id = ? WHERE id = ?",
      [selected.id, selected.bank_wallet_account_id, draftId],
    );
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Target dipilih.");
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      buildExpenseConfirmation(payload, selected),
      { reply_markup: expenseConfirmationKeyboard(draftId, true) },
    );
    return true;
  }

  if (action === "account") {
    const selected = fundingAccounts[Number(parts[3])];
    if (!selected) {
      await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Tabungan tidak tersedia.");
      return true;
    }
    await db.query(
      "UPDATE transaction_drafts SET saving_goal_id = NULL, bank_wallet_account_id = ? WHERE id = ?",
      [selected.bank_wallet_account_id, draftId],
    );
    await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Sumber dana dipilih.");
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      buildExpenseConfirmation(payload, null, selected),
      { reply_markup: expenseConfirmationKeyboard(draftId, false, true) },
    );
    return true;
  }

  if (action !== "save") return true;
  const goal = draft.saving_goal_id
    ? await getSavingGoalById(db, draft.saving_goal_id, draft.user_id)
    : null;
  const fundingAccount =
    !goal && draft.bank_wallet_account_id
      ? await getSavingFundingAccountById(db, draft.bank_wallet_account_id, draft.user_id)
      : null;
  const connection = await db.getConnection();
  let saved;
  try {
    await connection.beginTransaction();
    if (draft.draft_type === "receipt_expense") {
      saved = await saveReceiptFromOcr(
        connection,
        payload.receipt,
        payload.message,
        payload.fileId,
        goal,
        fundingAccount,
      );
    } else {
      saved = await saveFinanceTransaction(
        connection,
        payload.tx,
        payload.message,
        goal,
        fundingAccount,
      );
    }
    await connection.query("UPDATE transaction_drafts SET status = 'saved' WHERE id = ?", [
      draftId,
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  await answerTelegramCallback(config.financeTelegramBotToken, callbackQuery.id, "Pengeluaran disimpan.");
  await clearTelegramInlineKeyboard(config.financeTelegramBotToken, chatId, callbackQuery.message.message_id);
  const remainingGoal = goal ? await getSavingGoalById(db, goal.id, draft.user_id) : null;
  const remainingAccount = fundingAccount
    ? await getSavingFundingAccountById(
        db,
        fundingAccount.bank_wallet_account_id,
        draft.user_id,
      )
    : null;
  const successMessage = goal
    ? buildSavingGoalRecordedMessage({
        category: payload.category,
        amount: payload.amount,
        note: payload.note,
        message: payload.message,
        goal,
        remaining: remainingGoal?.balance ?? Number(goal.balance) - Number(payload.amount),
      })
    : buildExpenseRecordedMessage({
        category: payload.category,
        amount: payload.amount,
        note: payload.note,
        message: payload.message,
        accountName: saved.accountName,
        remainingBalance: remainingAccount?.balance,
      });
  await sendTelegramChat(config.financeTelegramBotToken, chatId, successMessage, {
    reply_markup: savingInputButton(),
  });
  return Boolean(saved) || true;
}

async function getFinanceUserId(db, telegramUserId) {
  const [users] = await db.query("SELECT user_id AS id FROM telegram_accounts WHERE telegram_user_id = ? LIMIT 1", [
    telegramUserId,
  ]);
  return users[0]?.id || null;
}

async function getMonthlyFinanceSummary(db, telegramUserId) {
  const userId = await getFinanceUserId(db, telegramUserId);
  if (!userId) return [];
  const now = new Date();
  const [rows] = await db.query(
    `
      SELECT e.transaction_type, COALESCE(c.name, 'Lainnya') AS category, SUM(e.amount) AS total
      FROM transactions e
      LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.user_id = ?
        AND e.deleted_at IS NULL
        AND MONTH(e.occurred_at) = ?
        AND YEAR(e.occurred_at) = ?
      GROUP BY e.transaction_type, c.name
      ORDER BY transaction_type, total DESC
    `,
    [userId, now.getMonth() + 1, now.getFullYear()],
  );
  return rows;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function endOfMonth(year, month) {
  return new Date(year, month, 0);
}

function parseRekapOptions(text) {
  const lower = String(text || "").toLowerCase();
  const now = new Date();
  let startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  let endDate = endOfMonth(now.getFullYear(), now.getMonth() + 1);
  let title = "Rekap bulan ini";

  if (/\b(hari ini|today)\b/.test(lower)) {
    startDate = now;
    endDate = now;
    title = "Rekap hari ini";
  } else if (/\b(kemarin|yesterday)\b/.test(lower)) {
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 1);
    endDate = startDate;
    title = "Rekap kemarin";
  } else if (/\b(minggu|pekan|week)\b/.test(lower)) {
    startDate = new Date(now);
    const day = startDate.getDay() || 7;
    startDate.setDate(startDate.getDate() - day + 1);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    title = "Rekap minggu ini";
  }

  const ym = lower.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (ym) {
    startDate = new Date(Number(ym[1]), Number(ym[2]) - 1, 1);
    endDate = endOfMonth(Number(ym[1]), Number(ym[2]));
    title = `Rekap ${ym[0]}`;
  }

  const dateMatch = lower.match(/\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/);
  if (dateMatch) {
    startDate = new Date(dateMatch[0]);
    endDate = new Date(dateMatch[0]);
    title = `Rekap ${dateMatch[0]}`;
  }

  const categoryMatch = lower.match(/\b(?:kategori|cat|untuk)\s+([a-zA-Z& ]{3,40})/);
  const category = categoryMatch?.[1]?.trim();
  if (category) title += ` - ${category}`;

  return { startDate: formatDate(startDate), endDate: formatDate(endDate), title, category };
}

async function getFinanceSummary(db, telegramUserId, options) {
  const userId = await getFinanceUserId(db, telegramUserId);
  if (!userId) return [];
  const params = [userId, options.startDate, options.endDate];
  let categoryFilter = "";
  if (options.category) {
    categoryFilter = "AND LOWER(COALESCE(c.name, 'Lainnya')) LIKE ?";
    params.push(`%${options.category.toLowerCase()}%`);
  }
  const [rows] = await db.query(
    `
      SELECT e.transaction_type, COALESCE(c.name, 'Lainnya') AS category, SUM(e.amount) AS total, COUNT(*) AS count
      FROM transactions e
      LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.user_id = ?
        AND e.deleted_at IS NULL
        AND DATE(e.occurred_at) BETWEEN ? AND ?
        ${categoryFilter}
      GROUP BY e.transaction_type, c.name
      ORDER BY transaction_type, total DESC
    `,
    params,
  );
  return rows;
}

function buildFinanceReport(rows, title = "Laporan keuangan bulan ini") {
  if (!rows.length) return `Belum ada transaksi untuk ${title.toLowerCase()}.`;
  const income = rows.filter((row) => row.transaction_type === "income");
  const expense = rows.filter((row) => row.transaction_type === "expense");
  const incomeTotal = income.reduce((sum, row) => sum + Number(row.total), 0);
  const expenseTotal = expense.reduce((sum, row) => sum + Number(row.total), 0);
  const lines = [title, ""];
  if (income.length) {
    lines.push("Pemasukan:");
    for (const row of income) lines.push(`- ${row.category}: ${formatCurrency(row.total)}`);
    lines.push("");
  }
  if (expense.length) {
    lines.push("Pengeluaran:");
    for (const row of expense) lines.push(`- ${row.category}: ${formatCurrency(row.total)}`);
    lines.push("");
  }
  lines.push(`Total pemasukan: ${formatCurrency(incomeTotal)}`);
  lines.push(`Total pengeluaran: ${formatCurrency(expenseTotal)}`);
  lines.push(`Saldo bulan ini: ${formatCurrency(incomeTotal - expenseTotal)}`);
  return lines.join("\n");
}

function buildSavingReport(rows) {
  if (!rows.length) return "Belum ada data tabungan.";
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  const lines = ["Ringkasan tabungan", ""];
  for (const row of rows) {
    lines.push(`- ${row.account_name}: ${formatCurrency(row.amount)}`);
  }
  lines.push("");
  lines.push(`Total tabungan tercatat: ${formatCurrency(total)}`);
  return lines.join("\n");
}

function buildCompleteSavingReport(goals, assets) {
  if (!goals.length && !assets.length) {
    return [
      "Belum ada data tabungan.",
      "",
      "Buat tabungan baru dengan command:",
      "/buat_tabungan",
    ].join("\n");
  }

  const lines = ["Ringkasan Tabungan", ""];
  if (goals.length) {
    lines.push("Target Tabungan:");
    for (const goal of goals) {
      const balance = Number(goal.balance || 0);
      const target = Number(goal.target_amount || 0);
      const progress = target > 0 ? Math.min((balance / target) * 100, 999).toFixed(1) : null;
      lines.push(`🎯 ${goal.name}`);
      lines.push(`🏦 Rekening : ${goal.account_name}`);
      lines.push(`💵 Saldo : ${formatCurrency(balance)}`);
      if (target > 0) {
        lines.push(`💰 Target : ${formatCurrency(target)}`);
        lines.push(`📊 Progres : ${progress}%`);
      }
      lines.push("");
    }
    const goalTotal = goals.reduce((sum, goal) => sum + Number(goal.balance || 0), 0);
    lines.push(`Total saldo target: ${formatCurrency(goalTotal)}`);
  }

  if (assets.length) {
    if (goals.length) lines.push("");
    lines.push("Saldo / Aset Tercatat:");
    for (const asset of assets) {
      lines.push(`🏦 ${asset.account_name}`);
      lines.push(`Saldo : ${formatCurrency(asset.amount)}`);
      lines.push("");
    }
    const assetTotal = assets.reduce((sum, asset) => sum + Number(asset.amount || 0), 0);
    lines.push(`Total saldo/aset: ${formatCurrency(assetTotal)}`);
  }
  return lines.join("\n");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createFinanceSyncToken(db, userId) {
  const token = `fg_${randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO finance_sync_tokens (id, user_id, token_hash, token_name, expires_at) VALUES (?, ?, ?, 'mobile', DATE_ADD(NOW(), INTERVAL 30 DAY))",
    [randomUUID(), userId, hashToken(token)],
  );
  return token;
}

function isFinanceAdmin(chatId, config) {
  return config.financeAdminChatIds.includes(String(chatId));
}

function isApprovedFinanceUser(financeUser, chatId, config) {
  if (financeUser?.status === "blocked") return false;
  return financeUser?.access_status === "approved" || isFinanceAdmin(chatId, config);
}

/**
 * Ask the backend whether a user has an active subscription. The backend is the
 * single source of truth for the paywall (see ADR-025). Returns
 * { active, reachable } so callers can distinguish "not subscribed" from a
 * temporary backend outage.
 */
async function getSubscriptionStatus(config, userId) {
  try {
    const backendUrl = String(config.backendApiUrl || "").replace(/\/+$/, "");
    const response = await fetch(`${backendUrl}/api/v1/internal/subscriptions/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.internalApiKey ? { "x-internal-api-key": config.internalApiKey } : {}),
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!response.ok) {
      console.error(`Subscription check failed: ${response.status}`);
      return { active: false, reachable: false };
    }
    const json = await response.json().catch(() => ({}));
    const data = json.data || json;
    return { active: Boolean(data.is_active), reachable: true, status: data.status };
  } catch (error) {
    console.error("Subscription check error:", error.message);
    return { active: false, reachable: false };
  }
}

function getBackendUrl(config) {
  return String(config.backendApiUrl || "").replace(/\/+$/, "");
}

async function postInternalBackend(config, path, payload) {
  const backendUrl = getBackendUrl(config);
  if (!backendUrl) throw new Error("BACKEND_API_URL belum dikonfigurasi.");
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.internalApiKey ? { "x-internal-api-key": config.internalApiKey } : {}),
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = json.error?.code || json.code;
    const message = json.error?.message || json.message || `Backend returned ${response.status}`;
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return json.data || json;
}

function isLocalHttpUrl(url) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(String(url || ""));
}

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "")) && !isLocalHttpUrl(url);
}

function replaceUrlBase(url, publicBaseUrl) {
  if (!url || !publicBaseUrl) return url;
  try {
    const parsedUrl = new URL(url);
    const parsedBase = new URL(publicBaseUrl);
    return `${parsedBase.origin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return url;
  }
}

async function createSubscriptionLink(config, userId, chatId) {
  try {
    const data = await postInternalBackend(config, "/api/v1/internal/telegram/subscription-link", {
      user_id: userId,
      telegram_chat_id: String(chatId),
    });
    const url = data.url || null;
    if (isLocalHttpUrl(url) && isPublicHttpUrl(config.subscriptionPublicWebBaseUrl)) {
      return replaceUrlBase(url, config.subscriptionPublicWebBaseUrl);
    }
    return url;
  } catch (error) {
    console.error("[subscription-link]", error.message);
    const webBaseUrl = String(config.subscriptionPublicWebBaseUrl || config.webBaseUrl || "").replace(/\/+$/, "");
    return webBaseUrl ? `${webBaseUrl}/billing` : null;
  }
}

function buildSubscriptionRequiredMessage(url, hasButton = false) {
  return [
    "Untuk mencatat transaksi, Anda perlu berlangganan KasGue terlebih dahulu.",
    "",
    "Pilihan paket:",
    "- Bulanan: Rp10.000",
    "- Tahunan: Rp100.000",
    "",
    "Aktifkan langganan melalui aplikasi web KasGue pada menu Langganan, lalu coba catat transaksi Anda lagi.",
    ...(url && !hasButton ? ["", `Buka: ${url}`] : []),
  ].join("\n");
}

function subscriptionKeyboard(url) {
  if (!isPublicHttpUrl(url)) {
    return undefined;
  }
  return {
    inline_keyboard: [[{ text: "Aktifkan Langganan", url }]],
  };
}

/**
 * Guard for transaction-creating actions. Sends an explanatory message and
 * returns false when the user may not record a transaction. Read-only commands
 * (laporan, tabungan, dll.) tidak melewati guard ini.
 */
async function ensureSubscriptionForTransaction(config, chatId, userId) {
  const result = await getSubscriptionStatus(config, userId);
  if (result.active) return true;

  if (!result.reachable) {
    await sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      "Maaf, layanan langganan KasGue sedang tidak dapat dihubungi. Silakan coba beberapa saat lagi.",
    );
    return false;
  }

  const subscriptionUrl = await createSubscriptionLink(config, userId, chatId);
  const keyboard = subscriptionKeyboard(subscriptionUrl);
  await sendTelegramChat(
    config.financeTelegramBotToken,
    chatId,
    buildSubscriptionRequiredMessage(subscriptionUrl, Boolean(keyboard)),
    keyboard ? { reply_markup: keyboard } : {},
  );
  return false;
}

function extractStartToken(text) {
  const match = String(text || "").trim().match(/^\/start(?:@\w+)?\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function extractTelegramLinkToken(text) {
  const value = String(text || "").trim();
  if (/^tg_link_[a-f0-9]{64}$/i.test(value)) return value;
  const match = value.match(/^\/hubungkan(?:@\w+)?\s+(tg_link_[a-f0-9]{64})$/i);
  return match?.[1]?.trim() || "";
}

async function consumeTelegramLinkToken(config, message, token) {
  const chat = message.chat || {};
  const from = message.from || {};
  return postInternalBackend(config, "/api/v1/internal/telegram/link-token/consume", {
    token,
    telegram_user_id: Number(from.id || 0),
    telegram_chat_id: Number(chat.id || 0),
    telegram_username: from.username || null,
    first_name: from.first_name || null,
    last_name: from.last_name || null,
  });
}

async function handleTelegramStartLink(config, chatId, message, token) {
  console.log(`[telegram-link-token] received chat=${chatId} token=${String(token).slice(0, 16)}...`);
  try {
    await consumeTelegramLinkToken(config, message, token);
    console.log(`[telegram-link-token] linked chat=${chatId}`);
    return sendTelegramChat(
      config.financeTelegramBotToken,
      chatId,
      [
        "Telegram berhasil terhubung dengan akun KasGue Anda.",
        "",
        "Sekarang Anda bisa mencatat transaksi dari Telegram.",
        "Contoh: makan siang 25000",
      ].join("\n"),
      { reply_markup: savingInputButton() },
    );
  } catch (error) {
    console.error("[telegram-link-token]", error.message);
    const code = String(error.code || "").toUpperCase();
    const messageText =
      code.includes("EXPIRED")
        ? "Link Telegram sudah kedaluwarsa.\n\nSilakan buka aplikasi web KasGue dan buat link Telegram baru."
        : code.includes("INVALID") || error.status === 404
          ? "Link Telegram tidak valid.\n\nSilakan buka aplikasi web KasGue dan buat link Telegram baru."
          : "Maaf, proses menghubungkan Telegram sedang tidak dapat diproses. Silakan coba beberapa saat lagi.";
    return sendTelegramChat(config.financeTelegramBotToken, chatId, messageText);
  }
}

async function notifyFinanceAdmins(config, text) {
  for (const adminChatId of config.financeAdminChatIds) {
    await sendTelegramChat(config.financeTelegramBotToken, adminChatId, text);
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

async function setRegistrationStep(db, userId, step) {
  await db.query("UPDATE telegram_accounts SET registration_step = ? WHERE user_id = ?", [step, userId]);
}

async function handleFinanceApprovalCommand(db, config, chatId, command, text) {
  if (!isFinanceAdmin(chatId, config)) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Command ini hanya untuk admin.");
  }
  const targetTelegramUserId = Number(text.split(/\s+/)[1] || 0);
  if (!targetTelegramUserId) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, `Format: ${command} TELEGRAM_USER_ID`);
  }
  const [users] = await db.query(
    `SELECT u.*, ta.telegram_user_id, ta.telegram_chat_id, ta.access_status
     FROM telegram_accounts ta JOIN users u ON u.id = ta.user_id
     WHERE ta.telegram_user_id = ? LIMIT 1`,
    [targetTelegramUserId],
  );
  if (!users.length) return sendTelegramChat(config.financeTelegramBotToken, chatId, "User tidak ditemukan.");
  const target = users[0];

  if (command === "/approve") {
    await db.query(
      "UPDATE telegram_accounts SET access_status = 'approved', registration_step = NULL, approved_at = NOW(), rejected_at = NULL WHERE user_id = ?",
      [target.id],
    );
    await sendTelegramChat(config.financeTelegramBotToken, target.telegram_chat_id, "Registrasi Anda sudah disetujui. Sekarang Anda bisa mencatat transaksi. Coba: beli kopi 15000");
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "User sudah disetujui.");
  }

  await db.query("UPDATE telegram_accounts SET access_status = 'rejected', registration_step = NULL, rejected_at = NOW() WHERE user_id = ?", [target.id]);
  await sendTelegramChat(config.financeTelegramBotToken, target.telegram_chat_id, "Maaf, registrasi Anda belum disetujui oleh admin.");
  return sendTelegramChat(config.financeTelegramBotToken, chatId, "User sudah ditolak.");
}

async function handleFinanceRegistration(db, config, chatId, text, financeUser) {
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (financeUser.access_status === "pending_approval") {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Registrasi Anda sudah terkirim dan sedang menunggu approval admin.");
  }
  if (financeUser.access_status === "rejected") {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Registrasi Anda belum disetujui. Hubungi admin jika ini keliru.");
  }
  if (financeUser.access_status === "blocked") {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Akses Anda diblokir.");
  }

  let step = financeUser.registration_step;
  if (command === "/start" || command === "/register") {
    step = "full_name";
    await setRegistrationStep(db, financeUser.id, step);
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Selamat datang. Untuk memakai bot KasGue, registrasi dulu.\n\nKetik nama lengkap Anda:");
  }
  if (!step) {
    await setRegistrationStep(db, financeUser.id, "full_name");
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Akses bot ini perlu registrasi dulu.\n\nKetik nama lengkap Anda:");
  }
  if (step === "full_name") {
    if (text.length < 3 || text.startsWith("/")) {
      return sendTelegramChat(config.financeTelegramBotToken, chatId, "Ketik nama lengkap Anda:");
    }
    await db.query("UPDATE users SET full_name = ? WHERE id = ?", [text.trim(), financeUser.id]);
    await setRegistrationStep(db, financeUser.id, "email");
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Ketik email Anda:");
  }
  if (step === "email") {
    if (!isValidEmail(text)) {
      return sendTelegramChat(config.financeTelegramBotToken, chatId, "Format email belum valid. Contoh: nama@email.com");
    }
    await db.query("UPDATE users SET email = ? WHERE id = ?", [text.trim().toLowerCase(), financeUser.id]);
    await setRegistrationStep(db, financeUser.id, "phone");
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Ketik nomor HP Anda:");
  }

  const phone = normalizePhone(text);
  if (phone.length < 8) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Nomor HP belum valid. Coba kirim ulang.");
  }
  await db.query(
    "UPDATE users SET phone = ? WHERE id = ?",
    [phone, financeUser.id],
  );
  await db.query(
    "UPDATE telegram_accounts SET registration_step = NULL, access_status = 'pending_approval' WHERE user_id = ?",
    [financeUser.id],
  );
  const [updatedUsers] = await db.query(
    `SELECT u.*, ta.telegram_user_id, ta.telegram_chat_id
     FROM users u JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.id = ? LIMIT 1`,
    [financeUser.id],
  );
  const updatedUser = updatedUsers[0] || financeUser;
  await notifyFinanceAdmins(
    config,
    [
      "Registrasi Finance baru menunggu approval:",
      `Telegram ID: ${updatedUser.telegram_user_id}`,
      `Nama: ${updatedUser.full_name || "-"}`,
      `Email: ${updatedUser.email || "-"}`,
      `No HP: ${phone}`,
      "",
      `Setujui: /approve ${updatedUser.telegram_user_id}`,
      `Tolak: /reject ${updatedUser.telegram_user_id}`,
    ].join("\n"),
  );
  return sendTelegramChat(config.financeTelegramBotToken, chatId, "Registrasi berhasil dikirim. Tunggu approval admin dulu ya.");
}

async function askFinanceAI(userMessage, systemPrompt) {
  const config = getConfig();
  if (!config.openAIKey) return "Saya bisa bantu catat pemasukan, pengeluaran, laporan, dan tips keuangan.";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openAIKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.financeOpenAIModel,
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "Maaf, AI belum memberi jawaban.";
}

async function extractFinanceIntentWithAI(text) {
  const config = getConfig();
  if (!config.useOpenAI || !config.openAIKey || !text) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAIKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.financeOpenAIModel,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Ekstrak intent keuangan bahasa Indonesia menjadi JSON saja.",
              "Schema: intent salah satu expense,income,create_saving_goal,add_saving_goal_balance,saving_snapshot,unknown; amount number|null; category string|null; description string|null; saving_name string|null; saving_goal_name string|null; account_name string|null; target_amount number|null; initial_amount number|null; uses_saving_goal boolean.",
              "Kategori pengeluaran: Makanan & Minuman, Transport, Utilitas, Entertainment, Belanja & Hadiah, Kesehatan, Tagihan & Cicilan, Transfer Keluar, Lainnya.",
              "Kata tabungan pada frasa 'dari tabungan' adalah sumber dana, bukan kategori.",
              "Contoh 'bayar rumah sakit 500 ribu dari tabungan' => expense, amount 500000, category Kesehatan, description tagihan rumah sakit, uses_saving_goal true.",
              "Contoh 'bayar kartu kredit 350000' => expense, amount 350000, category Tagihan & Cicilan, description bayar kartu kredit.",
              "Contoh 'buat dana darurat target 20 juta di blu BCA' => create_saving_goal, saving_goal_name Dana Darurat, target_amount 20000000, account_name blu BCA.",
              "Contoh 'buat target laptop 15 juta di Jago saldo awal 2 juta' => create_saving_goal, saving_goal_name Laptop, target_amount 15000000, initial_amount 2000000, account_name Jago.",
              "Contoh 'tabung 500 ribu ke dana darurat' => add_saving_goal_balance, amount 500000, saving_goal_name Dana Darurat.",
              "Contoh 'saya punya tabungan untuk sekolah anak dengan saldo 7 juta di BLU BCA' => saving_snapshot, saving_name Tabungan Sekolah Anak, amount 7000000, account_name BLU BCA.",
              "Contoh 'gaji bulan ini 8 juta' => income, amount 8000000, category Gaji.",
            ].join("\n"),
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return JSON.parse(data.choices?.[0]?.message?.content || "null");
  } catch (error) {
    console.error("[finance:intent-ai]", error.message);
    return null;
  }
}

function transactionFromAIIntent(intent, fallbackTransaction = null) {
  if (!intent || !["expense", "income"].includes(intent.intent) || !Number(intent.amount)) {
    return null;
  }
  const aiCategory = String(intent.category || "").trim();
  const aiDescription = String(intent.description || "").trim();
  const genericDescription = /^(tanpa deskripsi|tidak ada|n\/a|null|-)?$/i.test(aiDescription);
  return {
    transactionType: intent.intent,
    category:
      (aiCategory && aiCategory !== "Lainnya" ? aiCategory : null) ||
      fallbackTransaction?.category ||
      (intent.intent === "income" ? "Pemasukan" : "Lainnya"),
    description:
      (!genericDescription ? aiDescription : null) ||
      fallbackTransaction?.description ||
      "Tanpa deskripsi",
    amount: Number(intent.amount),
  };
}

export async function handleFinanceTelegramMessage(message, update = {}) {
  const config = getConfig();
  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    const callbackDb = await getDb();
    await ensureSchema(callbackDb);
    try {
      if (String(callbackQuery.data || "").startsWith("saving:")) {
        await handleSavingInputMenuCallback(callbackDb, config, callbackQuery);
      } else if (String(callbackQuery.data || "").startsWith("menu:")) {
        await handleMainMenuCallback(config, callbackQuery);
      } else {
        await handleSavingGoalCallback(callbackDb, config, callbackQuery);
      }
    } finally {
      await callbackDb.end();
    }
    return;
  }
  if (!message?.chat?.id) return;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const db = await getDb();
  await ensureSchema(db);
  const financeUser = await upsertFinanceUser(db, message);
  const startToken = command === "/start" ? extractStartToken(text) : "";
  const manualLinkToken = startToken || extractTelegramLinkToken(text);

  try {
    if (command === "/approve" || command === "/reject") {
      return await handleFinanceApprovalCommand(db, config, chatId, command, text);
    }
    if (manualLinkToken) {
      return await handleTelegramStartLink(config, chatId, message, manualLinkToken);
    }
    if (!isApprovedFinanceUser(financeUser, chatId, config)) {
      return await handleFinanceRegistration(db, config, chatId, text, financeUser);
    }
    if (message.photo?.length) {
      if (!(await ensureSubscriptionForTransaction(config, chatId, financeUser.id))) return;
      return await handleReceiptPhoto(db, config, message);
    }
    if (command === "/start" || command === "/help") {
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        [
          "Halo. Saya bot KasGue.",
          "",
          "Format transaksi:",
          "- makanan 50000 makan siang",
          "- gaji 5000000 gaji bulanan",
          "- pemasukan 250000 freelance",
          "- buat target tabungan Dana Darurat 20 juta di blu BCA, saldo awal 2 juta",
          "- tabung 500 ribu ke Dana Darurat",
          "- saya punya tabungan 7 juta di blu BCA",
          "- kirim foto struk Alfamart/Indomaret untuk OCR otomatis",
          "",
          buildCommandMenu(),
        ].join("\n"),
        { reply_markup: savingInputButton() },
      );
    }
    if (command === "/buat_tabungan") {
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        [
          "Menu Tabungan",
          "",
          "Pilih sesuai kebutuhan:",
          "",
          "Catat Tabungan Baru",
          "Untuk rekening/tabungan yang sudah ada dan memiliki saldo.",
          "Contoh: Saya punya tabungan 7 juta di blu BCA",
          "",
          "Buat Target Tabungan",
          "Untuk tujuan menabung dengan nominal target.",
          "Contoh: Buat target Dana Darurat 20 juta di blu BCA, saldo awal 2 juta",
        ].join("\n"),
        { reply_markup: savingInputMenu() },
      );
    }
    if (command === "/sync_token") {
      const token = await createFinanceSyncToken(db, financeUser.id);
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        `Token sinkronisasi aplikasi KasGue dibuat.\n\n${token}\n\nGunakan token ini untuk menghubungkan akun Telegram ke aplikasi KasGue. Token hanya ditampilkan sekali dan berlaku 30 hari.`,
      );
    }
    if (command === "/setsheet") {
      const match = text.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      const sheetId = match ? match[1] : null;
      if (!sheetId) {
        return sendTelegramChat(
          config.financeTelegramBotToken,
          chatId,
          "Format salah atau link tidak valid.\nContoh: /setsheet https://docs.google.com/spreadsheets/d/1A2B3C..."
        );
      }
      
      await db.query("UPDATE users SET google_sheet_id = ? WHERE id = ?", [sheetId, financeUser.id]);
      
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        "✅ Spreadsheet berhasil didaftarkan!\n\nSekarang Anda bisa menggunakan perintah /laporan_sheet untuk menuliskan laporan ke Spreadsheet tersebut."
      );
    }
    if (command === "/laporan") {
      const rows = await getMonthlyFinanceSummary(db, Number(message.from?.id || 0));
      return sendTelegramChat(config.financeTelegramBotToken, chatId, buildFinanceReport(rows));
    }
    if (command === "/laporan_sheet") {
      try {
        const backendUrl = String(config.backendApiUrl || "").replace(/\/+$/, "");
        const response = await fetch(`${backendUrl}/api/v1/internal/reports/google-sheets`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.internalApiKey ? { "x-internal-api-key": config.internalApiKey } : {}),
          },
          body: JSON.stringify({ user_id: financeUser.id }),
        });

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (json.code === "SHEET_NOT_CONFIGURED" || json.error?.code === "SHEET_NOT_CONFIGURED" || json.message?.includes("SHEET_NOT_CONFIGURED") || json.error?.message?.includes("SHEET_NOT_CONFIGURED")) {
            throw new Error("NOT_CONFIGURED");
          }
          throw new Error(json.error?.message || json.message || `Backend returned ${response.status} ${response.statusText}`);
        }

        const result = json.data || json;
        if (!result?.url && !result?.spreadsheetId) throw new Error("Response backend tidak memiliki URL Google Sheets.");

        const sheetUrl = result?.url || `https://docs.google.com/spreadsheets/d/${result?.spreadsheetId}/edit#gid=0`;

        return sendTelegramChat(
          config.financeTelegramBotToken,
          chatId,
          `✅ Laporan Google Sheets berhasil diupdate.\n${sheetUrl}`,
        );
      } catch (error) {
        if (error.message === "NOT_CONFIGURED") {
          return sendTelegramChat(
            config.financeTelegramBotToken,
            chatId,
            [
              "❌ Anda belum mendaftarkan Spreadsheet.",
              "",
              "Cara mengatur Spreadsheet pribadi Anda:",
              "1. Buat file Spreadsheet kosong baru di Google Drive Anda.",
              "2. Klik tombol Share/Bagikan, dan tambahkan email robot KasGue sebagai Editor:",
              "   kasgue-api-google@project-49e4070b-cf1a-4f4f-ab0.iam.gserviceaccount.com",
              "3. Salin (copy) link file Spreadsheet tersebut.",
              "4. Kirim link tersebut ke sini dengan perintah:",
              "   /setsheet [link_spreadsheet_anda]"
            ].join("\n")
          );
        }
        console.error("Error calling backend for google sheets export:", error);
        return sendTelegramChat(
          config.financeTelegramBotToken,
          chatId,
          `❌ Gagal membuat laporan Google Sheets: ${error.message}`,
        );
      }
    }
    if (command === "/tabungan") {
      const goals = await getActiveSavingGoals(db, financeUser.id);
      const assets = await getSavingAssetSummary(db, financeUser.id);
      return sendTelegramChat(config.financeTelegramBotToken, chatId, buildCompleteSavingReport(goals, assets), {
        reply_markup: savingInputButton(),
      });
    }
    if (command === "/rekap") {
      const options = parseRekapOptions(text);
      const rows = await getFinanceSummary(db, Number(message.from?.id || 0), options);
      return sendTelegramChat(config.financeTelegramBotToken, chatId, buildFinanceReport(rows, `${options.title} (${options.startDate} s/d ${options.endDate})`));
    }
    if (command === "/ringkas") {
      const rows = await getMonthlyFinanceSummary(db, Number(message.from?.id || 0));
      const report = buildFinanceReport(rows);
      const answer = await askFinanceAI(
        `Berikan 3 saran hemat singkat berdasarkan laporan ini:\n${report}`,
        "Anda adalah asisten keuangan pribadi. Jawab hanya topik keuangan, tabungan, pengeluaran, pemasukan, anggaran, dan fitur bot. Jawab singkat dalam bahasa Indonesia.",
      );
      return sendTelegramChat(config.financeTelegramBotToken, chatId, `Saran keuangan:\n\n${answer}`);
    }
    if (command === "/bantuan") {
      return sendTelegramChat(config.financeTelegramBotToken, chatId, "Tips keuangan pribadi:\n1. Catat semua pemasukan dan pengeluaran.\n2. Pisahkan kebutuhan dan keinginan.\n3. Pakai metode 50-30-20.\n4. Review laporan tiap bulan.\n5. Siapkan dana darurat sebelum belanja besar.");
    }

    const aiIntent = await extractFinanceIntentWithAI(text);
    const savingGoalCreation =
      aiIntent?.intent === "create_saving_goal" &&
      aiIntent.saving_goal_name &&
      Number(aiIntent.target_amount) &&
      aiIntent.account_name
        ? {
            name: String(aiIntent.saving_goal_name),
            targetAmount: Number(aiIntent.target_amount),
            accountName: String(aiIntent.account_name),
            initialAmount: Number(aiIntent.initial_amount || 0),
          }
        : parseSavingGoalCreation(text);
    if (savingGoalCreation) {
      if (!(await ensureSubscriptionForTransaction(config, chatId, financeUser.id))) return;
      let goal;
      try {
        goal = await createSavingGoal(db, financeUser, savingGoalCreation);
      } catch (error) {
        return sendTelegramChat(config.financeTelegramBotToken, chatId, error.message, {
          reply_markup: savingInputButton(),
        });
      }
      await sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        [
          "Target Tabungan dibuat.",
          "",
          `🎯 Target : ${goal.name}`,
          `🏦 Rekening : ${goal.accountName}`,
          `💰 Target Nominal : ${formatCurrency(goal.targetAmount)}`,
          `💵 Saldo Awal : ${formatCurrency(goal.initialAmount || 0)}`,
        ].join("\n"),
      );
      return await resumePendingExpenseWithGoal(db, config, financeUser, goal, chatId);
    }

    const savingGoalDeposit =
      aiIntent?.intent === "add_saving_goal_balance" &&
      aiIntent.saving_goal_name &&
      Number(aiIntent.amount)
        ? {
            goalName: String(aiIntent.saving_goal_name),
            amount: Number(aiIntent.amount),
          }
        : parseSavingGoalDeposit(text);
    if (savingGoalDeposit) {
      if (!(await ensureSubscriptionForTransaction(config, chatId, financeUser.id))) return;
      let goal;
      try {
        goal = await addSavingGoalDeposit(db, financeUser, savingGoalDeposit);
      } catch (error) {
        return sendTelegramChat(config.financeTelegramBotToken, chatId, error.message, {
          reply_markup: savingInputButton(),
        });
      }
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        [
          "Saldo Target Tabungan ditambahkan.",
          "",
          `🎯 Target : ${goal.name}`,
          `🏦 Rekening : ${goal.account_name}`,
          `💰 Ditambahkan : ${formatCurrency(savingGoalDeposit.amount)}`,
          `💵 Saldo Sekarang : ${formatCurrency(goal.balance)}`,
        ].join("\n"),
        { reply_markup: savingInputButton() },
      );
    }

    const localSaving = parseSavingSnapshot(text);
    const saving =
      aiIntent?.intent === "saving_snapshot" && Number(aiIntent.amount)
        ? {
            savingName: String(
              aiIntent.saving_name && String(aiIntent.saving_name).toLowerCase() !== "tabungan"
                ? aiIntent.saving_name
                : localSaving?.savingName || "Tabungan",
            ),
            accountName: String(
              aiIntent.account_name || localSaving?.accountName || "Rekening tidak disebutkan",
            ),
            amount: Number(aiIntent.amount),
            description: String(
              aiIntent.description &&
                !/^(saldo tabungan|tabungan|tanpa deskripsi)$/i.test(
                  String(aiIntent.description),
                )
                ? aiIntent.description
                :
                localSaving?.description ||
                `Disimpan di ${aiIntent.account_name || "rekening tabungan"}`,
            ),
          }
        : localSaving;
    if (saving) {
      if (!(await ensureSubscriptionForTransaction(config, chatId, financeUser.id))) return;
      await saveSavingSnapshot(db, saving, message);
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        buildRecordedMessage({
          title: "Tabungan",
          category: saving.savingName,
          type: "Tabungan",
          amount: saving.amount,
          note: saving.description,
          message,
        }),
        { reply_markup: savingInputButton() },
      );
    }

    const localTransaction = parseFinanceTransaction(text);
    const tx = transactionFromAIIntent(aiIntent, localTransaction) || localTransaction;
    if (tx) {
      if (!(await ensureSubscriptionForTransaction(config, chatId, financeUser.id))) return;
      if (config.savingGoalFeatureEnabled && tx.transactionType === "expense") {
        return await createAndSendExpenseDraft(db, config, financeUser, "text_expense", {
          tx,
          message: compactTelegramMessage(message),
          category: tx.category,
          amount: tx.amount,
          note: tx.description,
          usesSavingGoal: Boolean(aiIntent?.uses_saving_goal),
          savingGoalName: aiIntent?.saving_goal_name || null,
        });
      }
      await saveFinanceTransaction(db, tx, message);
      const label = tx.transactionType === "income" ? "Pemasukan" : "Pengeluaran";
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        buildRecordedMessage({
          title: label,
          category: tx.category,
          type: label,
          amount: tx.amount,
          note: tx.description,
          message,
        }),
        { reply_markup: savingInputButton() },
      );
    }

    const answer = await askFinanceAI(
      `User mengirim pesan: "${text}". Jika berkaitan dengan keuangan, jawab singkat. Jika tidak, tolak sopan dan arahkan ke topik keuangan.`,
      "Anda adalah chatbot pencatatan keuangan pribadi. Hanya jawab topik tabungan, pengeluaran, pemasukan, anggaran, laporan keuangan, tips menabung, atau fitur bot ini. Tolak topik lain dengan sopan.",
    );
    return sendTelegramChat(config.financeTelegramBotToken, chatId, answer);
  } finally {
    await db.end();
  }
}
