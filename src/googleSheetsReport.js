import { getConfig } from "./config.js";

const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const shortMonthNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const reportSheets = ["Dashboard", "Pemasukan", "Pengeluaran", "Transaksi"];
const legacySheetNames = new Map([
  ["Income", "Pemasukan"],
  ["Usage", "Pengeluaran"],
  ["Expenses", "Transaksi"],
]);
const weekdayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

function formatCurrencyNumber(value) {
  return Number(value || 0);
}

function formatDashboardDate(date = new Date()) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = monthNames[date.getMonth()];
  return `${weekdayNames[date.getDay()]}, ${day} ${month} ${date.getFullYear()}`;
}

function columnWidthRequests(sheetId, widths) {
  return widths.map((pixelSize, index) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  }));
}

function getSpreadsheetIdFromUrl(value) {
  const text = String(value || "").trim();
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : text;
}

async function getSheetsClient() {
  const config = getConfig();
  if (!config.googleSheetsEnabled) throw new Error("GOOGLE_SHEETS_ENABLED masih false.");
  if (!config.googleServiceAccountKeyFile) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_FILE wajib diisi.");
  if (!config.googleSheetId && !config.googleSheetsTemplateId) {
    throw new Error("GOOGLE_SHEET_ID atau GOOGLE_SHEETS_TEMPLATE_ID wajib diisi.");
  }

  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleServiceAccountKeyFile,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  return {
    sheets: google.sheets({ version: "v4", auth }),
    drive: google.drive({ version: "v3", auth }),
    spreadsheetId: config.googleSheetId ? getSpreadsheetIdFromUrl(config.googleSheetId) : "",
    templateId: config.googleSheetsTemplateId
      ? getSpreadsheetIdFromUrl(config.googleSheetsTemplateId)
      : "",
    sheetName: config.googleSheetName,
    config,
  };
}

function buildSpreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`;
}

function cleanSpreadsheetName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getUserDisplayName(user, userId) {
  return cleanSpreadsheetName(user?.full_name || user?.email || `User ${String(userId).slice(0, 8)}`);
}

async function shareSpreadsheetWithUser(drive, spreadsheetId, user, role) {
  const email = String(user?.email || "").trim();
  if (!email) return;
  const normalizedRole = ["reader", "writer"].includes(role) ? role : "writer";
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        type: "user",
        role: normalizedRole,
        emailAddress: email,
      },
      sendNotificationEmail: false,
    });
  } catch (error) {
    console.warn("[reports:google-sheets] Gagal share spreadsheet ke user:", error.message);
  }
}

async function getActiveUserSpreadsheet(db, userId) {
  const [rows] = await db.query(
    `
      SELECT *
      FROM user_spreadsheets
      WHERE user_id = ?
        AND provider = 'google_sheets'
        AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId],
  );
  return rows[0] || null;
}

async function createUserSpreadsheet(db, drive, config, userId, user, year) {
  const templateId = config.googleSheetsTemplateId
    ? getSpreadsheetIdFromUrl(config.googleSheetsTemplateId)
    : "";
  if (!templateId) return null;

  const name = cleanSpreadsheetName(`KasGue - ${getUserDisplayName(user, userId)} - ${year}`);
  const copied = await drive.files.copy({
    fileId: templateId,
    requestBody: { name },
    fields: "id, webViewLink",
  });
  const spreadsheetId = copied.data.id;
  const spreadsheetUrl = copied.data.webViewLink || buildSpreadsheetUrl(spreadsheetId);

  if (config.googleSheetsShareWithUser) {
    await shareSpreadsheetWithUser(drive, spreadsheetId, user, config.googleSheetsShareRole);
  }

  await db.query(
    `
      INSERT INTO user_spreadsheets
        (id, user_id, spreadsheet_id, spreadsheet_url, template_id, template_version, provider, is_active)
      VALUES
        (UUID(), ?, ?, ?, ?, 'v1', 'google_sheets', TRUE)
    `,
    [userId, spreadsheetId, spreadsheetUrl, templateId],
  );

  return {
    user_id: userId,
    spreadsheet_id: spreadsheetId,
    spreadsheet_url: spreadsheetUrl,
    template_id: templateId,
    provider: "google_sheets",
    is_active: true,
  };
}

