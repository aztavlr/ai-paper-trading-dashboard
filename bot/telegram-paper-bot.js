#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

loadEnv(path.join(__dirname, ".env"));

const CFG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  allowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID || "",
  alpacaKey: process.env.ALPACA_API_KEY_ID || "",
  alpacaSecret: process.env.ALPACA_API_SECRET_KEY || "",
  pollMs: num(process.env.POLL_INTERVAL_MS, 2500),
  tradeMs: num(process.env.TRADE_INTERVAL_MS, 60000),
  riskPct: num(process.env.RISK_PER_TRADE_PCT, 1),
  stopPct: num(process.env.STOP_LOSS_PCT, 2),
  takeProfitPct: num(process.env.TAKE_PROFIT_PCT, 4),
  maxPositions: Math.max(1, Math.floor(num(process.env.MAX_OPEN_POSITIONS, 3))),
  maxDailyLossPct: num(process.env.MAX_DAILY_LOSS_PCT, 3),
  watchlist: (process.env.WATCHLIST || "AAPL,TSLA,NVDA,MSFT,SPY").split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
};

const TELEGRAM_API = `https://api.telegram.org/bot${CFG.telegramToken}`;
const ALPACA_PAPER_API = "https://paper-api.alpaca.markets";
const ALPACA_DATA_API = "https://data.alpaca.markets";

let offset = 0;
let tradingEnabled = false;
let lastTradeAt = 0;
let bootSent = false;
const prices = new Map();
const cooldowns = new Map();

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  validateConfig();
  console.log("Telegram paper bot starting. Paper trading only.");
  console.log(`Watchlist: ${CFG.watchlist.join(", ")}`);
  if (CFG.allowedChatId) await sendMessage(`Paper trading command bot is online.\n\n${helpText()}`);
  setInterval(pollTelegram, CFG.pollMs);
  setInterval(tradeLoop, CFG.tradeMs);
  await pollTelegram();
}

