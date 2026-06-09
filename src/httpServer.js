import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import {
  getEmailStatus,
  getSchedulerRunning,
  scanOnce,
  startScheduler,
  stopScheduler,
  testEmailTelegram,
} from "./emailForwarder.js";
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