async function getOrCreateUserSpreadsheet(db, drive, config, userId, user, year) {
  const existing = await getActiveUserSpreadsheet(db, userId);
  if (existing) return existing;

  const created = await createUserSpreadsheet(db, drive, config, userId, user, year);
  if (created) return created;

  if (config.googleSheetId) {
    const spreadsheetId = getSpreadsheetIdFromUrl(config.googleSheetId);
    return {
      user_id: userId,
      spreadsheet_id: spreadsheetId,
      spreadsheet_url: buildSpreadsheetUrl(spreadsheetId),
      provider: "google_sheets",
      is_active: true,
      is_legacy_shared_sheet: true,
    };
  }

  throw new Error("Template Google Sheets belum dikonfigurasi.");
}

async function getSheetMap(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return new Map((meta.data.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
}

async function ensureReportSheets(sheets, spreadsheetId) {
  let sheetMap = await getSheetMap(sheets, spreadsheetId);
  const renameRequests = [];
  for (const [legacyTitle, newTitle] of legacySheetNames.entries()) {
    if (sheetMap.has(legacyTitle) && !sheetMap.has(newTitle)) {
      renameRequests.push({
        updateSheetProperties: {
          properties: { sheetId: sheetMap.get(legacyTitle), title: newTitle },
          fields: "title",
        },
      });
    }
  }
  if (renameRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: renameRequests },
    });
    sheetMap = await getSheetMap(sheets, spreadsheetId);
  }

  const requests = [];
  for (const title of reportSheets) {
    if (!sheetMap.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    sheetMap = await getSheetMap(sheets, spreadsheetId);
  }

  const deleteRequests = [];
  for (const [title, sheetId] of sheetMap.entries()) {
    if (!reportSheets.includes(title)) {
      deleteRequests.push({ deleteSheet: { sheetId } });
    }
  }
  if (deleteRequests.length && sheetMap.size > deleteRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: deleteRequests } });
  }
  return getSheetMap(sheets, spreadsheetId);
}

export async function fetchReportData(db, userId, year, currentMonth = new Date().getMonth() + 1) {
  const [monthly] = await db.query(
    `
      SELECT MONTH(occurred_at) AS month_no,
             transaction_type,
             SUM(amount) AS total
      FROM transactions
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND YEAR(occurred_at) = ?
      GROUP BY MONTH(occurred_at), transaction_type
      ORDER BY month_no, transaction_type
    `,
    [userId, year],
  );
  const [categories] = await db.query(
    `
      SELECT e.transaction_type,
             COALESCE(c.name, 'Lainnya') AS category,
             SUM(e.amount) AS total,
             COUNT(*) AS count
      FROM transactions e
      LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.user_id = ?
        AND e.deleted_at IS NULL
        AND MONTH(e.occurred_at) = ?
        AND YEAR(e.occurred_at) = ?
      GROUP BY e.transaction_type, c.name
      ORDER BY e.transaction_type, total DESC
    `,
    [userId, currentMonth, year],
  );
  const [entries] = await db.query(
    `
      SELECT e.occurred_at,
             e.transaction_type,
             COALESCE(c.name, 'Lainnya') AS category,
             e.description,
             e.amount,
             e.source
      FROM transactions e
      LEFT JOIN finance_categories c ON c.id = e.category_id
      WHERE e.user_id = ?
        AND e.deleted_at IS NULL
        AND YEAR(e.occurred_at) = ?
      ORDER BY e.occurred_at DESC
    `,
    [userId, year],
  );
  const [userRows] = await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
  return { monthly, categories, entries, user: userRows[0] };
}

