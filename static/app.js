const logBox = document.querySelector("#logBox");
const resultsEl = document.querySelector("#results");
const schedulerStatus = document.querySelector("#schedulerStatus");
const resultCount = document.querySelector("#resultCount");
const configGrid = document.querySelector("#configGrid");

function log(message) {
  logBox.textContent = `${new Date().toLocaleTimeString()}  ${message}\n${logBox.textContent}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "Request gagal");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function renderConfig(config) {
  const items = {
    Provider: config.emailProvider,
    IMAP: `${config.imapHost}:${config.imapPort}`,
    Email: config.emailAddress || "-",
    Mailbox: config.mailbox,
    "Scan limit": config.scanLimit,
    "Ambang penting": config.forwardThreshold,
    Scheduler: `${config.pollIntervalSeconds}s`,
    AI: config.useOpenAI ? "OpenAI aktif" : "Rules lokal",
    "Bot Email": config.emailBotPolling ? "Polling aktif" : "Polling mati",
    "Bot Keuangan": config.financeBotPolling ? "Polling aktif" : "Polling mati",
  };

  configGrid.innerHTML = Object.entries(items)
    .map(([label, value]) => `
      <div class="config-item">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `)
    .join("");
}

function normalizeReasons(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function renderResults(results) {
  resultCount.textContent = String(results.length);
  if (!results.length) {
    resultsEl.innerHTML = "<p>Belum ada email yang diproses.</p>";
    return;
  }

  resultsEl.innerHTML = results
    .map((item) => {
      const low = Number(item.score) < 70 ? "low" : "";
      const shouldForward = Boolean(item.shouldForward ?? item.should_forward);
      const badgeClass = item.forwarded ? "forward" : shouldForward ? "wait" : "";
      const badge = item.forwarded ? "Terkirim" : shouldForward ? "Penting" : "Lewati";
      const reasons = normalizeReasons(item.reasons)
        .map((reason) => `<div>${escapeHtml(reason)}</div>`)
        .join("");
      return `
        <article class="result-card">
          <div class="score ${low}">${escapeHtml(item.score ?? 0)}</div>
          <div class="email-main">
            <strong>${escapeHtml(item.subject || "(tanpa subjek)")}</strong>
            <span>${escapeHtml(item.sender || "-")}</span>
            <span>${escapeHtml(item.date || item.email_date || "")}</span>
            <div class="reasons">${reasons}</div>
          </div>
          <div class="badge ${badgeClass}">${badge}</div>
        </article>
      `;
    })
    .join("");
}

async function refresh() {
  const data = await api("/api/status");
  renderConfig(data.config);
  schedulerStatus.textContent = `Scheduler: ${data.schedulerRunning ? "jalan" : "mati"}`;
  schedulerStatus.style.background = data.schedulerRunning ? "#e9f8f2" : "#f2f4f5";
  renderResults(data.emails || []);
  if (data.lastRun?.error_text) log(`Error terakhir: ${data.lastRun.error_text}`);
}

async function runAction(path, okMessage) {
  try {
    log("Menjalankan...");
    const data = await api(path, { method: "POST", body: "{}" });
    if (data.results) renderResults(data.results);
    log(okMessage);
    await refresh();
  } catch (error) {
    log(error.message);
  }
}

document.querySelector("#testTelegram").addEventListener("click", () => runAction("/api/test-telegram", "Tes Telegram berhasil dikirim."));
document.querySelector("#scanPreview").addEventListener("click", () => runAction("/api/scan-preview", "Scan preview selesai."));
document.querySelector("#scanSend").addEventListener("click", () => runAction("/api/scan-send", "Scan selesai, email penting dikirim."));
document.querySelector("#startScheduler").addEventListener("click", () => runAction("/api/start", "Scheduler dinyalakan."));
document.querySelector("#stopScheduler").addEventListener("click", () => runAction("/api/stop", "Scheduler dimatikan."));

refresh().catch((error) => log(error.message));
setInterval(() => refresh().catch(() => {}), 10000);
