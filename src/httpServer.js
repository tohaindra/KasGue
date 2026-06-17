import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import {
  getEmailStatus,
  getSchedulerRunning,
  scanOnce,
  startScheduler,
  stopScheduler,
  testEmailTelegram,
} from "./emailForwarder.js";
import { generateGoogleSheetsFinanceReport } from "./googleSheetsReport.js";
import { getBotPollingState } from "./telegram.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const staticDir = join(rootDir, "static");

async function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function isAuthorizedInternalRequest(req, config) {
  if (!config.internalApiKey) return true;
  return req.headers["x-internal-api-key"] === config.internalApiKey;
}

function getHttpErrorStatus(error) {
  const status = Number(error?.status || error?.code || error?.response?.status || 500);
  return status >= 400 && status <= 599 ? status : 500;
}

function getHttpErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.message ||
    "Terjadi kesalahan saat membuat laporan Google Sheets."
  );
}

async function handleGoogleSheetsExport(req, res) {
  let db;
  try {
    const config = getConfig();
    if (!isAuthorizedInternalRequest(req, config)) {
      return sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "Invalid internal API key." } });
    }

    const body = await readJsonBody(req);
    const userId = String(body.user_id || body.userId || "").trim();
    const year = body.year ? Number(body.year) : new Date().getFullYear();
    if (!userId) {
      return sendJson(res, 422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "user_id wajib diisi.",
          fields: { user_id: "Required." },
        },
      });
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return sendJson(res, 422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "year tidak valid.",
          fields: { year: "Gunakan tahun 2000-2100." },
        },
      });
    }

    db = await getDb();
    const result = await generateGoogleSheetsFinanceReport(db, userId, year);
    return sendJson(res, 200, { data: result });
  } catch (error) {
    const status = getHttpErrorStatus(error);
    const message = getHttpErrorMessage(error);
    console.error("[reports:google-sheets]", message);
    return sendJson(res, status, {
      error: {
        code: "GOOGLE_SHEETS_EXPORT_FAILED",
        message,
      },
    });
  } finally {
    if (db) await db.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = pathname.replace(/^\/static\//, "").replace(/^\//, "");
  const filePath = join(staticDir, relativePath);
  const contentType =
    extname(filePath) === ".css"
      ? "text/css; charset=utf-8"
      : extname(filePath) === ".js"
        ? "application/javascript; charset=utf-8"
        : "text/html; charset=utf-8";
  const body = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

async function getStatus() {
  const config = getConfig();
  const emailStatus = await getEmailStatus();
  const polling = getBotPollingState();
  return {
    config: {
      emailProvider: config.emailProvider,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      emailAddress: config.emailAddress,
      mailbox: config.mailbox,
      scanLimit: config.scanLimit,
      forwardThreshold: config.forwardThreshold,
      pollIntervalSeconds: config.pollIntervalSeconds,
      emailForwarderEnabled: config.emailForwarderEnabled,
      useOpenAI: config.useOpenAI,
      emailBotPolling: polling.email,
      financeBotPolling: polling.finance,
      importantKeywords: config.importantKeywords,
      importantSenders: config.importantSenders,
    },
    schedulerRunning: getSchedulerRunning(),
    lastRun: emailStatus.lastRun,
    emails: emailStatus.emails,
  };
}

export function createAppServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url.startsWith("/api/status")) {
        return sendJson(res, 200, await getStatus());
      }
      if (req.method === "POST" && req.url === "/api/v1/internal/reports/google-sheets") {
        return await handleGoogleSheetsExport(req, res);
      }
      if (req.method === "POST" && req.url === "/api/test-telegram") {
        return sendJson(res, 200, await testEmailTelegram());
      }
      if (req.method === "POST" && req.url === "/api/scan-preview") {
        return sendJson(res, 200, await scanOnce({ send: false }));
      }
      if (req.method === "POST" && req.url === "/api/scan-send") {
        return sendJson(res, 200, await scanOnce({ send: true }));
      }
      if (req.method === "POST" && req.url === "/api/start") {
        startScheduler();
        return sendJson(res, 200, { ok: true, schedulerRunning: getSchedulerRunning() });
      }
      if (req.method === "POST" && req.url === "/api/stop") {
        stopScheduler();
        return sendJson(res, 200, { ok: true, schedulerRunning: getSchedulerRunning() });
      }
      if (req.method === "POST" && req.url === "/api/reload-env") {
        await readBody(req);
        return sendJson(res, 200, { ok: true, message: "Restart server untuk membaca .env baru." });
      }
      if (req.method === "GET") return serveStatic(req, res);
      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  });
}
