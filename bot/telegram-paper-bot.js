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
  minConfidence: num(process.env.MIN_CONFIDENCE, 72),
  timeframe: process.env.BAR_TIMEFRAME || "5Min",
  atrStopMultiplier: num(process.env.ATR_STOP_MULTIPLIER, 1.5),
  takeProfitR: num(process.env.TAKE_PROFIT_R_MULTIPLIER, 2),
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
  if (cmd === "/explain") return explainSymbol(rest[0]);
  if (cmd === "/strategy") return sendMessage(strategyText());
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
    "/explain AAPL - show the candle/indicator readout",
    "/strategy - show current strategy settings",
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

    const summary = { scanned: 0, warmup: 0, hold: 0, lowConfidence: 0, blocked: 0, noPrice: 0, submitted: 0 };
    for (const symbol of CFG.watchlist) {
      summary.scanned++;
      const currentPositions = await fetchPositions();
      if (currentPositions.length >= CFG.maxPositions) break;
      if (currentPositions.some(p => p.symbol === symbol)) { summary.blocked++; continue; }
      if ((cooldowns.get(symbol) || 0) > Date.now()) { summary.blocked++; continue; }
      const bars = await fetchBars(symbol, CFG.timeframe, 160);
      const analysis = analyzeBars(bars);
      if (!analysis.price) { summary.noPrice++; continue; }
      if (analysis.action === "WARMUP") { summary.warmup++; continue; }
      if (analysis.action !== "BUY") { summary.hold++; continue; }
      if (analysis.confidence < CFG.minConfidence) { summary.lowConfidence++; continue; }
      if (!tradingEnabled) { summary.blocked++; continue; }
      const qty = positionSize(equity, analysis.price, analysis.stop);
      if (qty < 1) { summary.blocked++; continue; }
      const order = await submitBracketBuy(symbol, qty, analysis.price, analysis);
      lastTradeAt = Date.now();
      cooldowns.set(symbol, Date.now() + CFG.tradeMs * 3);
      summary.submitted++;
      await sendMessage(`Paper BUY submitted: ${symbol}\nConfidence: ${analysis.confidence}%\nQty: ${qty}\nEntry ref: ${money(analysis.price)}\nStop: ${money(analysis.stop)}\nTarget: ${money(analysis.target)}\nWhy: ${analysis.reasons.slice(0, 4).join("; ")}\nOrder: ${order.id || "submitted"}`);
    }
    if (notifyNoTrade && summary.submitted === 0) {
      await sendMessage([
        tradingEnabled ? "Scan complete. No paper orders opened." : "Scan complete. Auto-trading is OFF, so no paper orders were opened.",
        `Scanned: ${summary.scanned}`,
        `Warmup: ${summary.warmup}`,
        `Hold: ${summary.hold}`,
        `Low confidence: ${summary.lowConfidence}`,
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

  const bars = await fetchBars(symbol, CFG.timeframe, 160);
  const analysis = analyzeBars(bars);
  if (!analysis.price) return sendMessage(`Could not get Alpaca candle data for ${symbol}. This bot currently supports Alpaca stock/ETF symbols.`);
  const qty = positionSize(equity, analysis.price, analysis.stop);
  if (qty < 1) return sendMessage(`Risk sizing blocked ${symbol}: account equity/risk settings produce quantity below 1 share.`);

  const order = await submitBracketBuy(symbol, qty, analysis.price, analysis);
  lastTradeAt = Date.now();
  cooldowns.set(symbol, Date.now() + CFG.tradeMs * 3);
  return sendMessage(`Manual paper BUY submitted: ${symbol}\nConfidence: ${analysis.confidence}%\nQty: ${qty}\nEntry ref: ${money(analysis.price)}\nStop: ${money(analysis.stop)}\nTarget: ${money(analysis.target)}\nWhy: ${analysis.reasons.slice(0, 4).join("; ")}\nOrder: ${order.id || "submitted"}`);
}

function normalizeSymbol(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 12);
}

function positionSize(equity, price, stopPrice = null) {
  const riskDollars = equity * CFG.riskPct / 100;
  const riskPerShare = stopPrice ? Math.abs(price - stopPrice) : price * CFG.stopPct / 100;
  return Math.max(0, Math.floor(riskDollars / riskPerShare));
}

async function explainSymbol(rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return sendMessage("Usage: /explain AAPL");
  const bars = await fetchBars(symbol, CFG.timeframe, 160);
  const a = analyzeBars(bars);
  if (!a.price) return sendMessage(`No candle data available for ${symbol}.`);
  return sendMessage([
    `${symbol} advanced readout (${CFG.timeframe})`,
    `Action: ${a.action}`,
    `Confidence: ${a.confidence}% / required ${CFG.minConfidence}%`,
    `Price: ${money(a.price)}`,
    `RSI: ${a.rsi.toFixed(1)} | MACD hist: ${a.macdHist.toFixed(3)}`,
    `Trend: ${a.trend}`,
    `ATR: ${money(a.atr)} | Stop: ${money(a.stop)} | Target: ${money(a.target)}`,
    `Pattern: ${a.pattern || "none"}`,
    `Why: ${a.reasons.join("; ")}`
  ].join("\n"));
}

function strategyText() {
  return [
    "Advanced paper strategy:",
    `Timeframe: ${CFG.timeframe}`,
    `Minimum confidence: ${CFG.minConfidence}%`,
    `Risk per trade: ${CFG.riskPct}%`,
    `ATR stop multiplier: ${CFG.atrStopMultiplier}x`,
    `Take profit: ${CFG.takeProfitR}R`,
    "Reads: EMA trend, RSI, MACD, Bollinger position, VWAP, volume, ATR volatility, support/resistance, and candlestick patterns.",
    "Still educational paper trading only. No method is 100% accurate."
  ].join("\n");
}

function analyzeBars(bars) {
  if (!Array.isArray(bars) || bars.length < 60) {
    return { action: "WARMUP", confidence: 0, price: latestBarPrice(bars), reasons: ["Need at least 60 candles"] };
  }
  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const volumes = bars.map(b => b.v);
  const price = closes[closes.length - 1];
  const ema9v = last(emaSeries(closes, 9));
  const ema21v = last(emaSeries(closes, 21));
  const ema50v = last(emaSeries(closes, 50));
  const rsi = calcRSI(closes);
  const macdData = calcMACD(closes);
  const atrValue = calcATR(bars, 14);
  const bb = calcBollinger(closes, 20);
  const vwap = calcVWAP(bars.slice(-40));
  const avgVol = sma(volumes.slice(-21, -1), 20) || 0;
  const volRatio = avgVol ? last(volumes) / avgVol : 1;
  const recentHigh = Math.max(...highs.slice(-30, -1));
  const recentLow = Math.min(...lows.slice(-30, -1));
  const pattern = candlePattern(bars);

  let score = 50;
  const reasons = [];
  const trendUp = ema9v > ema21v && ema21v > ema50v;
  const trendDown = ema9v < ema21v && ema21v < ema50v;
  if (trendUp) { score += 16; reasons.push("EMA trend up"); }
  else if (trendDown) { score -= 18; reasons.push("EMA trend down"); }
  else reasons.push("Mixed EMA trend");

  if (price > vwap) { score += 7; reasons.push("Price above VWAP"); }
  else { score -= 5; reasons.push("Price below VWAP"); }
  if (rsi >= 42 && rsi <= 62) { score += 8; reasons.push("RSI healthy"); }
  else if (rsi < 35) { score += 5; reasons.push("RSI oversold bounce candidate"); }
  else if (rsi > 72) { score -= 12; reasons.push("RSI overbought"); }
  if (macdData.hist > 0 && macdData.hist > macdData.prevHist) { score += 12; reasons.push("MACD improving"); }
  else if (macdData.hist < 0 && macdData.hist < macdData.prevHist) { score -= 12; reasons.push("MACD weakening"); }
  if (bb.widthPct > 0.6 && bb.widthPct < 8) { score += 4; reasons.push("Volatility usable"); }
  else if (bb.widthPct >= 8) { score -= 8; reasons.push("Volatility elevated"); }
  if (price > bb.upper) { score -= 8; reasons.push("Extended above Bollinger band"); }
  if (price < bb.lower) { score += 5; reasons.push("Below lower Bollinger band"); }
  if (volRatio >= 1.15) { score += 7; reasons.push("Volume confirmation"); }
  if (price > recentHigh) { score += 9; reasons.push("Breakout above recent high"); }
  if (price < recentLow) { score -= 10; reasons.push("Breakdown below recent low"); }
  if (pattern?.bullish) { score += pattern.weight; reasons.push(pattern.name); }
  if (pattern?.bearish) { score -= pattern.weight; reasons.push(pattern.name); }

  const confidence = clamp(Math.round(score), 1, 96);
  const stopDistance = Math.max((atrValue || 0) * CFG.atrStopMultiplier, price * CFG.stopPct / 100);
  const stop = roundPrice(price - stopDistance);
  const target = roundPrice(price + stopDistance * CFG.takeProfitR);
  const action = confidence >= CFG.minConfidence && !trendDown ? "BUY" : "HOLD";
  return { action, confidence, price, stop, target, atr: atrValue, rsi, macdHist: macdData.hist, trend: trendUp ? "up" : trendDown ? "down" : "mixed", pattern: pattern?.name || "", reasons };
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
  if (!values.length) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcMACD(values) {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macdLine = values.map((_, i) => (ema12[i] || values[i]) - (ema26[i] || values[i]));
  const signal = emaSeries(macdLine, 9);
  const hist = last(macdLine) - last(signal);
  const prevHist = macdLine[macdLine.length - 2] - signal[signal.length - 2];
  return { hist, prevHist: Number.isFinite(prevHist) ? prevHist : hist };
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = values[0];
  for (const value of values) {
    ema = value * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevClose), Math.abs(bars[i].l - prevClose)));
  }
  return sma(trs.slice(-period), period);
}

