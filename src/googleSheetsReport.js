import { getConfig } from "./config.js";

const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const shortMonthNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const reportSheets = ["Dashboard", "Income", "Usage", "Expenses"];
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
  if (!config.googleSheetId) throw new Error("GOOGLE_SHEET_ID wajib diisi.");

  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleServiceAccountKeyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return {
    sheets: google.sheets({ version: "v4", auth }),
    spreadsheetId: getSpreadsheetIdFromUrl(config.googleSheetId),
    sheetName: config.googleSheetName,
  };
}

async function getSheetMap(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return new Map((meta.data.sheets || []).map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
}

async function ensureReportSheets(sheets, spreadsheetId) {
  let sheetMap = await getSheetMap(sheets, spreadsheetId);
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

async function fetchReportData(db, userId, year) {
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
        AND MONTH(e.occurred_at) = MONTH(CURDATE())
        AND YEAR(e.occurred_at) = YEAR(CURDATE())
      GROUP BY e.transaction_type, c.name
      ORDER BY e.transaction_type, total DESC
    `,
    [userId],
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
      ORDER BY e.occurred_at DESC
      LIMIT 120
    `,
    [userId],
  );
  const [userRows] = await db.query("SELECT * FROM finance_users WHERE id = ? LIMIT 1", [userId]);
  return { monthly, categories, entries, user: userRows[0] };
}

function buildReportTables({ monthly, categories, entries, user }, year) {
  const byMonth = new Map();
  for (const row of monthly) {
    const current = byMonth.get(row.month_no) || { income: 0, expense: 0 };
    current[row.transaction_type] = Number(row.total);
    byMonth.set(row.month_no, current);
  }

  const currentMonth = new Date().getMonth() + 1;
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

  const dashboardExpenseCategories = categories.filter((row) => row.transaction_type === "expense").slice(0, 10);
  const dashboardCategories = dashboardExpenseCategories.length ? dashboardExpenseCategories : categories.slice(0, 10);
  const currentMonthIncome = current.income;
  const currentMonthExpense = current.expense;
  const fallbackAllocation = dashboardCategories.length ? Math.ceil(currentMonthIncome / dashboardCategories.length) : 0;
  const dashboardCategoryRows = dashboardCategories.map((row) => {
    const total = Number(row.total);
    const allocation = row.transaction_type === "expense" ? Math.max(total, fallbackAllocation) : total;
    return { category: row.category, allocation, total };
  });
  while (dashboardCategoryRows.length < 10) {
    dashboardCategoryRows.push({ category: "", allocation: "", total: "" });
  }
  const totalAllocation = dashboardCategoryRows.reduce((sum, row) => sum + Number(row.allocation || 0), 0);

  const dashboard = [
    [formatDashboardDate(), "", "", "", "", "", "", "", "", "", ""],
    [],
    ["Dashboard", "", "", "", "", "", "", "Tahun", year, "", ""],
    ["", "", "", "", "", "", "", "Bulan", monthNames[currentMonth - 1], "", ""],
    [],
    ["Total Income", "Total Realisasi", "Total Alokasi", "Saldo", "%", "", "", "", "", "", ""],
    [currentMonthIncome, currentMonthExpense, totalAllocation, currentSaldo, currentMonthIncome ? currentMonthExpense / currentMonthIncome : 0, "", "", "", "", "", ""],
    [],
    ["Kategori", "Alokasi", "Realisasi", "Progres", "%", "", "", "", "", "", ""],
  ];
  dashboardCategoryRows.forEach((row, index) => {
    const progressLength = row.allocation ? Math.max(1, Math.min(20, Math.round((Number(row.total || 0) / Number(row.allocation || 1)) * 20))) : 0;
    dashboard.push([
      row.category,
      row.allocation,
      row.total,
      row.category ? "█".repeat(progressLength) : "",
      row.allocation ? Number(row.total || 0) / Number(row.allocation || 1) : 0,
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
  dashboard.push(["", "", "", "", 0, "", "", "", "", "", ""]);

  const incomeRows = [["Pendapatan Tahun " + year], [], ["Income", "", ...monthNames]];
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

  const usageRows = [["Penggunaan Tahun " + year], [], ["Realisasi", "", ...monthNames]];
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
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: title === "Expenses" ? 1 : 3 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } },
      { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 42 }, fields: "pixelSize" } },
    );

    if (title === "Dashboard") {
      requests.push(
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { backgroundColor: white, horizontalAlignment: "LEFT", textFormat: { bold: false, fontSize: 10, foregroundColor: { red: 0, green: 0, blue: 0 } } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
        ...columnWidthRequests(sheetId, [150, 150, 150, 150, 118, 28, 28, 76, 76, 20, 20, 20, 20, 20]),
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 38 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 5, endIndex: 7 }, properties: { pixelSize: 28 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 8, endIndex: 20 }, properties: { pixelSize: 24 }, fields: "pixelSize" } },
      );
    } else if (title === "Income" || title === "Usage") {
      requests.push(...columnWidthRequests(sheetId, [170, 28, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108]));
    } else {
      requests.push(...columnWidthRequests(sheetId, [50, 105, 95, 120, 260, 150, 115, 125]));
    }
  }

  for (const title of ["Dashboard", "Income", "Usage", "Expenses"]) {
    const sheetId = sheetMap.get(title);
    const headerRow = title === "Expenses" ? 0 : 2;
    if (title === "Dashboard") {
      requests.push(
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: "MERGE_ALL" } },
        { mergeCells: { range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 7 }, mergeType: "MERGE_ALL" } },
      );
    } else if (title !== "Expenses") {
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
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { horizontalAlignment: "RIGHT" } }, fields: "userEnteredFormat.horizontalAlignment" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { horizontalAlignment: "LEFT" } }, fields: "userEnteredFormat.horizontalAlignment" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { horizontalAlignment: "LEFT", textFormat: { foregroundColor: { red: 1, green: 0.6, blue: 0 } } } }, fields: "userEnteredFormat(horizontalAlignment,textFormat.foregroundColor)" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: light } }, fields: "userEnteredFormat.backgroundColor" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.00%" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 1, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } },
        { repeatCell: { range: { sheetId, startRowIndex: 9, endRowIndex: 20, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.00%" } } }, fields: "userEnteredFormat.numberFormat" } },
        { addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 2, endColumnIndex: 3 }], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=C10>B10" }] }, format: { backgroundColor: { red: 1, green: 0.08, blue: 0.06 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } } }, index: 0 } },
      );
    }
    if (title === "Income" || title === "Usage") {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 3, endRowIndex: 1000, startColumnIndex: 2, endColumnIndex: 14 },
          cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "Rp#,##0;[Red](Rp#,##0);\"Rp0\"" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    if (title === "Expenses") {
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
            title: "Alokasi",
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
            title: "Alokasi dan Realisasi",
            basicChart: {
              chartType: "AREA",
              legendPosition: "RIGHT_LEGEND",
              axis: [
                { position: "BOTTOM_AXIS", title: "Jenis" },
                { position: "LEFT_AXIS", title: "" },
              ],
              domains: [{ domain: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
              series: [
                { series: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 1, endColumnIndex: 2 }] } }, targetAxis: "LEFT_AXIS" },
                { series: { sourceRange: { sources: [{ sheetId: dashboardSheetId, startRowIndex: 9, endRowIndex: 19, startColumnIndex: 2, endColumnIndex: 3 }] } }, targetAxis: "LEFT_AXIS" },
              ],
              headerCount: 0,
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: dashboardSheetId, rowIndex: 20, columnIndex: 4 },
              offsetXPixels: 8,
              offsetYPixels: 4,
              widthPixels: 455,
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
  const { sheets, spreadsheetId, sheetName } = await getSheetsClient();
  const sheetMap = await ensureReportSheets(sheets, spreadsheetId);
  const data = await fetchReportData(db, userId, year);
  const tables = buildReportTables(data, year);

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
    { range: "Income!A1", values: tables.incomeRows },
    { range: "Usage!A1", values: tables.usageRows },
    { range: "Expenses!A1", values: tables.expensesRows },
  ];
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data: updates },
  });
  await formatReportSheets(sheets, spreadsheetId, sheetMap, tables);

  return {
    spreadsheetId,
    sheetName,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`,
    rows: tables.expensesRows.length,
  };
}
