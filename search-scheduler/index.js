#!/usr/bin/env node
/**
 * Datagram Search Scheduler
 *
 * Rotates through a large pool of keywords, creating (and re-creating)
 * Datagram search tasks on a schedule. Each run takes the next batch of
 * keywords from the pool, submits a task, and records progress in state.json
 * so the next run continues where the last one left off.
 *
 * Usage:
 *   node index.js            # run once, then schedule the next run
 *   node index.js --once     # run a single batch and exit (no re-schedule)
 *
 * Config lives in config.json. Keywords in keywords.json (array under "keywords").
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const INTERVAL_MS = config.intervalMinutes * 60 * 1000;

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

async function getTaskResults(taskId) {
  const { status, body } = await api(`/tasks/${taskId}/results?format=json`);
  return { status, body };
}

// ── Main run ─────────────────────────────────────────────────────────────
async function runOnce() {
  const keywords = loadKeywords();
  const state = loadState();

  log(
    `Pool: ${keywords.length} keywords | cursor at ${state.cursor} | completed ${state.completed}`
  );

  // Check account limits before submitting
  const account = await getAccount();
  if (account) {
    const remaining = account.daily_tokens?.remaining;
    const active = account.concurrent?.active;
    const limit = account.concurrent?.limit;
    log(
      `Account: plan=${account.plan} tokens_remaining=${remaining} concurrent=${active}/${limit}`
    );
    if (remaining !== undefined && remaining <= 0) {
      log("Daily token budget exhausted. Skipping this run.");
      return;
    }
    if (active !== undefined && limit !== undefined && active >= limit) {
      log("Concurrent task limit reached. Skipping this run.");
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

  if (status === 201) {
    const taskId = body.task_id;
    log(`Task created: ${taskId} (status=${body.status})`);

    state.cursor = (state.cursor + BATCH_SIZE) % keywords.length;
    state.completed += 1;
    state.lastRun = new Date().toISOString();
    state.tasks.push({
      taskId,
      keywords: batch,
      createdAt: new Date().toISOString(),
      status: body.status,
    });
    // Keep only the last 500 task records
    if (state.tasks.length > 500) {
      state.tasks = state.tasks.slice(-500);
    }
    saveState(state);
  } else {
    log(
      `Task creation failed (${status}): ${JSON.stringify(body)}`
    );
  }
}

async function main() {
  const once = process.argv.includes("--once");

  try {
    await runOnce();
  } catch (err) {
    log(`Error: ${err.message}`);
  }

  if (!once) {
    log(`Next run in ${config.intervalMinutes} minutes.`);
    setTimeout(main, INTERVAL_MS);
  }
}

main();