function validateConfig() {
  const missing = [];
  if (!CFG.telegramToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!CFG.allowedChatId) missing.push("TELEGRAM_ALLOWED_CHAT_ID");
  if (!CFG.alpacaKey) missing.push("ALPACA_API_KEY_ID");
  if (!CFG.alpacaSecret) missing.push("ALPACA_API_SECRET_KEY");
  if (missing.length) {
    throw new Error(`Missing required .env values: ${missing.join(", ")}`);
  }
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const idx = clean.indexOf("=");
    if (idx === -1) continue;
    const key = clean.slice(0, idx).trim();
    let value = clean.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function pollTelegram() {
  try {
    const data = await tg("getUpdates", {
      offset,
      timeout: 20,
      allowed_updates: ["message"]
    });
    for (const update of data.result || []) {
      offset = Math.max(offset, update.update_id + 1);
      const msg = update.message;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      if (chatId !== String(CFG.allowedChatId)) {
        await sendMessage("Unauthorized chat. This bot is locked to its owner.", chatId);
        continue;
      }
      await handleCommand(msg.text.trim());
    }
  } catch (err) {
    console.error("Telegram poll failed:", err.message);
  }
}

async function handleCommand(text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.toLowerCase();
  if (cmd === "/start" || cmd === "/help") return sendMessage(helpText());
  if (cmd === "/start_trading" || cmd === "/starttrading" || cmd === "/auto_on") {
    tradingEnabled = true;
    await sendMessage("Paper auto-trading is ON. I will look for long-only setups on the watchlist.");
    return tradeLoop(true);
  }
  if (cmd === "/stop_trading" || cmd === "/stoptrading" || cmd === "/auto_off") {
    tradingEnabled = false;
    return sendMessage("Paper auto-trading is OFF. Existing paper positions are left alone. Use /close_all to close them.");
  }
  if (cmd === "/scan_now") return tradeLoop(true);
  if (cmd === "/paper_buy" || cmd === "/buy") return manualPaperBuy(rest[0]);
  if (cmd === "/status") return sendMessage(await statusText());
  if (cmd === "/positions") return sendMessage(await positionsText());
  if (cmd === "/close_all") return closeAllPositions();
  if (cmd === "/watch") return updateWatchlist(rest);
  if (cmd === "/risk") return updateRisk(rest[0]);
  if (cmd === "/test") {
    await fetchAccount();
    return sendMessage("Alpaca Paper API connection works.");
  }
  return sendMessage(`Unknown command.\n\n${helpText()}`);
}

function helpText() {
  return [
    "Commands:",
    "/start_trading or /auto_on - turn paper auto-trading on",
    "/stop_trading or /auto_off - stop opening new paper trades",
    "/scan_now - check the watchlist right now",
    "/paper_buy AAPL - manually open a risk-sized paper bracket buy",
    "/status - show bot/account status",
    "/positions - list open paper positions",
    "/close_all - close all open paper positions",
    "/watch AAPL TSLA SPY - replace watchlist",
    "/risk 1 - set risk per trade percent",
    "/test - test Alpaca Paper API"
  ].join("\n");
}

function updateWatchlist(symbols) {
  const next = symbols.map(s => s.toUpperCase().replace(/[^A-Z.]/g, "")).filter(Boolean).slice(0, 12);
  if (!next.length) return sendMessage(`Current watchlist: ${CFG.watchlist.join(", ")}`);
  CFG.watchlist = next;
  prices.clear();
  return sendMessage(`Watchlist updated: ${CFG.watchlist.join(", ")}`);
}

function updateRisk(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return sendMessage("Use /risk with a value from 0.1 to 5. Example: /risk 1");
  CFG.riskPct = n;
  return sendMessage(`Risk per paper trade set to ${CFG.riskPct}%.`);
}

async function tradeLoop(notifyNoTrade = false) {
  if (!tradingEnabled && !notifyNoTrade) return;
  try {
    const account = await fetchAccount();
    const equity = Number(account.equity || account.portfolio_value || 0);
    const dailyLoss = Number(account.equity || 0) - Number(account.last_equity || account.equity || 0);
    const maxDailyLoss = equity * CFG.maxDailyLossPct / 100;
    if (dailyLoss <= -maxDailyLoss) {
      tradingEnabled = false;
      await sendMessage(`Daily loss guard triggered (${money(dailyLoss)}). Auto-trading stopped.`);
      return;
    }

    const open = await fetchPositions();
    if (open.length >= CFG.maxPositions) {
      if (notifyNoTrade) await sendMessage(`Risk guard: max open positions reached (${open.length}/${CFG.maxPositions}).`);
      return;
    }

    const snapshots = await fetchSnapshots(CFG.watchlist);
    const summary = { scanned: 0, warmup: 0, hold: 0, blocked: 0, noPrice: 0, submitted: 0 };
    for (const symbol of CFG.watchlist) {
      summary.scanned++;
      const currentPositions = await fetchPositions();
      if (currentPositions.length >= CFG.maxPositions) break;
      if (currentPositions.some(p => p.symbol === symbol)) { summary.blocked++; continue; }
      if ((cooldowns.get(symbol) || 0) > Date.now()) { summary.blocked++; continue; }
      const price = snapshotPrice(snapshots[symbol]);
      if (!price) { summary.noPrice++; continue; }
      pushHistory(symbol, price);
      const signal = getSignal(symbol);
      if (signal === "WARMUP") { summary.warmup++; continue; }
      if (signal !== "BUY") { summary.hold++; continue; }
      if (!tradingEnabled) { summary.blocked++; continue; }
      const qty = positionSize(equity, price);
      if (qty < 1) { summary.blocked++; continue; }
      const order = await submitBracketBuy(symbol, qty, price);
      lastTradeAt = Date.now();
      cooldowns.set(symbol, Date.now() + CFG.tradeMs * 3);
      summary.submitted++;
      await sendMessage(`Paper BUY submitted: ${symbol}\nQty: ${qty}\nEntry ref: ${money(price)}\nStop: ${money(price * (1 - CFG.stopPct / 100))}\nTarget: ${money(price * (1 + CFG.takeProfitPct / 100))}\nOrder: ${order.id || "submitted"}`);
    }
    if (notifyNoTrade && summary.submitted === 0) {
      await sendMessage([
        tradingEnabled ? "Scan complete. No paper orders opened." : "Scan complete. Auto-trading is OFF, so no paper orders were opened.",
        `Scanned: ${summary.scanned}`,
        `Warmup: ${summary.warmup}`,
        `Hold: ${summary.hold}`,
        `Blocked: ${summary.blocked}`,
        `No price: ${summary.noPrice}`
      ].join("\n"));
    }
  } catch (err) {
    console.error("Trade loop failed:", err.message);
    await sendMessage(`Trade loop warning: ${err.message}`);
  }
}

async function manualPaperBuy(rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return sendMessage("Usage: /paper_buy AAPL");
  const account = await fetchAccount();
  const equity = Number(account.equity || account.portfolio_value || 0);
  const dailyLoss = Number(account.equity || 0) - Number(account.last_equity || account.equity || 0);
  const maxDailyLoss = equity * CFG.maxDailyLossPct / 100;
  if (dailyLoss <= -maxDailyLoss) {
    tradingEnabled = false;
    return sendMessage(`Risk guard blocked ${symbol}: daily loss limit hit (${money(dailyLoss)}).`);
  }

  const open = await fetchPositions();
  if (open.length >= CFG.maxPositions) return sendMessage(`Risk guard blocked ${symbol}: max positions reached (${open.length}/${CFG.maxPositions}).`);
  if (open.some(p => p.symbol === symbol)) return sendMessage(`Risk guard blocked ${symbol}: position already open.`);
  if ((cooldowns.get(symbol) || 0) > Date.now()) return sendMessage(`Risk guard blocked ${symbol}: cooldown is active.`);

  const snapshots = await fetchSnapshots([symbol]);
  const price = snapshotPrice(snapshots[symbol]);
  if (!price) return sendMessage(`Could not get an Alpaca paper market price for ${symbol}. This bot currently supports Alpaca stock/ETF symbols.`);
  const qty = positionSize(equity, price);
  if (qty < 1) return sendMessage(`Risk sizing blocked ${symbol}: account equity/risk settings produce quantity below 1 share.`);

  const order = await submitBracketBuy(symbol, qty, price);
  lastTradeAt = Date.now();
  cooldowns.set(symbol, Date.now() + CFG.tradeMs * 3);
  return sendMessage(`Manual paper BUY submitted: ${symbol}\nQty: ${qty}\nEntry ref: ${money(price)}\nStop: ${money(price * (1 - CFG.stopPct / 100))}\nTarget: ${money(price * (1 + CFG.takeProfitPct / 100))}\nOrder: ${order.id || "submitted"}`);
}

function normalizeSymbol(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 12);
}

