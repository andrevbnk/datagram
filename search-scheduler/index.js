#!/usr/bin/env node
/**
 * Datagram Search Scheduler
 *
 * Once a day (default 13:00) runs a search session: creates batches of tasks
 * until the daily token budget is exhausted, auto-downloads results, and sends
 * Telegram notifications. Keywords are never reused; when the pool is exhausted
 * new unique keywords are generated on the fly.
 *
 * Usage:
 *   node index.js            # run the scheduler (waits for the daily time)
 *   node index.js --now      # run a session immediately (for testing)
 *
 * Config lives in config.json. Keywords in keywords.json (array under "keywords").
 * Secrets in .env (never committed).
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

const API_BASE = config.apiBaseUrl.replace(/\/+$/, "");
const API_KEY = process.env.DATAGRAM_API_KEY || config.apiKey || "";
const BATCH_SIZE = config.batchSize; // max 10 per API
const LIMIT_PER_TASK = config.limitPerTask;
const RUN_HOUR = config.runHour ?? 13;
const RUN_MINUTE = config.runMinute ?? 0;
const TIMEZONE = config.timezone || "Europe/Berlin";
const POLL_INTERVAL_MS = (config.pollIntervalSeconds ?? 30) * 1000;
const MAX_WAIT_MS = (config.maxWaitMinutes ?? 20) * 60 * 1000;

// Telegram
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || config.telegramChatId || "";

// Keyword generation modifiers (used when the base pool is exhausted)
const KW_PREFIXES = ["best", "top", "new", "free", "official", "popular", "active", "premium"];
const KW_SUFFIXES = ["group", "community", "chat", "forum", "hub", "network", "club", "channel", "2026", "2025"];

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

async function api(pathname, options = {}) {
  if (!API_KEY) {
    throw new Error("No API key. Set DATAGRAM_API_KEY env var or apiKey in config.json.");
  }
  const url = `${API_BASE}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") || "60", 10);
    log(`Rate limited (429). Waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return api(pathname, options);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

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

// ── Core actions ──────────────────────────────────────────────────────────
async function getAccount() {
  const { status, body } = await api("/me");
  if (status === 200) return body;
  log(`getAccount returned ${status}: ${JSON.stringify(body)}`);
  return null;
}

async function createTask(keywords) {
  const { status, body } = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ keywords, limit: LIMIT_PER_TASK, type: "auto" }),
  });
  return { status, body };
}

async function getTask(taskId) {
  const { status, body } = await api(`/tasks/${taskId}`);
  return { status, body };
}

async function getTaskResults(taskId) {
  const { status, body } = await api(`/tasks/${taskId}/results?format=json`);
  return { status, body };
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

  // First, take from the base pool via cursor (skip already-used)
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

  // If the base pool is exhausted, generate new unique keywords
  if (batch.length < count) {
    const needed = count - batch.length;
    const fresh = generateNewKeywords(basePool, usedSet, needed);
    for (const kw of fresh) {
      batch.push(kw);
      usedSet.add(kw);
    }
  }

  // Record used keywords
  for (const kw of batch) {
    if (!state.usedKeywords.includes(kw)) {
      state.usedKeywords.push(kw);
    }
  }

  return batch;
}

// ── Wait for tasks to finish ──────────────────────────────────────────────
const TERMINAL = new Set([
  "completed",
  "partial_completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
]);

async function waitForCompletion(taskIds) {
  const start = Date.now();
  const remaining = new Set(taskIds);

  while (remaining.size > 0 && Date.now() - start < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    for (const id of [...remaining]) {
      const { status, body } = await getTask(id);
      if (status === 200 && body && TERMINAL.has(body.status)) {
        remaining.delete(id);
      } else if (status === 404) {
        remaining.delete(id); // gone/expired
      }
    }
    if (remaining.size > 0) {
      log(`Waiting for ${remaining.size} task(s) to finish...`);
    }
  }
  return taskIds.length - remaining.size; // how many finished
}

// ── Download results ─────────────────────────────────────────────────────
async function downloadResults(taskIds) {
  let downloaded = 0;
  for (const id of taskIds) {
    const { status, body } = await getTask(id);
    if (status !== 200 || !body || !body.can_download) continue;

    const results = await getTaskResults(id);
    if (results.status !== 200) continue;

    const items = results.body?.items || [];
    const valid = items.filter((c) => c.is_valid).length;

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outFile = path.join(RESULTS_DIR, `${id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(results.body, null, 2), "utf-8");

    downloaded++;
    log(`Downloaded ${items.length} results (${valid} valid) for ${id}`);
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

  log("=== Starting daily search session ===");
  await tgSend("🚀 Datagram: старт дневной сессии поиска");

  let batches = 0;
  let totalTasks = 0;

  try {
    while (true) {
      // Check budget
      const account = await getAccount();
      if (!account) {
        log("Could not read account; aborting session.");
        await tgSend("❌ Datagram: не удалось прочитать аккаунт, сессия прервана");
        break;
      }

      const remaining = account.daily_tokens?.remaining ?? 0;
      log(`Budget: remaining=${remaining}`);

      if (remaining <= 0) {
        log("Daily token budget exhausted. Ending session.");
        await tgSend("⏹ Datagram: дневной бюджет токенов исчерпан, сессия завершена");
        break;
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
      const { status, body } = await createTask(batch);

      const createdTasks = body?.tasks || (body?.task_id ? [body] : []);

      if ((status === 201 || status === 202) && createdTasks.length > 0) {
        const ids = createdTasks.map((t) => t.task_id);
        batches++;
        totalTasks += ids.length;
        log(`Created ${ids.length} task(s) (batch #${batches})`);

        // Record tasks in state
        for (let i = 0; i < createdTasks.length; i++) {
          state.tasks.push({
            taskId: createdTasks[i].task_id,
            keyword: batch[i] ?? null,
            createdAt: new Date().toISOString(),
            status: createdTasks[i].status,
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
      } else if (status === 402) {
        log("Budget exhausted (402). Ending session.");
        await tgSend("⏹ Datagram: бюджет исчерпан (402), сессия завершена");
        break;
      } else if (status === 422 || status === 409) {
        // Concurrent limit reached — roll back cursor/used keywords and retry
        state.cursor = cursorBefore;
        state.usedKeywords = usedBefore;
        log(`Concurrent limit (${status}). Waiting ${POLL_INTERVAL_MS}ms...`);
        await tgSend(`⏳ Datagram: лимит одновременных задач, жду (${status})`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      } else {
        log(`Task creation failed (${status}): ${JSON.stringify(body)}`);
        await tgSend(`❌ Datagram: ошибка создания задач (${status}): ${JSON.stringify(body)}`);
        break;
      }
    }
  } catch (err) {
    log(`Session error: ${err.message}`);
    await tgSend(`❌ Datagram: ошибка сессии: ${err.message}`);
  } finally {
    saveState(state);
    sessionRunning = false;
    log(`=== Session finished: ${batches} batches, ${totalTasks} tasks ===`);
    await tgSend(`✅ Datagram: сессия завершена — ${batches} батчей, ${totalTasks} задач`);
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
    `Scheduler running: daily at ${RUN_HOUR}:${RUN_MINUTE} (${TIMEZONE}), batch ${BATCH_SIZE}, limit ${LIMIT_PER_TASK}`
  );

  // Check every minute
  setInterval(async () => {
    try {
      await schedulerTick();
    } catch (err) {
      log(`Scheduler error: ${err.message}`);
    }
  }, 60 * 1000);

  // Also run an immediate tick in case we're already past the time
  await schedulerTick();
}

main();
