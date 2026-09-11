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
    inline_keyboard: [[{ text: "📊 Статистика", callback_data: "stats" }]],
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

function scanResults() {
  let files = 0;
  let totalItems = 0;
  let validItems = 0;
  let channels = 0;
  let groups = 0;
  const subscribers = { count: 0, sum: 0 };

  if (!fs.existsSync(RESULTS_DIR)) {
    return { files, totalItems, validItems, channels, groups, subscribers };
  }

  for (const f of fs.readdirSync(RESULTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    files++;
    try {
      const items = JSON.parse(
        fs.readFileSync(path.join(RESULTS_DIR, f), "utf-8")
      );
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        totalItems++;
        if (it.IsValid === true) validItems++;
        const rt = (it.ResourceType || "").toLowerCase();
        if (rt === "channel") channels++;
        else if (rt === "group" || rt === "chat") groups++;
        const sc = Number(it.SubscriberCount);
        if (Number.isFinite(sc) && sc > 0) {
          subscribers.count++;
          subscribers.sum += sc;
        }
      }
    } catch {
      // skip unreadable
    }
  }
  return { files, totalItems, validItems, channels, groups, subscribers };
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
  const r = scanResults();
  const budget = await getBudget();

  const lines = [];
  lines.push("<b>📊 Datagram — статистика</b>");
  lines.push("");
  if (budget) {
    lines.push(
      `💰 Токены: <b>${fmt(budget.remaining)}</b> / ${fmt(budget.limit)} (использовано ${fmt(budget.used_today)})`
    );
  }
  lines.push(`🛠 Задач создано: <b>${fmt(state.tasks.length)}</b>`);
  lines.push(`🔑 Ключей использовано: <b>${fmt(state.usedKeywords.length)}</b>`);
  lines.push(`📍 Курсор пула: <b>${fmt(state.cursor)}</b>`);
  lines.push(`✅ Батчей (сессий): <b>${fmt(state.completed)}</b>`);
  lines.push("");
  lines.push(`📁 Файлов результатов: <b>${fmt(r.files)}</b>`);
  lines.push(`👥 Всего записей: <b>${fmt(r.totalItems)}</b>`);
  lines.push(`✔️ Валидных: <b>${fmt(r.validItems)}</b>`);
  lines.push(
    `📺 Каналы: <b>${fmt(r.channels)}</b> · 👥 Группы/чаты: <b>${fmt(r.groups)}</b>`
  );
  if (r.subscribers.count > 0) {
    const avg = Math.round(r.subscribers.sum / r.subscribers.count);
    lines.push(
      `📈 Подписчики: среднее <b>${fmt(avg)}</b> (по ${fmt(r.subscribers.count)} каналам)`
    );
  }
  if (state.lastRun) {
    lines.push("");
    lines.push(`🕐 Последний запуск: ${state.lastRun}`);
  }
  return lines.join("\n");
}

// ── Command handlers ──────────────────────────────────────────────────────
async function handleStats(chatId) {
  const text = await buildStatsText();
  await sendMessage(text, statsKeyboard());
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
        await tg("answerCallbackQuery", { callback_query_id: cb.id });
      }
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
