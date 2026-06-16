import assert from "node:assert/strict";
import { buildReportTables, fetchReportData } from "../src/googleSheetsReport.js";

const queryCalls = [];
const db = {
  async query(sql, params) {
    queryCalls.push({ sql, params });
    if (sql.includes("GROUP BY MONTH(occurred_at)")) {
      return [[{ month_no: 6, transaction_type: "expense", total: 130000 }]];
    }
    if (sql.includes("GROUP BY e.transaction_type, c.name")) {
      return [[{ transaction_type: "expense", category: "Belanja", total: 130000, count: 130 }]];
    }
    if (sql.includes("ORDER BY e.occurred_at DESC")) {
      return [[
        ...Array.from({ length: 130 }, (_, index) => ({
          occurred_at: new Date(2026, 5, 1, 12, index % 60),
          transaction_type: "expense",
          category: "Belanja",
          description: `Transaksi ${index + 1}`,
          amount: 1000,
          source: "telegram_bot",
        })),
      ]];
    }
    if (sql.includes("FROM users")) return [[{ id: "user-1", full_name: "QA User" }]];
    throw new Error(`Unexpected query: ${sql}`);
  },
};

const data = await fetchReportData(db, "user-1", 2026, 6);
const tables = buildReportTables(data, 2026, 6);
const dashboardValues = tables.dashboard[6];
const dashboardHeaders = tables.dashboard[5];
const dashboardCategoryHeaders = tables.dashboard[8];
const dashboardCategory = tables.dashboard[9];
const usageCategory = tables.usageRows.find((row) => row[0] === "Belanja");
const usageTotal = tables.usageRows.at(-1);

assert.equal(data.entries.length, 130, "Detail laporan tidak boleh dibatasi 120 transaksi");
assert.equal(dashboardValues[1], 130000, "Dashboard harus menghitung semua pengeluaran Juni");
assert.equal(dashboardValues[3], 130, "Dashboard harus menampilkan jumlah transaksi bulan aktif");
assert.deepEqual(
  dashboardHeaders.slice(0, 5),
  ["Total Pemasukan", "Total Pengeluaran", "Saldo Bersih", "Jumlah Transaksi", "Rasio Pengeluaran"],
);
assert.deepEqual(
  dashboardCategoryHeaders.slice(0, 5),
  ["Kategori", "Total Pengeluaran", "Transaksi", "Persentase", "Distribusi"],
);
assert.equal(dashboardCategory[1], 130000);
assert.equal(dashboardCategory[2], 130);
assert.equal(dashboardCategory[3], 1);
assert.equal(tables.dashboard[5][6], "Ringkasan Bulan Ini");
assert.deepEqual(tables.dashboard[6].slice(6, 9), ["Kategori Terbesar", "", "Belanja"]);
assert.deepEqual(tables.dashboard[7].slice(6, 9), ["Pengeluaran Terbesar", "", 1000]);
assert.deepEqual(tables.dashboard[8].slice(6, 9), ["Rata-rata Pengeluaran", "", 1000]);
assert.deepEqual(tables.dashboard[9].slice(6, 9), ["Transaksi Pengeluaran", "", 130]);
assert.deepEqual(tables.dashboard[10].slice(6, 9), ["Transaksi Pemasukan", "", 0]);
assert.deepEqual(tables.dashboard[11].slice(6, 9), ["Kategori Paling Sering", "", "Belanja"]);
assert.ok(!JSON.stringify(tables.dashboard).includes("Alokasi"), "Dashboard tidak boleh membuat alokasi sintetis");
assert.ok(!JSON.stringify(tables).includes("Realisasi"), "Laporan tidak boleh memakai istilah realisasi");
assert.deepEqual(tables.dashboard[14].slice(9, 12), ["Jun", 0, 130000]);
assert.equal(usageCategory[7], 130000, "Kategori Pengeluaran Juni harus menghitung semua transaksi");
assert.equal(usageTotal[7], 130000, "Total Pengeluaran Juni harus mengikuti agregasi terbaru");

const categoryQuery = queryCalls.find((call) => call.sql.includes("GROUP BY e.transaction_type, c.name"));
const entriesQuery = queryCalls.find((call) => call.sql.includes("ORDER BY e.occurred_at DESC"));
assert.deepEqual(categoryQuery.params, ["user-1", 6, 2026]);
assert.deepEqual(entriesQuery.params, ["user-1", 2026]);
assert.ok(!/LIMIT\s+120/i.test(entriesQuery.sql), "Query detail tidak boleh memakai LIMIT statis");

console.log("Google Sheets report regression test passed.");
