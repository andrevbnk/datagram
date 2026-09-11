#!/usr/bin/env node
/**
 * Datagram Search Scheduler (admin API)
 *
 * Once a day (default 13:00) runs a search session using the Datagram ADMIN
 * API (/api/v1/jobs) instead of the public /tasks endpoint. The public
 * endpoint is blocked by a stuck "concurrent jobs" counter on the backend,
 * while the admin API works fine.
 *
 * Auth: logs in with email/password to get a JWT (renews on expiry).
 * Each keyword becomes one job (targetIdentifier). Results are downloaded
 * as JSON and Telegram notifications are sent.
 *
 * Usage:
 *   node index.js            # run the scheduler (waits for the daily time)
 *   node index.js --now      # run a session immediately (for testing)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env (secrets) if present — never committed
function loadEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

// ── Config ────────────────────────────────────────────────────────────────
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

const KEYWORDS_FILE = path.join(__dirname, config.keywordsFile);
const STATE_FILE = path.join(__dirname, config.stateFile);
const RESULTS_DIR = path.join(__dirname, config.resultsDir);

const ADMIN_BASE = config.adminApiBaseUrl.replace(/\/+$/, "");
const PUBLIC_BASE = config.apiBaseUrl.replace(/\/+$/, "");

const EMAIL = process.env.DATAGRAM_EMAIL || "";
const PASSWORD = process.env.DATAGRAM_PASSWORD || "";
const API_KEY = process.env.DATAGRAM_API_KEY || config.apiKey || "";

const BATCH_SIZE = config.batchSize; // max 10 concurrent jobs
const MAX_RESULTS = config.limitPerTask;
const RUN_HOUR = config.runHour ?? 13;
const RUN_MINUTE = config.runMinute ?? 0;
const TIMEZONE = config.timezone || "Europe/Berlin";
const POLL_INTERVAL_MS = (config.pollIntervalSeconds ?? 30) * 1000;
const MAX_WAIT_MS = (config.maxWaitMinutes ?? 20) * 60 * 1000;

// Job creation params (mirrors the dashboard)
const JOB_TYPE = 3;
const SCRAPER_JOB_TYPE = 2;
const SKIP_VALIDATOR = false;
const SKIP_AI_ENRICHMENT = true;

// Telegram
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || config.telegramChatId || "";

// Keyword generation modifiers (used when the base pool is exhausted)
const KW_PREFIXES = ["best", "top", "new", "free", "official", "popular", "active", "premium"];
const KW_SUFFIXES = ["group", "community", "chat", "forum", "hub", "network", "club", "channel", "2026", "2025"];

// ── Auth state ────────────────────────────────────────────────────────────
let jwt = null;
let jwtExp = 0;

// ── Helpers ───────────────────────────────────────────────────────────────
function loadKeywords() {
  const raw = JSON.parse(fs.readFileSync(KEYWORDS_FILE, "utf-8"));
  const kws = Array.isArray(raw) ? raw : raw.keywords;
  if (!Array.isArray(kws) || kws.length === 0) {
    throw new Error("keywords.json must contain a non-empty array of keywords");
  }
  return kws;
}

function loadState() {
  const defaults = {
    cursor: 0,
    completed: 0,
    tasks: [],
    usedKeywords: [],
    lastSessionDate: null,
    lastRun: null,
  };
  if (fs.existsSync(STATE_FILE)) {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return { ...defaults, ...existing };
  }
  return defaults;
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── Admin API auth ────────────────────────────────────────────────────────
async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new Error("No admin credentials. Set DATAGRAM_EMAIL and DATAGRAM_PASSWORD in .env.");
  }
  const res = await fetch(`${ADMIN_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) {
    const t = await res.text();
    throw new Error(`Login failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const body = await res.json();
  jwt = body.accessToken;
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  jwtExp = payload.exp * 1000;
  log(`Logged in as ${payload.email} (token expires ${new Date(jwtExp).toISOString()})`);
}

async function ensureAuth() {
  // Renew if missing or within 5 minutes of expiry
  if (!jwt || Date.now() > jwtExp - 5 * 60 * 1000) {
    await login();
  }
}

async function adminApi(pathname, options = {}) {
  await ensureAuth();
  const url = `${ADMIN_BASE}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  // Token expired mid-session — re-login and retry once
  if (res.status === 401) {
    await login();
    const retry = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    return retry;
  }

  return res;
}

// ── Public API (budget only) ──────────────────────────────────────────────
async function getBudget() {
  if (!API_KEY) return null;
  try {
    const res = await fetch(`${PUBLIC_BASE}/me`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    return body.daily_tokens || null;
  } catch {
    return null;
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────
async function tgSend(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log(`Telegram send failed: ${res.status} ${err}`);
    }
  } catch (e) {
    log(`Telegram send error: ${e.message}`);
  }
}

// ── Core actions (admin API) ──────────────────────────────────────────────
async function createJob(targetIdentifier) {
  const res = await adminApi("/jobs", {
    method: "POST",
    body: JSON.stringify({
      type: JOB_TYPE,
      scraperJobType: SCRAPER_JOB_TYPE,
      maxResults: MAX_RESULTS,
      skipValidator: SKIP_VALIDATOR,
      skipAiEnrichment: SKIP_AI_ENRICHMENT,
      targetIdentifier,
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function getJobs() {
  const res = await adminApi("/jobs");
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function getJobResults(jobId) {
  const res = await adminApi(`/jobs/${jobId}/export?format=json`);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ── Keyword selection (no repeats, generate when exhausted) ───────────────
function generateNewKeywords(basePool, usedSet, count) {
  const result = [];
  for (const base of basePool) {
    for (const p of KW_PREFIXES) {
      const kw = `${p} ${base}`;
      if (kw.length <= 100 && !usedSet.has(kw)) {
        result.push(kw);
        if (result.length >= count) return result;
      }
    }
    for (const s of KW_SUFFIXES) {
      const kw = `${base} ${s}`;
      if (kw.length <= 100 && !usedSet.has(kw)) {
        result.push(kw);
        if (result.length >= count) return result;
      }
    }
  }
  return result;
}

function takeNextBatch(state, basePool, count) {
  const usedSet = new Set(state.usedKeywords);
  const batch = [];

  let attempts = 0;
  while (batch.length < count && attempts < basePool.length) {
    const idx = state.cursor % basePool.length;
    const kw = basePool[idx];
    state.cursor = (state.cursor + 1) % basePool.length;
    attempts++;
    if (!usedSet.has(kw)) {
      batch.push(kw);
      usedSet.add(kw);
    }
  }

  if (batch.length < count) {
    const needed = count - batch.length;
    const fresh = generateNewKeywords(basePool, usedSet, needed);
    for (const kw of fresh) {
      batch.push(kw);
      usedSet.add(kw);
    }
  }

  for (const kw of batch) {
    if (!state.usedKeywords.includes(kw)) {
      state.usedKeywords.push(kw);
    }
  }

  return batch;
}

// ── Wait for jobs to finish ───────────────────────────────────────────────
// status: 1=queued, 2=running, 3=completed, 5=cancelled
const TERMINAL_STATUS = new Set([3, 5]);

async function waitForCompletion(jobIds) {
  const start = Date.now();
  const remaining = new Set(jobIds);

  while (remaining.size > 0 && Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { status, body } = await getJobs();
    if (status !== 200 || !Array.isArray(body)) continue;

    const byId = new Map(body.map((j) => [j.id, j]));
    for (const id of [...remaining]) {
      const job = byId.get(id);
      if (!job) continue;
      if (TERMINAL_STATUS.has(job.status)) {
        remaining.delete(id);
      }
    }
    if (remaining.size > 0) {
      log(`Waiting for ${remaining.size} job(s) to finish...`);
    }
  }
  return jobIds.length - remaining.size; // how many finished
}

// ── Download results ─────────────────────────────────────────────────────
async function downloadResults(jobIds) {
  let downloaded = 0;
  for (const id of jobIds) {
    const { status, body } = await getJobResults(id);
    if (status !== 200 || !Array.isArray(body)) continue;

    const valid = body.filter((c) => c.IsValid === true).length;

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outFile = path.join(RESULTS_DIR, `${id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(body, null, 2), "utf-8");

    downloaded++;
    log(`Downloaded ${body.length} results (${valid} valid) for ${id}`);
  }
  return downloaded;
}

// ── Daily session ─────────────────────────────────────────────────────────
let sessionRunning = false;

async function runSession() {
  if (sessionRunning) return;
  sessionRunning = true;

  const state = loadState();
  const basePool = loadKeywords();

  log("=== Starting daily search session (admin API) ===");
  await tgSend("🚀 Datagram: старт дневной сессии поиска");

  let batches = 0;
  let totalJobs = 0;

  try {
    // Login once up front
    await ensureAuth();

    while (true) {
      // Check budget (via public API — admin API doesn't expose it)
      const budget = await getBudget();
      if (budget) {
        const remaining = budget.remaining ?? 0;
        log(`Budget: remaining=${remaining}`);
        if (remaining <= 0) {
          log("Daily token budget exhausted. Ending session.");
          await tgSend("⏹ Datagram: дневной бюджет токенов исчерпан, сессия завершена");
          break;
        }
      }

      // Take next unique batch (snapshot state so we can roll back on failure)
      const cursorBefore = state.cursor;
      const usedBefore = state.usedKeywords.slice();
      const batch = takeNextBatch(state, basePool, BATCH_SIZE);
      if (batch.length === 0) {
        log("No keywords available and generation failed. Ending session.");
        await tgSend("⚠️ Datagram: ключи исчерпаны, генерация не удалась");
        break;
      }

      log(`Submitting batch: ${batch.join(", ")}`);

      // Create one job per keyword
      const createdJobs = [];
      let failed = false;
      for (const kw of batch) {
        const { status, body } = await createJob(kw);
        if (status === 201 && body && body.id) {
          createdJobs.push({ id: body.id, keyword: kw });
        } else if (status === 422 || status === 409) {
          // Concurrent limit — stop creating, wait, retry whole batch
          log(`Concurrent limit (${status}) on "${kw}". Stopping batch creation.`);
          failed = true;
          break;
        } else if (status === 402) {
          log("Budget exhausted (402). Ending session.");
          await tgSend("⏹ Datagram: бюджет исчерпан (402), сессия завершена");
          failed = true;
          break;
        } else {
          log(`Job creation failed (${status}) for "${kw}": ${JSON.stringify(body)}`);
          failed = true;
          break;
        }
      }

      if (createdJobs.length > 0) {
        const ids = createdJobs.map((j) => j.id);
        batches++;
        totalJobs += ids.length;
        log(`Created ${ids.length} job(s) (batch #${batches})`);

        // Record jobs in state
        for (const j of createdJobs) {
          state.tasks.push({
            taskId: j.id,
            keyword: j.keyword,
            createdAt: new Date().toISOString(),
            status: "queued",
          });
        }
        if (state.tasks.length > 5000) state.tasks = state.tasks.slice(-5000);
        state.completed = batches;
        state.lastRun = new Date().toISOString();
        saveState(state);

        await tgSend(`🚀 Datagram: создано ${ids.length} задач (батч #${batches})\nКлючи: ${batch.join(", ")}`);

        // Wait for completion, then download
        const finished = await waitForCompletion(ids);
        const downloaded = await downloadResults(ids);
        log(`Batch #${batches}: ${finished} finished, ${downloaded} downloaded`);
      }

      if (failed) {
        // Roll back cursor/used keywords so the failed batch is retried
        state.cursor = cursorBefore;
        state.usedKeywords = usedBefore;
        saveState(state);
        log(`Rolled back cursor. Waiting ${POLL_INTERVAL_MS}ms before retry...`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
    }
  } catch (err) {
    log(`Session error: ${err.message}`);
    await tgSend(`❌ Datagram: ошибка сессии: ${err.message}`);
  } finally {
    saveState(state);
    sessionRunning = false;
    log(`=== Session finished: ${batches} batches, ${totalJobs} jobs ===`);
    await tgSend(`✅ Datagram: сессия завершена — ${batches} батчей, ${totalJobs} задач`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
function localParts() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return parts;
}

function localDateString() {
  const p = localParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function shouldRunNow() {
  const p = localParts();
  const hour = parseInt(p.hour, 10);
  const minute = parseInt(p.minute, 10);
  return hour === RUN_HOUR && minute >= RUN_MINUTE && minute < RUN_MINUTE + 5;
}

async function schedulerTick() {
  const state = loadState();
  const today = localDateString();

  if (state.lastSessionDate === today) return; // already ran today

  if (shouldRunNow()) {
    state.lastSessionDate = today;
    saveState(state);
    await runSession();
  }
}

async function main() {
  const now = process.argv.includes("--now");

  if (now) {
    await runSession();
    return;
  }

  log(
    `Scheduler running: daily at ${RUN_HOUR}:${RUN_MINUTE} (${TIMEZONE}), batch ${BATCH_SIZE}, maxResults ${MAX_RESULTS}`
  );

  setInterval(async () => {
    try {
      await schedulerTick();
    } catch (err) {
      log(`Scheduler error: ${err.message}`);
    }
  }, 60 * 1000);

  await schedulerTick();
}

main();
