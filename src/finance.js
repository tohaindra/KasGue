import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "./config.js";
import { ensureSchema, getDb } from "./db.js";
import { generateGoogleSheetsFinanceReport } from "./googleSheetsReport.js";
import { downloadTelegramFile, getTelegramFile, sendTelegramChat } from "./telegram.js";

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
  tabungan: "Tabungan",
  gaji: "Gaji",
  pemasukan: "Pemasukan",
  income: "Pemasukan",
  lainnya: "Lainnya",
};

const incomeWords = new Set(["gaji", "pemasukan", "income", "masuk", "bonus", "fee"]);
const expenseWords = new Set(["beli", "bayar", "pengeluaran", "keluar", "jajan", "belanja"]);
const savingWords = new Set(["tabungan", "saldo", "simpanan", "deposito"]);
const foodHints = new Set(["apel", "ayam", "bakso", "buah", "kopi", "makan", "makanan", "minum", "minuman", "nanas", "nasi", "roti", "sayur", "snack"]);

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
    category: financeCategories[categoryKey],
    description:
      original
        .replace(new RegExp(`\\b${categoryKey}\\b`, "i"), "")
        .replace(amountInfo.raw, "")
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

  const accountMatch = original.match(/\b(?:di|ke|rekening|akun)\s+(.+?)(?:\s+(?:sebesar|senilai|jumlahnya)\b|$)/i);
  const description = original
    .replace(amountInfo.raw, "")
    .replace(/\b(saya|aku|gue|punya|ada|catat|tabungan|saldo|simpanan|deposito)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    accountName: accountMatch?.[1]?.trim() || description || "Tabungan",
    amount: amountInfo.amount,
    description: description || "Saldo tabungan",
  };
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
  await db.query(
    `
      INSERT INTO finance_users
        (telegram_user_id, telegram_chat_id, telegram_username, first_name, last_name, language_code, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        telegram_chat_id = VALUES(telegram_chat_id),
        telegram_username = VALUES(telegram_username),
        first_name = VALUES(first_name),
        last_name = VALUES(last_name),
        language_code = VALUES(language_code),
        last_seen_at = NOW(),
        updated_at = NOW()
    `,
    [
      Number(user.id || 0),
      Number(chat.id || 0),
      user.username || null,
      user.first_name || null,
      user.last_name || null,
      user.language_code || null,
    ],
  );
  const [rows] = await db.query("SELECT * FROM finance_users WHERE telegram_user_id = ? LIMIT 1", [
    Number(user.id || 0),
  ]);
  return rows[0];
}

async function getOrCreateDefaultAccount(db, userId) {
  const [existing] = await db.query(
    "SELECT id FROM finance_accounts WHERE user_id = ? AND is_default = TRUE LIMIT 1",
    [userId],
  );
  if (existing.length) return existing[0].id;
  const [result] = await db.query(
    "INSERT INTO finance_accounts (user_id, name, account_type, currency, is_default) VALUES (?, 'Dompet Utama', 'cash', 'IDR', TRUE)",
    [userId],
  );
  return result.insertId;
}

async function getOrCreateCategory(db, transactionType, categoryName) {
  const slug = slugify(categoryName);
  const [existing] = await db.query(
    "SELECT id FROM finance_categories WHERE user_id IS NULL AND transaction_type = ? AND slug = ? LIMIT 1",
    [transactionType, slug],
  );
  if (existing.length) return existing[0].id;
  const [result] = await db.query(
    "INSERT INTO finance_categories (user_id, transaction_type, slug, name, is_system) VALUES (NULL, ?, ?, ?, TRUE)",
    [transactionType, slug, categoryName],
  );
  return result.insertId;
}

async function saveFinanceTransaction(db, tx, message) {
  const chat = message.chat || {};
  const financeUser = await upsertFinanceUser(db, message);
  const accountId = await getOrCreateDefaultAccount(db, financeUser.id);
  const categoryId = await getOrCreateCategory(db, tx.transactionType, tx.category);
  await db.query(
    `
      INSERT INTO finance_entries
        (user_id, account_id, category_id, transaction_type, amount, currency, description, raw_text, source, source_message_id, source_chat_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, 'IDR', ?, ?, 'telegram', ?, ?, NOW())
    `,
    [
      financeUser.id,
      accountId,
      categoryId,
      tx.transactionType,
      tx.amount,
      tx.description,
      message.text || null,
      Number(message.message_id || 0),
      Number(chat.id || 0),
    ],
  );
}