function pushHistory(symbol, price) {
  const h = prices.get(symbol) || [];
  h.push(price);
  while (h.length > 60) h.shift();
  prices.set(symbol, h);
}

function getSignal(symbol) {
  const h = prices.get(symbol) || [];
  if (h.length < 20) return "WARMUP";
  const rsi = calcRSI(h);
  const sma8 = sma(h, 8);
  const sma20 = sma(h, 20);
  return rsi < 38 && sma8 > sma20 ? "BUY" : "HOLD";
}

function positionSize(equity, price) {
  const riskDollars = equity * CFG.riskPct / 100;
  const riskPerShare = price * CFG.stopPct / 100;
  return Math.max(0, Math.floor(riskDollars / riskPerShare));
}

function calcRSI(values, period = 14) {
  if (values.length < period + 1) return 50;
  const slice = values.slice(-period - 1);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const change = slice[i] - slice[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

async function statusText() {
  const account = await fetchAccount();
  const positions = await fetchPositions();
  return [
    `Paper auto-trading: ${tradingEnabled ? "ON" : "OFF"}`,
    `Equity: ${money(Number(account.equity || 0))}`,
    `Buying power: ${money(Number(account.buying_power || 0))}`,
    `Open positions: ${positions.length}/${CFG.maxPositions}`,
    `Watchlist: ${CFG.watchlist.join(", ")}`,
    `Risk/trade: ${CFG.riskPct}%`,
    `Last trade: ${lastTradeAt ? new Date(lastTradeAt).toLocaleString() : "none"}`
  ].join("\n");
}

async function positionsText() {
  const positions = await fetchPositions();
  if (!positions.length) return "No open paper positions.";
  return positions.map(p => {
    const pnl = Number(p.unrealized_pl || 0);
    return `${p.symbol}: ${p.qty} @ ${money(Number(p.avg_entry_price || 0))} | P&L ${money(pnl)}`;
  }).join("\n");
}

async function closeAllPositions() {
  const positions = await fetchPositions();
  if (!positions.length) return sendMessage("No open paper positions to close.");
  await alpaca("/v2/positions", { method: "DELETE" });
  tradingEnabled = false;
  return sendMessage("Close-all request sent. Auto-trading is now OFF.");
}

async function submitBracketBuy(symbol, qty, price) {
  const body = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: roundPrice(price * (1 + CFG.takeProfitPct / 100)) },
    stop_loss: { stop_price: roundPrice(price * (1 - CFG.stopPct / 100)) }
  };
  return alpaca("/v2/orders", { method: "POST", body });
}

function roundPrice(value) {
  return Number(value >= 1 ? value.toFixed(2) : value.toFixed(4));
}

async function fetchAccount() {
  return alpaca("/v2/account");
}

async function fetchPositions() {
  return alpaca("/v2/positions");
}

async function fetchSnapshots(symbols) {
  const qs = encodeURIComponent(symbols.join(","));
  const data = await alpacaData(`/v2/stocks/snapshots?symbols=${qs}&feed=iex`);
  return data.snapshots || data;
}

function snapshotPrice(snapshot) {
  return Number(snapshot?.latestTrade?.p ?? snapshot?.latestQuote?.ap ?? snapshot?.latestQuote?.bp ?? snapshot?.minuteBar?.c ?? 0);
}

async function alpaca(pathname, options = {}) {
  return request(`${ALPACA_PAPER_API}${pathname}`, {
    ...options,
    headers: alpacaHeaders()
  });
}

async function alpacaData(pathname) {
  return request(`${ALPACA_DATA_API}${pathname}`, {
    headers: alpacaHeaders()
  });
}

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID": CFG.alpacaKey,
    "APCA-API-SECRET-KEY": CFG.alpacaSecret,
    "content-type": "application/json"
  };
}

async function tg(method, body) {
  return request(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
}

async function sendMessage(text, chatId = CFG.allowedChatId) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function request(url, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: options.headers || {}
  };
  if (options.body) init.body = JSON.stringify(options.body);
  const res = await fetch(url, init);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok || data.ok === false) {
    const message = data.message || data.error || data.description || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00";
}