export function buildReportTables(
  { monthly, categories, entries, user },
  year,
  currentMonth = new Date().getMonth() + 1,
) {
  const byMonth = new Map();
  for (const row of monthly) {
    const current = byMonth.get(row.month_no) || { income: 0, expense: 0 };
    current[row.transaction_type] = Number(row.total);
    byMonth.set(row.month_no, current);
  }

  const monthlyRows = [["Bulan", "Pemasukan", "Pengeluaran", "Saldo", "% Tabungan"]];
  for (let month = 1; month <= 12; month += 1) {
    const data = byMonth.get(month) || { income: 0, expense: 0 };
    const saldo = data.income - data.expense;
    monthlyRows.push([shortMonthNames[month - 1], data.income, data.expense, saldo, data.income ? saldo / data.income : 0]);
  }
  const incomeYear = monthlyRows.slice(1).reduce((sum, row) => sum + Number(row[1]), 0);
  const expenseYear = monthlyRows.slice(1).reduce((sum, row) => sum + Number(row[2]), 0);
  const current = byMonth.get(currentMonth) || { income: 0, expense: 0 };
  const currentSaldo = current.income - current.expense;

  const expenseCategories = categories.filter((row) => row.transaction_type === "expense");
  const dashboardExpenseCategories =
    expenseCategories.length > 10
      ? [
          ...expenseCategories.slice(0, 9),
          expenseCategories.slice(9).reduce(
            (summary, row) => ({
              transaction_type: "expense",
              category: "Kategori Lainnya",
              total: Number(summary.total) + Number(row.total || 0),
              count: Number(summary.count) + Number(row.count || 0),
            }),
            { transaction_type: "expense", category: "Kategori Lainnya", total: 0, count: 0 },
          ),
        ]
      : expenseCategories;
  const dashboardCategories = dashboardExpenseCategories;
  const currentMonthIncome = current.income;
  const currentMonthExpense = current.expense;
  const currentMonthTransactionCount = categories.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0,
  );
  const currentMonthEntries = entries.filter((entry) => {
    const occurredAt = new Date(entry.occurred_at);
    return occurredAt.getFullYear() === year && occurredAt.getMonth() + 1 === currentMonth;
  });
  const currentMonthExpenseEntries = currentMonthEntries.filter(
    (entry) => entry.transaction_type === "expense",
  );
  const currentMonthIncomeEntries = currentMonthEntries.filter(
    (entry) => entry.transaction_type === "income",
  );
  const largestExpense = currentMonthExpenseEntries.reduce(
    (largest, entry) => (Number(entry.amount) > Number(largest?.amount || 0) ? entry : largest),
    null,
  );
  const largestExpenseCategory = expenseCategories[0]?.category || "Belum ada pengeluaran";
  const mostFrequentExpenseCategory = [...expenseCategories].sort(
    (left, right) => Number(right.count || 0) - Number(left.count || 0),
  )[0]?.category || "Belum ada pengeluaran";
  const averageExpense = currentMonthExpenseEntries.length
    ? currentMonthExpense / currentMonthExpenseEntries.length
    : 0;
  const dashboardCategoryRows = dashboardCategories.map((row) => {
    const total = Number(row.total);
    return {
      category: row.category,
      total,
      count: Number(row.count || 0),
      share: currentMonthExpense ? total / currentMonthExpense : 0,
    };
  });
  while (dashboardCategoryRows.length < 10) {
    dashboardCategoryRows.push({ category: "", total: "", count: "", share: 0 });
  }

  const dashboard = [
    [formatDashboardDate(), "", "", "", "", "", "", "", "", "", ""],
    [],
    ["Dashboard", "", "", "", "", "", "", "Tahun", year, "", ""],
    ["", "", "", "", "", "", "", "Bulan", monthNames[currentMonth - 1], "", ""],
    [],
    ["Total Pemasukan", "Total Pengeluaran", "Saldo Bersih", "Jumlah Transaksi", "Rasio Pengeluaran", "", "", "", "", "", "", ""],
    [currentMonthIncome, currentMonthExpense, currentSaldo, currentMonthTransactionCount, currentMonthIncome ? currentMonthExpense / currentMonthIncome : 0, "", "", "", "", "", "", ""],
    [],
    ["Kategori", "Total Pengeluaran", "Transaksi", "Persentase", "Distribusi", "", "", "", "", "Bulan", "Pemasukan", "Pengeluaran"],
  ];
  const monthlyHighlights = [
    ["Kategori Terbesar", largestExpenseCategory],
    ["Pengeluaran Terbesar", Number(largestExpense?.amount || 0)],
    ["Rata-rata Pengeluaran", averageExpense],
    ["Transaksi Pengeluaran", currentMonthExpenseEntries.length],
    ["Transaksi Pemasukan", currentMonthIncomeEntries.length],
    ["Kategori Paling Sering", mostFrequentExpenseCategory],
  ];
  dashboardCategoryRows.forEach((row) => {
    const progressLength = row.share ? Math.max(1, Math.min(20, Math.round(row.share * 20))) : 0;
    dashboard.push([
      row.category,
      row.total,
      row.count,
      row.share,
      row.category ? "█".repeat(progressLength) : "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
  dashboard.push(["", "", "", 0, "", "", "", "", "", "", "", ""]);
  dashboard[5][6] = "Ringkasan Bulan Ini";
  monthlyHighlights.forEach(([label, value], index) => {
    const rowIndex = 6 + index;
    while (dashboard[rowIndex].length < 9) dashboard[rowIndex].push("");
    dashboard[rowIndex][6] = label;
    dashboard[rowIndex][8] = value;
  });
  for (let month = 1; month <= 12; month += 1) {
    const rowIndex = 8 + month;
    const monthData = byMonth.get(month) || { income: 0, expense: 0 };
    while (dashboard.length <= rowIndex) dashboard.push([]);
    while (dashboard[rowIndex].length < 12) dashboard[rowIndex].push("");
    dashboard[rowIndex][9] = shortMonthNames[month - 1];
    dashboard[rowIndex][10] = monthData.income;
    dashboard[rowIndex][11] = monthData.expense;
  }

  const incomeRows = [["Pemasukan Tahun " + year], [], ["Kategori Pemasukan", "", ...monthNames]];
  const incomeCategories = new Map();
  for (const row of entries.filter((entry) => entry.transaction_type === "income")) {
    const month = new Date(row.occurred_at).getMonth();
    const category = row.category || "Pemasukan Lainnya";
    const values = incomeCategories.get(category) || Array(12).fill(0);
    values[month] += Number(row.amount);
    incomeCategories.set(category, values);
  }
  for (const [category, values] of incomeCategories.entries()) incomeRows.push([category, "", ...values]);
  incomeRows.push(["Total", "", ...monthlyRows.slice(1).map((row) => row[1])]);

  const usageRows = [["Pengeluaran Tahun " + year], [], ["Kategori Pengeluaran", "", ...monthNames]];
  const usageCategories = new Map();
  for (const row of entries.filter((entry) => entry.transaction_type === "expense")) {
    const month = new Date(row.occurred_at).getMonth();
    const category = row.category || "Pengeluaran Lainnya";
    const values = usageCategories.get(category) || Array(12).fill(0);
    values[month] += Number(row.amount);
    usageCategories.set(category, values);
  }
  for (const [category, values] of usageCategories.entries()) usageRows.push([category, "", ...values]);
  usageRows.push(["Total", "", ...monthlyRows.slice(1).map((row) => row[2])]);

  const expensesRows = [["Cek", "Tanggal", "Bulan", "Transaksi", "Uraian", "Kategori", "Sumber", "Nilai"]];
  for (const row of entries) {
    expensesRows.push([
      true,
      row.occurred_at ? new Date(row.occurred_at).toISOString().slice(0, 10) : "",
      row.occurred_at ? monthNames[new Date(row.occurred_at).getMonth()] : "",
      row.transaction_type === "income" ? "Pemasukan" : "Pengeluaran",
      row.description || "",
      row.category,
      row.source,
      Number(row.amount),
    ]);
  }
  return { dashboard, incomeRows, usageRows, expensesRows, monthlyRows };
}

async function formatReportSheets(sheets, spreadsheetId, sheetMap, tables) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title,sheetId),charts(chartId))",
  });
  const dashboardMeta = (meta.data.sheets || []).find((sheet) => sheet.properties?.title === "Dashboard");
  const dark = { red: 0.05, green: 0.29, blue: 0.26 };
  const medium = { red: 0.07, green: 0.43, blue: 0.39 };
  const green = { red: 0.38, green: 0.8, blue: 0.55 };
  const light = { red: 0.87, green: 0.96, blue: 0.91 };
  const pale = { red: 0.73, green: 0.94, blue: 0.82 };
  const white = { red: 1, green: 1, blue: 1 };
  const requests = [];

  for (const chart of dashboardMeta?.charts || []) {
    requests.push({ deleteEmbeddedObject: { objectId: chart.chartId } });
  }

  for (const title of reportSheets) {
    const sheetId = sheetMap.get(title);
    requests.push(
      { unmergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 } } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: title === "Transaksi" ? 1 : 3 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 42 }, fields: "pixelSize" } },
    );

    if (title === "Dashboard") {
      requests.push(
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { backgroundColor: white, horizontalAlignment: "LEFT", textFormat: { bold: false, fontSize: 10, foregroundColor: { red: 0, green: 0, blue: 0 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        ...columnWidthRequests(sheetId, [150, 150, 150, 150, 118, 24, 150, 28, 120, 20, 20, 20, 20, 20]),
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 38 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 5, endIndex: 7 }, properties: { pixelSize: 28 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 8, endIndex: 20 }, properties: { pixelSize: 24 }, fields: "pixelSize" } },
      );
    } else if (title === "Pemasukan" || title === "Pengeluaran") {
      requests.push(...columnWidthRequests(sheetId, [170, 28, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108]));
    } else {
      requests.push(...columnWidthRequests(sheetId, [50, 105, 95, 120, 260, 150, 115, 125]));
    }
  }

  for (const title of reportSheets) {
    const sheetId = sheetMap.get(title);
    const headerRow = title === "Transaksi" ? 0 : 2;
    if (title === "Dashboard") {
      requests.push(
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 6, endColumnIndex: 9 }, mergeType: "MERGE_ALL" } },
        ...Array.from({ length: 6 }, (_, index) => ({
          mergeCells: {
            range: { sheetId, startRowIndex: 6 + index, endRowIndex: 7 + index, startColumnIndex: 6, endColumnIndex: 8 },
            mergeType: "MERGE_ALL",
          },
        })),
      );
    } else if (title !== "Transaksi") {
      requests.push(
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 14 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 14 }, mergeType: "MERGE_ALL" } },
      );
    }
    if (title !== "Dashboard") {
      requests.push(
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: dark } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" } },
        { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { backgroundColor: light, textFormat: { foregroundColor: { red: 0.28, green: 0.33, blue: 0.41 } } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: headerRow, endRowIndex: headerRow + 1, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: dark, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
      );
    }
    if (title === "Dashboard") {
      requests.push(
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: green, horizontalAlignment: "LEFT", textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: green } }, fields: "userEnteredFormat.backgroundColor" } },
        { repeatCell: { range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 7 }, cell: { userEnteredFormat: { horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: "userEnteredFormat(horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 10 }, cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 0.1, green: 0.28, blue: 0.25 } } } }, fields: "userEnteredFormat.textFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: green, horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: pale, horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 0.1, green: 0.25, blue: 0.25 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 8, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: green, horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 6, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: medium, horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: white } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 12, startColumnIndex: 6, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: light, horizontalAlignment: "LEFT", textFormat: { bold: true, foregroundColor: dark } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 12, startColumnIndex: 8, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: pale, horizontalAlignment: "RIGHT", textFormat: { bold: true, foregroundColor: dark } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 7, endRowIndex: 9, startColumnIndex: 8, endColumnIndex: 9 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 11, startColumnIndex: 8, endColumnIndex: 9 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { horizontalAlignment: "RIGHT" } }, fields: "userEnteredFormat.horizontalAlignment" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat.horizontalAlignment" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { horizontalAlignment: "LEFT", textFormat: { foregroundColor: { red: 1, green: 0.6, blue: 0 } } } }, fields: "userEnteredFormat(horizontalAlignment,textFormat.foregroundColor)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: light } }, fields: "userEnteredFormat.backgroundColor" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.00%" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 20, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.00%" } } }, fields: "userEnteredFormat.numberFormat" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 12 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
      );
    }
    if (title === "Pemasukan" || title === "Pengeluaran") {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 1000, startColumnIndex: 2, endColumnIndex: 14 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    if (title === "Transaksi") {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 7, endColumnIndex: 8 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
  }

  const dashboardSheetId = sheetMap.get("Dashboard");
  requests.push(
    {
      addChart: {
        chart: {
          spec: {
            title: "Pengeluaran per Kategori",
            hiddenDimensionStrategy: "SHOW_ALL",
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              threeDimensional: false,
              domain: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 1 }] } },
              series: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 1, endColumnIndex: 2 }] } },
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: dashboardSheetId, rowIndex: 20, columnIndex: 0 },
              offsetXPixels: 4,
              offsetYPixels: 4,
              widthPixels: 410,
              heightPixels: 245,
            },
          },
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: "Tren Pemasukan dan Pengeluaran",
            hiddenDimensionStrategy: "SHOW_ALL",
            basicChart: {
              chartType: "COLUMN",
              legendPosition: "RIGHT_LEGEND",
              axis: [
                { position: "BOTTOM_AXIS", title: "Bulan" },
                { position: "LEFT_AXIS", title: "" },
              ],
              domains: [{ domain: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 8, endRowIndex: 21, startColumnIndex: 9, endColumnIndex: 10 }] } } }],
              series: [
                { series: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 8, endRowIndex: 21, startColumnIndex: 10, endColumnIndex: 11 }] } }, targetAxis: "LEFT_AXIS" },
                { series: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 8, endRowIndex: 21, startColumnIndex: 11, endColumnIndex: 12 }] } }, targetAxis: "LEFT_AXIS" },
              ],
              headerCount: 1,
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: dashboardSheetId, rowIndex: 20, columnIndex: 3 },
              offsetXPixels: 8,
              offsetYPixels: 4,
              widthPixels: 600,
              heightPixels: 245,
            },
          },
        },
      },
    },
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