async function saveSavingSnapshot(db, saving, message) {
  const chat = message.chat || {};
  const financeUser = await upsertFinanceUser(db, message);
  await db.query(
    `
      INSERT INTO finance_savings
        (user_id, account_name, amount, currency, description, raw_text, source, source_message_id, source_chat_id, observed_at)
      VALUES (?, ?, ?, 'IDR', ?, ?, 'telegram', ?, ?, NOW())
    `,
    [
      financeUser.id,
      saving.accountName,
      saving.amount,
      saving.description,
      message.text || null,
      Number(message.message_id || 0),
      Number(chat.id || 0),
    ],
  );
}

async function getSavingSummary(db, telegramUserId) {
  const userId = await getFinanceUserId(db, telegramUserId);
  if (!userId) return [];
  const [rows] = await db.query(
    `
      SELECT account_name, amount, description, observed_at
      FROM finance_savings
      WHERE user_id = ?
        AND deleted_at IS NULL
      ORDER BY observed_at DESC, id DESC
      LIMIT 20
    `,
    [userId],
  );
  return rows;
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

async function saveReceiptFromOcr(db, receipt, message, fileId) {
  const financeUser = await upsertFinanceUser(db, message);
  const ownerHints = getOwnerHintsFromUser(financeUser);
  receipt = applyOwnerDirectionOverride(receipt, ownerHints);
  const accountId = await getOrCreateDefaultAccount(db, financeUser.id);
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
  const [entryResult] = await db.query(
    `
      INSERT INTO finance_entries
        (user_id, account_id, category_id, transaction_type, amount, currency, description, raw_text, source, source_message_id, source_chat_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, 'IDR', ?, ?, 'telegram', ?, ?, COALESCE(?, NOW()))
    `,
    [
      financeUser.id,
      accountId,
      categoryId,
      transactionType,
      totalAmount,
      description,
      "OCR receipt",
      Number(message.message_id || 0),
      Number(message.chat?.id || 0),
      transactionAt,
    ],
  );

  const [receiptResult] = await db.query(
    `
      INSERT INTO finance_receipts
        (
          user_id, entry_id, merchant_name, merchant_branch, receipt_number,
          document_type, bank_name, sender_name, receiver_name, transaction_at,
          subtotal, discount_total, tax_total, total_amount, payment_method,
          source_chat_id, source_message_id, telegram_file_id, ocr_model, ocr_raw, status
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'parsed')
    `,
    [
      financeUser.id,
      entryResult.insertId,
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
          (receipt_id, item_name, quantity, unit_price, line_total, category_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        receiptResult.insertId,
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
    entryId: entryResult.insertId,
    receiptId: receiptResult.insertId,
    totalAmount,
    transactionType,
    categoryName,
    documentType,
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
  const receipt = await ocrReceiptImage(imageBuffer, ownerHints, "image/jpeg");
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
  );
}

async function getFinanceUserId(db, telegramUserId) {
  const [users] = await db.query("SELECT id FROM finance_users WHERE telegram_user_id = ? LIMIT 1", [
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
      FROM finance_entries e
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
      FROM finance_entries e
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

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createFinanceSyncToken(db, userId) {
  const token = `fg_${randomBytes(32).toString("base64url")}`;
  await db.query(
    "INSERT INTO finance_sync_tokens (user_id, token_hash, token_name, expires_at) VALUES (?, ?, 'mobile', DATE_ADD(NOW(), INTERVAL 30 DAY))",
    [userId, hashToken(token)],
  );
  return token;
}

function isFinanceAdmin(chatId, config) {
  return config.financeAdminChatIds.includes(String(chatId));
}

function isApprovedFinanceUser(financeUser, chatId, config) {
  return financeUser?.access_status === "approved" || isFinanceAdmin(chatId, config);
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
  await db.query("UPDATE finance_users SET registration_step = ? WHERE id = ?", [step, userId]);
}

async function handleFinanceApprovalCommand(db, config, chatId, command, text) {
  if (!isFinanceAdmin(chatId, config)) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Command ini hanya untuk admin.");
  }
  const targetTelegramUserId = Number(text.split(/\s+/)[1] || 0);
  if (!targetTelegramUserId) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, `Format: ${command} TELEGRAM_USER_ID`);
  }
  const [users] = await db.query("SELECT * FROM finance_users WHERE telegram_user_id = ? LIMIT 1", [
    targetTelegramUserId,
  ]);
  if (!users.length) return sendTelegramChat(config.financeTelegramBotToken, chatId, "User tidak ditemukan.");
  const target = users[0];

  if (command === "/approve") {
    await db.query(
      "UPDATE finance_users SET access_status = 'approved', registration_step = NULL, approved_at = NOW(), rejected_at = NULL WHERE id = ?",
      [target.id],
    );
    await sendTelegramChat(config.financeTelegramBotToken, target.telegram_chat_id, "Registrasi Anda sudah disetujui. Sekarang Anda bisa mencatat transaksi. Coba: beli kopi 15000");
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "User sudah disetujui.");
  }

  await db.query("UPDATE finance_users SET access_status = 'rejected', registration_step = NULL, rejected_at = NOW() WHERE id = ?", [target.id]);
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
    await db.query("UPDATE finance_users SET full_name = ?, registration_step = 'email' WHERE id = ?", [text.trim(), financeUser.id]);
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Ketik email Anda:");
  }
  if (step === "email") {
    if (!isValidEmail(text)) {
      return sendTelegramChat(config.financeTelegramBotToken, chatId, "Format email belum valid. Contoh: nama@email.com");
    }
    await db.query("UPDATE finance_users SET email = ?, registration_step = 'phone' WHERE id = ?", [text.trim().toLowerCase(), financeUser.id]);
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Ketik nomor HP Anda:");
  }

  const phone = normalizePhone(text);
  if (phone.length < 8) {
    return sendTelegramChat(config.financeTelegramBotToken, chatId, "Nomor HP belum valid. Coba kirim ulang.");
  }
  await db.query(
    "UPDATE finance_users SET phone = ?, registration_step = NULL, access_status = 'pending_approval' WHERE id = ?",
    [phone, financeUser.id],
  );
  const [updatedUsers] = await db.query("SELECT * FROM finance_users WHERE id = ? LIMIT 1", [financeUser.id]);
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

export async function handleFinanceTelegramMessage(message) {
  if (!message?.chat?.id) return;
  const config = getConfig();
  const chatId = message.chat.id;
  const text = (message.text || message.caption || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const db = await getDb();
  await ensureSchema(db);
  const financeUser = await upsertFinanceUser(db, message);

  try {
    if (command === "/approve" || command === "/reject") {
      return await handleFinanceApprovalCommand(db, config, chatId, command, text);
    }
    if (!isApprovedFinanceUser(financeUser, chatId, config)) {
      return await handleFinanceRegistration(db, config, chatId, text, financeUser);
    }
    if (message.photo?.length) {
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
          "- tabungan 7000000 di blu BCA",
          "- kirim foto struk Alfamart/Indomaret untuk OCR otomatis",
          "",
          "Command:",
          "/laporan - laporan bulan ini",
          "/laporan_sheet - generate laporan Google Sheets",
          "/tabungan - lihat tabungan/aset tercatat",
          "/rekap - rekap bulan ini",
          "/rekap minggu - rekap minggu ini",
          "/rekap 2026-06 - rekap bulan tertentu",
          "/rekap kategori makanan - filter kategori",
          "/ringkas - saran hemat dari AI",
          "/bantuan - tips keuangan",
          "/sync_token - buat token untuk sync mobile app",
        ].join("\n"),
      );
    }
    if (command === "/sync_token") {
      const token = await createFinanceSyncToken(db, financeUser.id);
      return sendTelegramChat(config.financeTelegramBotToken, chatId, `Token sync mobile dibuat.\n\n${token}\n\nSimpan token ini di aplikasi mobile. Token hanya ditampilkan sekali dan berlaku 30 hari.`);
    }
    if (command === "/laporan") {
      const rows = await getMonthlyFinanceSummary(db, Number(message.from?.id || 0));
      return sendTelegramChat(config.financeTelegramBotToken, chatId, buildFinanceReport(rows));
    }
    if (command === "/laporan_sheet") {
      const result = await generateGoogleSheetsFinanceReport(db, financeUser.id);
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        `Laporan Google Sheets berhasil diupdate.\n${result.url}`,
      );
    }
    if (command === "/tabungan") {
      const rows = await getSavingSummary(db, Number(message.from?.id || 0));
      return sendTelegramChat(config.financeTelegramBotToken, chatId, buildSavingReport(rows));
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

    const saving = parseSavingSnapshot(text);
    if (saving) {
      await saveSavingSnapshot(db, saving, message);
      return sendTelegramChat(
        config.financeTelegramBotToken,
        chatId,
        buildRecordedMessage({
          title: "Tabungan",
          category: saving.accountName,
          type: "Tabungan",
          amount: saving.amount,
          note: saving.description,
          message,
        }),
      );
    }

    const tx = parseFinanceTransaction(text);
    if (tx) {
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
