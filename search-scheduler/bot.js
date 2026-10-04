#!/usr/bin/env node
/**
 * Datagram Telegram Bot
 *
 * A long-polling Telegram bot that answers commands and an inline button.
 * Provides live statistics: budget, tasks, results (valid/invalid), keywords.
 *
 * Commands:
 *   /start   — welcome + inline button "📊 Статистика"
 *   /stats   — statistics
 *   Inline button "📊 Статистика" — same as /stats
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env (secrets) if present
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

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

const RESULTS_DIR = path.join(__dirname, config.resultsDir);
const STATE_FILE = path.join(__dirname, config.stateFile);
const STATS_FILE = path.join(__dirname, "stats.json");
const VALID_CHANNELS_FILE = path.join(__dirname, config.validChannelsFile || "./valid-channels.jsonl");
const PUBLIC_BASE = config.apiBaseUrl.replace(/\/+$/, "");

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegramBotToken || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || config.telegramChatId || "";
const API_KEY = process.env.DATAGRAM_API_KEY || config.apiKey || "";

const POLL_TIMEOUT = 30; // long-poll seconds
const ALLOWED_CHAT_ID = String(TG_CHAT_ID);

if (!TG_BOT_TOKEN) {
  console.error("No TELEGRAM_BOT_TOKEN. Set it in .env.");
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Telegram API ──────────────────────────────────────────────────────────
async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) {
    log(`Telegram API error (${method}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function sendMessage(text, keyboard) {
  const payload = {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = keyboard;
  return tg("sendMessage", payload);
}

function statsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Статистика", callback_data: "stats" },
        { text: "🚀 Запустить", callback_data: "run" },
      ],
    ],
  };
}

// ── Statistics ────────────────────────────────────────────────────────────
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

function loadStats() {
  const defaults = {
    totalJobs: 0,
    totalResults: 0,
    totalValid: 0,
    totalChannels: 0,
    totalChats: 0,
    totalUniqueUsernames: 0,
    uniqueUsernames: [],
    sessions: 0,
    batches: [],
    firstRun: null,
    lastRun: null,
  };
  if (fs.existsSync(STATS_FILE)) {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

// Count unique valid channels in the JSONL store (dedup by username).
// Also computes resource-type breakdown and subscriber aggregates.
function scanValidChannels() {
  let total = 0;
  const byType = { channel: 0, group: 0, chat: 0, unknown: 0 };
  const subscribers = { count: 0, sum: 0, max: 0 };
  const topChannels = []; // { username, title, subscribers }

  if (!fs.existsSync(VALID_CHANNELS_FILE)) {
    return { total, byType, subscribers, topChannels };
  }
  const text = fs.readFileSync(VALID_CHANNELS_FILE, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      total++;
      const rt = String(rec.ResourceType || "unknown").toLowerCase();
      byType[byType[rt] !== undefined ? rt : "unknown"]++;

      const sc = Number(rec.SubscriberCount);
      if (Number.isFinite(sc) && sc > 0) {
        subscribers.count++;
        subscribers.sum += sc;
        if (sc > subscribers.max) subscribers.max = sc;
      }
      topChannels.push({
        username: rec.username,
        title: rec.Title,
        subscribers: sc,
      });
    } catch {
      // skip malformed
    }
  }

  // Sort by subscribers desc (unknown/0 go last), keep top 5
  topChannels.sort(
    (a, b) => (b.subscribers || 0) - (a.subscribers || 0)
  );
  return {
    total,
    byType,
    subscribers,
    topChannels: topChannels.slice(0, 5),
  };
}

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

function fmt(n) {
  return typeof n === "number" ? n.toLocaleString("en-US") : String(n);
}

async function buildStatsText() {
  const state = loadState();
  const stats = loadStats();
  const valid = scanValidChannels();
  const budget = await getBudget();

  const lines = [];
  lines.push("<b>📊 Datagram — статистика</b>");
  lines.push("");
  if (budget) {
    const pct = budget.limit ? Math.round((budget.used_today / budget.limit) * 100) : 0;
    lines.push(
      `💰 Токены: <b>${fmt(budget.remaining)}</b> / ${fmt(budget.limit)} (использовано ${fmt(budget.used_today)}, ${pct}%)`
    );
  }
  lines.push("");
  lines.push(`🛠 Задач создано: <b>${fmt(stats.totalJobs)}</b>`);
  lines.push(`🔑 Ключей использовано: <b>${fmt(state.usedKeywords.length)}</b>`);
  lines.push(`📍 Курсор пула: <b>${fmt(state.cursor)}</b>`);
  lines.push(`✅ Сессий: <b>${fmt(stats.sessions)}</b>`);
  if (state.running) {
    lines.push(`🟢 Сейчас выполняется: <b>да</b>`);
  }
  lines.push("");
  lines.push(`📁 Всего записей: <b>${fmt(stats.totalResults)}</b>`);
  lines.push(`✔️ Валидных (всего): <b>${fmt(stats.totalValid)}</b>`);
  lines.push(`⭐ Уникальных валидных: <b>${fmt(valid.total)}</b>`);
  lines.push("");
  lines.push(
    `📺 Каналов: <b>${fmt(valid.byType.channel)}</b> · 👥 Групп: <b>${fmt(valid.byType.group)}</b> · 💬 Чатов: <b>${fmt(valid.byType.chat)}</b>`
  );
  if (valid.subscribers.count > 0) {
    const avg = Math.round(valid.subscribers.sum / valid.subscribers.count);
    lines.push(
      `📈 Подписчики: среднее <b>${fmt(avg)}</b> · максимум <b>${fmt(valid.subscribers.max)}</b>`
    );
  }
  if (valid.topChannels.length > 0) {
    lines.push("");
    lines.push("<b>🏆 Топ каналов:</b>");
    for (const c of valid.topChannels) {
      const t = (c.title || c.username || "").toString().slice(0, 30);
      lines.push(`• ${fmt(c.subscribers)} — ${t}`);
    }
  }
  if (stats.firstRun) {
    lines.push("");
    lines.push(`🕐 Первый запуск: ${stats.firstRun}`);
  }
  if (stats.lastRun) {
    lines.push(`🕐 Последний запуск: ${stats.lastRun}`);
  }
  return lines.join("\n");
}

// ── Command handlers ──────────────────────────────────────────────────────
async function handleStats(chatId) {
  const text = await buildStatsText();
  await sendMessage(text, statsKeyboard());
}

// Manual run: spawns `node index.js --now` as a detached child in this same
// container (shares the mounted volumes). The cross-process lock in index.js
// (state.running) prevents overlap with cron.
let runChild = null;

async function handleRun(chatId) {
  const state = loadState();
  if (state.running) {
    await sendMessage("⏳ Сессия уже выполняется — повторный запуск пропущен.", statsKeyboard());
    return;
  }
  if (runChild && runChild.exitCode === null) {
    await sendMessage("⏳ Запуск уже инициирован, сессия стартует.", statsKeyboard());
    return;
  }

  await sendMessage("🚀 Запускаю сессию поиска вручную...", statsKeyboard());

  try {
    runChild = spawn("node", ["index.js", "--now"], {
      cwd: __dirname,
      detached: true,
      stdio: "ignore",
    });
    runChild.unref();

    // Notify when it exits (best-effort, via polling child exit)
    runChild.on("exit", (code) => {
      log(`Manual run child exited with code ${code}`);
    });
    runChild.on("error", (err) => {
      log(`Manual run spawn error: ${err.message}`);
    });
  } catch (e) {
    log(`Manual run failed: ${e.message}`);
    await sendMessage(`❌ Не удалось запустить: ${e.message}`, statsKeyboard());
  }
}

// ── Update loop ───────────────────────────────────────────────────────────
async function processUpdate(upd) {
  // Callback query (inline button)
  if (upd.callback_query) {
    const cb = upd.callback_query;
    const chatId = cb.message?.chat?.id;
    if (chatId && String(chatId) === ALLOWED_CHAT_ID) {
      if (cb.data === "stats") {
        await handleStats(chatId);
      } else if (cb.data === "run") {
        await handleRun(chatId);
      }
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
    }
    return;
  }

  // Message
  const msg = upd.message || upd.edited_message;
  if (!msg) return;
  const chatId = String(msg.chat?.id);
  if (chatId !== ALLOWED_CHAT_ID) {
    log(`Ignoring message from unauthorized chat ${chatId}`);
    return;
  }

  const text = (msg.text || "").trim();
  if (text === "/start" || text === "/help") {
    await sendMessage(
      "👋 Привет! Я бот статистики Datagram.\n\nНажми кнопку ниже или отправь /stats, чтобы увидеть текущую статистику поиска.",
      statsKeyboard()
    );
  } else if (text === "/stats" || text === "📊 Статистика") {
    await handleStats(chatId);
  } else if (text === "/run" || text === "🚀 Запустить") {
    await handleRun(chatId);
  }
}

async function main() {
  log(`Bot started (chat ${TG_CHAT_ID}). Polling updates...`);
  let offset = 0;

  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?timeout=${POLL_TIMEOUT}&offset=${offset}`,
        { headers: { "Content-Type": "application/json" } }
      );
      const body = await res.json();
      if (!body.ok) {
        log(`getUpdates error: ${JSON.stringify(body)}`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const upd of body.result || []) {
        offset = upd.update_id + 1;
        await processUpdate(upd);
      }
    } catch (e) {
      log(`Polling error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