export async function generateGoogleSheetsFinanceReport(db, userId, year = new Date().getFullYear()) {
  const { sheets, drive, sheetName, config } = await getSheetsClient();
  const currentMonth = new Date().getMonth() + 1;
  const data = await fetchReportData(db, userId, year, currentMonth);
  const userSpreadsheet = await getOrCreateUserSpreadsheet(
    db,
    drive,
    config,
    userId,
    data.user,
    year,
  );
  const spreadsheetId = userSpreadsheet.spreadsheet_id;
  const sheetMap = await ensureReportSheets(sheets, spreadsheetId);
  const tables = buildReportTables(data, year, currentMonth);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: reportSheets.map((title) => ({
        unmergeCells: {
          range: {
            sheetId: sheetMap.get(title),
            startRowIndex: 0,
            endRowIndex: 1000,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
        },
      })),
    },
  });

  for (const title of reportSheets) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${title}!A1:Z1000` });
  }
  const updates = [
    { range: "Dashboard!A1", values: tables.dashboard },
    { range: "Pemasukan!A1", values: tables.incomeRows },
    { range: "Pengeluaran!A1", values: tables.usageRows },
    { range: "Transaksi!A1", values: tables.expensesRows },
  ];
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: updates },
  });
  await formatReportSheets(sheets, spreadsheetId, sheetMap, tables);
  if (!userSpreadsheet.is_legacy_shared_sheet) {
    await db.query(
      "UPDATE user_spreadsheets SET last_exported_at = CURRENT_TIMESTAMP WHERE user_id = ? AND spreadsheet_id = ?",
      [userId, spreadsheetId],
    );
  }

  return {
    spreadsheetId,
    sheetName,
    url: userSpreadsheet.spreadsheet_url || buildSpreadsheetUrl(spreadsheetId),
    rows: tables.expensesRows.length,
  };
}
