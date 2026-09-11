#!/usr/bin/env node
/**
 * Datagram Search Scheduler
 *
 * Rotates through a large pool of keywords, creating Datagram search tasks on
 * a fast schedule, auto-downloading results when tasks complete, and sending
 * Telegram notifications.
 *
 * Usage:
 *   node index.js            # run the scheduler loop (create + poll + notify)
 *   node index.js --once     # run a single create batch and exit
 *
 * Config lives in config.json. Keywords in keywords.json (array under "keywords").
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
const CREATE_INTERVAL_MS = config.createIntervalMinutes * 60 * 1000;
const POLL_INTERVAL_MS = config.pollIntervalSeconds * 1000;

// Telegram
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || config.telegramChatId || "";

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
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return { cursor: 0, completed: 0, tasks: [], lastRun: null };
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
    throw new Error(
      "No API key. Set DATAGRAM_API_KEY env var or apiKey in config.json."
    );
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

  // Respect Retry-After on rate limit
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
    body: JSON.stringify({
      keywords,
      limit: LIMIT_PER_TASK,
      type: "auto",
    }),
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

// ── Create batch ──────────────────────────────────────────────────────────
async function createBatch() {
  const keywords = loadKeywords();
  const state = loadState();

  log(
    `Pool: ${keywords.length} keywords | cursor at ${state.cursor} | completed ${state.completed}`
  );

  // Check account limits before submitting
  const account = await getAccount();
  if (account) {
    const remaining = account.daily_tokens?.remaining;
    const limit = account.concurrent?.limit;
    log(
      `Account: plan=${account.plan} tokens_remaining=${remaining} concurrent_limit=${limit}`
    );
    if (remaining !== undefined && remaining <= 0) {
      log("Daily token budget exhausted. Skipping this run.");
      await tgSend("⚠️ Datagram: дневной бюджет токенов исчерпан.");
      return;
    }
  }

  // Take the next batch (wrap around the pool)
  const batch = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const idx = (state.cursor + i) % keywords.length;
    batch.push(keywords[idx]);
  }

  log(`Submitting task with ${batch.length} keywords: ${batch.join(", ")}`);

  const { status, body } = await createTask(batch);

  // Real API returns 202 with { tasks: [{task_id, status}, ...] } — one task
  // per keyword. The spec's 201/{task_id} shape is not what the live API sends.
  const createdTasks = body?.tasks || (body?.task_id ? [body] : []);

  if ((status === 201 || status === 202) && createdTasks.length > 0) {
    log(
      `Created ${createdTasks.length} task(s): ` +
        createdTasks.map((t) => `${t.task_id} (${t.status})`).join(", ")
    );

    state.cursor = (state.cursor + BATCH_SIZE) % keywords.length;
    state.completed += 1;
    state.lastRun = new Date().toISOString();
    for (let i = 0; i < createdTasks.length; i++) {
      const t = createdTasks[i];
      state.tasks.push({
        taskId: t.task_id,
        keyword: batch[i] ?? null,
        createdAt: new Date().toISOString(),
        status: t.status,
        resultsDownloaded: false,
      });
    }
    // Keep only the last 2000 task records
    if (state.tasks.length > 2000) {
      state.tasks = state.tasks.slice(-2000);
    }
    saveState(state);

    await tgSend(
      `🚀 Datagram: создано ${createdTasks.length} задач\n` +
        `Ключи: ${batch.join(", ")}`
    );
  } else {
    log(`Task creation failed (${status}): ${JSON.stringify(body)}`);
    await tgSend(`❌ Datagram: ошибка создания задач (${status}): ${JSON.stringify(body)}`);
  }
}

// ── Poll & download results ───────────────────────────────────────────────
async function pollAndDownload() {
  const state = loadState();

  // Only look at tasks that are not yet downloaded and not terminal-failed
  const pending = state.tasks.filter(
    (t) => !t.resultsDownloaded && t.status !== "failed" && t.status !== "cancelled"
  );

  if (pending.length === 0) return;

  // Limit how many we poll per cycle to stay under rate limits
  const toPoll = pending.slice(0, 20);

  for (const t of toPoll) {
    const { status, body } = await getTask(t.taskId);

    if (status !== 200) {
      // 404 = task gone/expired; mark as failed to stop polling
      if (status === 404) {
        t.status = "failed";
        t.error = "not_found";
      }
      continue;
    }

    t.status = body.status;

    const isDone =
      body.status === "completed" ||
      body.status === "partial_completed" ||
      body.status === "completed_with_warnings";

    if (isDone && body.can_download) {
      const results = await getTaskResults(t.taskId);
      if (results.status === 200) {
        const items = results.body?.items || [];
        const valid = items.filter((c) => c.is_valid).length;

        // Save to results/<taskId>.json
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        const outFile = path.join(RESULTS_DIR, `${t.taskId}.json`);
        fs.writeFileSync(
          outFile,
          JSON.stringify(results.body, null, 2),
          "utf-8"
        );

        t.resultsDownloaded = true;
        t.resultsCount = items.length;
        t.validCount = valid;

        log(
          `Downloaded ${items.length} results (${valid} valid) for ${t.taskId} (${t.keyword})`
        );
        await tgSend(
          `✅ Datagram: задача "${t.keyword}" завершена\n` +
            `Найдено: ${items.length} каналов (валидных: ${valid})`
        );
      }
    }
  }

  saveState(state);
}

// ── Main loop ─────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes("--once");

  if (once) {
    await createBatch();
    return;
  }

  // Run create immediately, then on interval
  await createBatch();

  // Poll loop runs more frequently than create loop
  setInterval(async () => {
    try {
      await pollAndDownload();
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  setInterval(async () => {
    try {
      await createBatch();
    } catch (err) {
      log(`Create error: ${err.message}`);
    }
  }, CREATE_INTERVAL_MS);

  log(
    `Scheduler running: create every ${config.createIntervalMinutes}m, poll every ${config.pollIntervalSeconds}s`
  );
}

main();