function calcBollinger(values, period = 20) {
  const slice = values.slice(-period);
  const mid = sma(slice, slice.length);
  const variance = slice.reduce((sum, value) => sum + Math.pow(value - mid, 2), 0) / Math.max(slice.length, 1);
  const sd = Math.sqrt(variance);
  return { upper: mid + sd * 2, lower: mid - sd * 2, widthPct: mid ? (sd * 4 / mid) * 100 : 0 };
}

function calcVWAP(bars) {
  let pv = 0;
  let vol = 0;
  for (const bar of bars) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    pv += typical * bar.v;
    vol += bar.v;
  }
  return vol ? pv / vol : latestBarPrice(bars);
}

function candlePattern(bars) {
  if (bars.length < 3) return null;
  const a = bars[bars.length - 3];
  const b = bars[bars.length - 2];
  const c = bars[bars.length - 1];
  const body = Math.abs(c.c - c.o);
  const range = Math.max(c.h - c.l, 0.0001);
  const upper = c.h - Math.max(c.o, c.c);
  const lower = Math.min(c.o, c.c) - c.l;
  const prevBody = Math.abs(b.c - b.o);
  if (c.c > c.o && b.c < b.o && c.c > b.o && c.o < b.c) return { name: "Bullish engulfing", bullish: true, weight: 12 };
  if (c.c < c.o && b.c > b.o && c.o > b.c && c.c < b.o) return { name: "Bearish engulfing", bearish: true, weight: 12 };
  if (lower > body * 2 && upper < body && c.c > c.o) return { name: "Hammer reversal", bullish: true, weight: 8 };
  if (upper > body * 2 && lower < body && c.c < c.o) return { name: "Shooting star", bearish: true, weight: 8 };
  if (body / range < 0.12) return { name: "Doji indecision", bearish: true, weight: 4 };
  if (a.c < a.o && b.c > b.o && c.c > c.o && c.c > a.o && prevBody > 0) return { name: "Morning-star style reversal", bullish: true, weight: 10 };
  return null;
}

function latestBarPrice(bars) {
  return Array.isArray(bars) && bars.length ? bars[bars.length - 1].c : 0;
}

function last(values) {
  return values[values.length - 1] || 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
    `Strategy: ${CFG.timeframe} candles, min confidence ${CFG.minConfidence}%`,
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

async function submitBracketBuy(symbol, qty, price, plan = null) {
  const stop = plan?.stop ?? roundPrice(price * (1 - CFG.stopPct / 100));
  const target = plan?.target ?? roundPrice(price * (1 + CFG.takeProfitPct / 100));
  const body = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: target },
    stop_loss: { stop_price: stop }
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

async function fetchBars(symbol, timeframe = "5Min", limit = 160) {
  const qs = new URLSearchParams({
    symbols: symbol,
    timeframe,
    limit: String(limit),
    feed: "iex",
    adjustment: "raw"
  });
  const data = await alpacaData(`/v2/stocks/bars?${qs.toString()}`);
  return (data.bars?.[symbol] || []).map(normalizeBar).filter(Boolean);
}

function normalizeBar(bar) {
  const o = Number(bar.o);
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  const v = Number(bar.v || 0);
  if (![o, h, l, c].every(Number.isFinite)) return null;
  return { o, h, l, c, v };
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
