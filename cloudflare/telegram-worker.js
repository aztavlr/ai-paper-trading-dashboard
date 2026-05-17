const DEFAULTS = {
  WATCHLIST: "AAPL,TSLA,NVDA,MSFT,SPY",
  RISK_PER_TRADE_PCT: "1",
  STOP_LOSS_PCT: "2",
  TAKE_PROFIT_PCT: "4",
  MAX_OPEN_POSITIONS: "3",
  MAX_DAILY_LOSS_PCT: "3",
  MIN_CONFIDENCE: "72",
  BAR_TIMEFRAME: "5Min",
  ATR_STOP_MULTIPLIER: "1.5",
  TAKE_PROFIT_R_MULTIPLIER: "2"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Telegram paper bot worker is online.");
    if (url.pathname !== `/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const update = await request.json().catch(() => null);
    const msg = update?.message;
    if (!msg?.text) return new Response("ok");

    const chatId = String(msg.chat.id);
    if (chatId !== String(env.TELEGRAM_ALLOWED_CHAT_ID)) {
      await sendMessage(env, "Unauthorized chat. This bot is locked to its owner.", chatId);
      return new Response("ok");
    }

    try {
      await handleCommand(env, msg.text.trim());
    } catch (error) {
      await handleBotError(env, error);
    }
    return new Response("ok");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tradeLoop(env).catch(error => handleBotError(env, error)));
  }
};

async function handleBotError(env, error) {
  await logEvent(env, "bot_error", { message: error.message });
  await sendMessage(env, `Bot warning: ${error.message}`);
}

async function handleCommand(env, text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.toLowerCase();
  if (cmd === "/start" || cmd === "/help") return sendMessage(env, helpText());
  if (cmd === "/start_trading" || cmd === "/starttrading" || cmd === "/auto_on") {
    await statePut(env, "RUNNING", "true");
    await logEvent(env, "command", { command: "start_trading" });
    await sendMessage(env, "Paper auto-trading is ON. Cloudflare will check the watchlist every 5 minutes.");
    return tradeLoop(env, true);
  }
  if (cmd === "/stop_trading" || cmd === "/stoptrading" || cmd === "/auto_off") {
    await statePut(env, "RUNNING", "false");
    await logEvent(env, "command", { command: "stop_trading" });
    return sendMessage(env, "Paper auto-trading is OFF. Existing paper positions are left alone. Use /close_all to close them.");
  }
  if (cmd === "/scan_now") return tradeLoop(env, true);
  if (cmd === "/paper_buy" || cmd === "/buy") return manualPaperBuy(env, rest[0]);
  if (cmd === "/explain") return explainSymbol(env, rest[0]);
  if (cmd === "/strategy") return sendMessage(env, strategyText(await getRisk(env)));
  if (cmd === "/status") return sendMessage(env, await statusText(env));
  if (cmd === "/positions") return sendMessage(env, await positionsText(env));
  if (cmd === "/close_all") return closeAllPositions(env);
  if (cmd === "/watch") return updateWatchlist(env, rest);
  if (cmd === "/risk") return updateRisk(env, rest[0]);
  if (cmd === "/test") {
    await fetchAccount(env);
    return sendMessage(env, "Alpaca Paper API connection works.");
  }
  return sendMessage(env, `Unknown command.\n\n${helpText()}`);
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

async function getSetting(env, key) {
  const value = await stateGet(env, key);
  return value == null ? DEFAULTS[key] || "" : String(value);
}

async function getWatchlist(env) {
  return (await getSetting(env, "WATCHLIST")).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}

async function getRisk(env) {
  return {
    riskPct: Number(await getSetting(env, "RISK_PER_TRADE_PCT")),
    stopPct: Number(await getSetting(env, "STOP_LOSS_PCT")),
    takeProfitPct: Number(await getSetting(env, "TAKE_PROFIT_PCT")),
    maxPositions: Number(await getSetting(env, "MAX_OPEN_POSITIONS")),
    maxDailyLossPct: Number(await getSetting(env, "MAX_DAILY_LOSS_PCT")),
    minConfidence: Number(await getSetting(env, "MIN_CONFIDENCE")),
    timeframe: await getSetting(env, "BAR_TIMEFRAME"),
    atrStopMultiplier: Number(await getSetting(env, "ATR_STOP_MULTIPLIER")),
    takeProfitR: Number(await getSetting(env, "TAKE_PROFIT_R_MULTIPLIER"))
  };
}

async function updateWatchlist(env, symbols) {
  const next = symbols.map(s => s.toUpperCase().replace(/[^A-Z.]/g, "")).filter(Boolean).slice(0, 12);
  if (!next.length) return sendMessage(env, `Current watchlist: ${(await getWatchlist(env)).join(", ")}`);
  await statePut(env, "WATCHLIST", next.join(","));
  await logEvent(env, "settings_update", { key: "WATCHLIST", value: next });
  return sendMessage(env, `Watchlist updated: ${next.join(", ")}`);
}

async function updateRisk(env, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return sendMessage(env, "Use /risk with a value from 0.1 to 5. Example: /risk 1");
  await statePut(env, "RISK_PER_TRADE_PCT", String(n));
  await logEvent(env, "settings_update", { key: "RISK_PER_TRADE_PCT", value: n });
  return sendMessage(env, `Risk per paper trade set to ${n}%.`);
}

async function tradeLoop(env, notifyNoTrade = false) {
  const running = (await stateGet(env, "RUNNING")) === "true";
  if (!running && !notifyNoTrade) return;
  const risk = await getRisk(env);
  const account = await fetchAccount(env);
  const equity = Number(account.equity || account.portfolio_value || 0);
  const dailyLoss = Number(account.equity || 0) - Number(account.last_equity || account.equity || 0);
  if (dailyLoss <= -(equity * risk.maxDailyLossPct / 100)) {
    await statePut(env, "RUNNING", "false");
    await logEvent(env, "risk_guard", { reason: "daily_loss", dailyLoss, equity, maxDailyLossPct: risk.maxDailyLossPct });
    await sendMessage(env, `Daily loss guard triggered (${money(dailyLoss)}). Auto-trading stopped.`);
    return;
  }

  const open = await fetchPositions(env);
  if (open.length >= risk.maxPositions) {
    if (notifyNoTrade) await sendMessage(env, `Risk guard: max open positions reached (${open.length}/${risk.maxPositions}).`);
    return;
  }

  const watchlist = await getWatchlist(env);
  const summary = { scanned: 0, warmup: 0, hold: 0, lowConfidence: 0, blocked: 0, noPrice: 0, submitted: 0 };
  for (const symbol of watchlist) {
    summary.scanned++;
    const currentPositions = await fetchPositions(env);
    if (currentPositions.length >= risk.maxPositions) break;
    if (currentPositions.some(p => p.symbol === symbol)) { summary.blocked++; continue; }
    if (Number(await stateGet(env, `COOLDOWN:${symbol}`) || 0) > Date.now()) { summary.blocked++; continue; }

    const bars = await fetchBars(env, symbol, risk.timeframe, 160);
    const analysis = analyzeBars(bars, risk);
    if (!analysis.price) { summary.noPrice++; continue; }
    if (analysis.action === "WARMUP") { summary.warmup++; continue; }
    if (analysis.action !== "BUY") { summary.hold++; continue; }
    if (analysis.confidence < risk.minConfidence) { summary.lowConfidence++; continue; }
    if (!running) { summary.blocked++; continue; }

    const qty = positionSize(equity, analysis.price, risk, analysis.stop);
    if (qty < 1) { summary.blocked++; continue; }
    const order = await submitBracketBuy(env, symbol, qty, analysis.price, risk, analysis);
    summary.submitted++;
    await statePut(env, `COOLDOWN:${symbol}`, String(Date.now() + 180000));
    await logEvent(env, "paper_order", {
      side: "buy",
      qty,
      entryReference: analysis.price,
      stop: analysis.stop,
      target: analysis.target,
      confidence: analysis.confidence,
      reasons: analysis.reasons,
      orderId: order.id || null
    }, symbol);
    await sendMessage(env, `Paper BUY submitted: ${symbol}\nConfidence: ${analysis.confidence}%\nQty: ${qty}\nEntry ref: ${money(analysis.price)}\nStop: ${money(analysis.stop)}\nTarget: ${money(analysis.target)}\nWhy: ${analysis.reasons.slice(0, 4).join("; ")}\nOrder: ${order.id || "submitted"}`);
  }
  await logEvent(env, "scan", summary);
  if (notifyNoTrade && summary.submitted === 0) {
    await sendMessage(env, [
      running ? "Scan complete. No paper orders opened." : "Scan complete. Auto-trading is OFF, so no paper orders were opened.",
      `Scanned: ${summary.scanned}`,
      `Warmup: ${summary.warmup}`,
      `Hold: ${summary.hold}`,
      `Low confidence: ${summary.lowConfidence}`,
      `Blocked: ${summary.blocked}`,
      `No price: ${summary.noPrice}`
    ].join("\n"));
  }
}

async function manualPaperBuy(env, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return sendMessage(env, "Usage: /paper_buy AAPL");
  const risk = await getRisk(env);
  const account = await fetchAccount(env);
  const equity = Number(account.equity || account.portfolio_value || 0);
  const dailyLoss = Number(account.equity || 0) - Number(account.last_equity || account.equity || 0);
  if (dailyLoss <= -(equity * risk.maxDailyLossPct / 100)) {
    await statePut(env, "RUNNING", "false");
    await logEvent(env, "risk_guard", { reason: "daily_loss", dailyLoss, equity, maxDailyLossPct: risk.maxDailyLossPct }, symbol);
    return sendMessage(env, `Risk guard blocked ${symbol}: daily loss limit hit (${money(dailyLoss)}).`);
  }

  const open = await fetchPositions(env);
  if (open.length >= risk.maxPositions) return sendMessage(env, `Risk guard blocked ${symbol}: max positions reached (${open.length}/${risk.maxPositions}).`);
  if (open.some(p => p.symbol === symbol)) return sendMessage(env, `Risk guard blocked ${symbol}: position already open.`);
  if (Number(await stateGet(env, `COOLDOWN:${symbol}`) || 0) > Date.now()) return sendMessage(env, `Risk guard blocked ${symbol}: cooldown is active.`);

  const bars = await fetchBars(env, symbol, risk.timeframe, 160);
  const analysis = analyzeBars(bars, risk);
  if (!analysis.price) return sendMessage(env, `Could not get Alpaca candle data for ${symbol}. This bot currently supports Alpaca stock/ETF symbols.`);
  const qty = positionSize(equity, analysis.price, risk, analysis.stop);
  if (qty < 1) return sendMessage(env, `Risk sizing blocked ${symbol}: account equity/risk settings produce quantity below 1 share.`);

  const order = await submitBracketBuy(env, symbol, qty, analysis.price, risk, analysis);
  await statePut(env, `COOLDOWN:${symbol}`, String(Date.now() + 180000));
  await logEvent(env, "manual_paper_order", {
    side: "buy",
    qty,
    entryReference: analysis.price,
    stop: analysis.stop,
    target: analysis.target,
    confidence: analysis.confidence,
    reasons: analysis.reasons,
    orderId: order.id || null
  }, symbol);
  return sendMessage(env, `Manual paper BUY submitted: ${symbol}\nConfidence: ${analysis.confidence}%\nQty: ${qty}\nEntry ref: ${money(analysis.price)}\nStop: ${money(analysis.stop)}\nTarget: ${money(analysis.target)}\nWhy: ${analysis.reasons.slice(0, 4).join("; ")}\nOrder: ${order.id || "submitted"}`);
}

function normalizeSymbol(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 12);
}

function positionSize(equity, price, risk, stopPrice = null) {
  const riskDollars = equity * risk.riskPct / 100;
  const riskPerShare = stopPrice ? Math.abs(price - stopPrice) : price * risk.stopPct / 100;
  return Math.max(0, Math.floor(riskDollars / riskPerShare));
}

async function explainSymbol(env, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return sendMessage(env, "Usage: /explain AAPL");
  const risk = await getRisk(env);
  const bars = await fetchBars(env, symbol, risk.timeframe, 160);
  const a = analyzeBars(bars, risk);
  if (!a.price) return sendMessage(env, `No candle data available for ${symbol}.`);
  return sendMessage(env, [
    `${symbol} advanced readout (${risk.timeframe})`,
    `Action: ${a.action}`,
    `Confidence: ${a.confidence}% / required ${risk.minConfidence}%`,
    `Price: ${money(a.price)}`,
    `RSI: ${a.rsi.toFixed(1)} | MACD hist: ${a.macdHist.toFixed(3)}`,
    `Trend: ${a.trend}`,
    `ATR: ${money(a.atr)} | Stop: ${money(a.stop)} | Target: ${money(a.target)}`,
    `Pattern: ${a.pattern || "none"}`,
    `Why: ${a.reasons.join("; ")}`
  ].join("\n"));
}

function strategyText(risk) {
  return [
    "Advanced paper strategy:",
    `Timeframe: ${risk.timeframe}`,
    `Minimum confidence: ${risk.minConfidence}%`,
    `Risk per trade: ${risk.riskPct}%`,
    `ATR stop multiplier: ${risk.atrStopMultiplier}x`,
    `Take profit: ${risk.takeProfitR}R`,
    "Reads: EMA trend, RSI, MACD, Bollinger position, VWAP, volume, ATR volatility, support/resistance, and candlestick patterns.",
    "Still educational paper trading only. No method is 100% accurate."
  ].join("\n");
}

function analyzeBars(bars, risk) {
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
  const atrStop = atrValue * risk.atrStopMultiplier;
  const percentStop = price * risk.stopPct / 100;
  const stopDistance = Math.max(atrStop || 0, percentStop);
  const stop = roundPrice(price - stopDistance);
  const target = roundPrice(price + stopDistance * risk.takeProfitR);
  const action = confidence >= risk.minConfidence && !trendDown ? "BUY" : "HOLD";

  return {
    action,
    confidence,
    price,
    stop,
    target,
    atr: atrValue,
    rsi,
    macdHist: macdData.hist,
    trend: trendUp ? "up" : trendDown ? "down" : "mixed",
    pattern: pattern?.name || "",
    reasons
  };
}

function latestBarPrice(bars) {
  return Array.isArray(bars) && bars.length ? bars[bars.length - 1].c : 0;
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
  return 100 - 100 / (1 + gains / losses);
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
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prevClose),
      Math.abs(bars[i].l - prevClose)
    ));
  }
  return sma(trs.slice(-period), period);
}

function calcBollinger(values, period = 20) {
  const slice = values.slice(-period);
  const mid = sma(slice, slice.length);
  const variance = slice.reduce((sum, value) => sum + Math.pow(value - mid, 2), 0) / Math.max(slice.length, 1);
  const sd = Math.sqrt(variance);
  return {
    upper: mid + sd * 2,
    lower: mid - sd * 2,
    widthPct: mid ? (sd * 4 / mid) * 100 : 0
  };
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

function sma(values, period) {
  if (!values.length) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function last(values) {
  return values[values.length - 1] || 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function statusText(env) {
  const account = await fetchAccount(env);
  const positions = await fetchPositions(env);
  const risk = await getRisk(env);
  return [
    `Paper auto-trading: ${(await stateGet(env, "RUNNING")) === "true" ? "ON" : "OFF"}`,
    `Equity: ${money(Number(account.equity || 0))}`,
    `Buying power: ${money(Number(account.buying_power || 0))}`,
    `Open positions: ${positions.length}/${risk.maxPositions}`,
    `Watchlist: ${(await getWatchlist(env)).join(", ")}`,
    `Risk/trade: ${risk.riskPct}%`,
    `Strategy: ${risk.timeframe} candles, min confidence ${risk.minConfidence}%`
  ].join("\n");
}

async function positionsText(env) {
  const positions = await fetchPositions(env);
  if (!positions.length) return "No open paper positions.";
  return positions.map(p => `${p.symbol}: ${p.qty} @ ${money(Number(p.avg_entry_price || 0))} | P&L ${money(Number(p.unrealized_pl || 0))}`).join("\n");
}

async function closeAllPositions(env) {
  const positions = await fetchPositions(env);
  if (!positions.length) return sendMessage(env, "No open paper positions to close.");
  await alpaca(env, "/v2/positions", { method: "DELETE" });
  await statePut(env, "RUNNING", "false");
  await logEvent(env, "command", { command: "close_all", closedPositions: positions.length });
  return sendMessage(env, "Close-all request sent. Auto-trading is now OFF.");
}

async function submitBracketBuy(env, symbol, qty, price, risk, plan = null) {
  const stop = plan?.stop ?? roundPrice(price * (1 - risk.stopPct / 100));
  const target = plan?.target ?? roundPrice(price * (1 + risk.takeProfitPct / 100));
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: {
      symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: target },
      stop_loss: { stop_price: stop }
    }
  });
}

function roundPrice(value) {
  return Number(value >= 1 ? value.toFixed(2) : value.toFixed(4));
}

async function fetchAccount(env) {
  return alpaca(env, "/v2/account");
}

async function fetchPositions(env) {
  return alpaca(env, "/v2/positions");
}

async function fetchSnapshots(env, symbols) {
  const qs = encodeURIComponent(symbols.join(","));
  const data = await alpacaData(env, `/v2/stocks/snapshots?symbols=${qs}&feed=iex`);
  return data.snapshots || data;
}

async function fetchBars(env, symbol, timeframe = "5Min", limit = 160) {
  const qs = new URLSearchParams({
    symbols: symbol,
    timeframe,
    limit: String(limit),
    feed: "iex",
    adjustment: "raw"
  });
  const data = await alpacaData(env, `/v2/stocks/bars?${qs.toString()}`);
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

async function alpaca(env, pathname, options = {}) {
  return request(`https://paper-api.alpaca.markets${pathname}`, {
    ...options,
    headers: alpacaHeaders(env)
  });
}

async function alpacaData(env, pathname) {
  return request(`https://data.alpaca.markets${pathname}`, {
    headers: alpacaHeaders(env)
  });
}

function alpacaHeaders(env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY,
    "content-type": "application/json"
  };
}

async function stateGet(env, key) {
  if (hasSupabase(env)) {
    const owner = encodeURIComponent(ownerId(env));
    const stateKey = encodeURIComponent(key);
    const rows = await supabase(env, `/rest/v1/bot_state?owner_id=eq.${owner}&key=eq.${stateKey}&select=value`);
    return rows?.[0]?.value ?? null;
  }
  if (env.STATE) return env.STATE.get(key);
  throw new Error("No state backend configured. Add Supabase secrets or a STATE KV binding.");
}

async function statePut(env, key, value) {
  if (hasSupabase(env)) {
    await supabase(env, "/rest/v1/bot_state?on_conflict=owner_id,key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: [{ owner_id: ownerId(env), key, value, updated_at: new Date().toISOString() }]
    });
    return;
  }
  if (env.STATE) {
    await env.STATE.put(key, typeof value === "string" ? value : JSON.stringify(value));
    return;
  }
  throw new Error("No state backend configured. Add Supabase secrets or a STATE KV binding.");
}

async function logEvent(env, type, payload = {}, symbol = null) {
  if (!hasSupabase(env)) return;
  try {
    await supabase(env, "/rest/v1/bot_events", {
      method: "POST",
      body: [{ owner_id: ownerId(env), type, symbol, payload }]
    });
  } catch (error) {
    console.warn("Supabase event log failed", error.message);
  }
}

async function supabase(env, pathname, options = {}) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  return request(`${base}${pathname}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
}

function hasSupabase(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function ownerId(env) {
  return String(env.BOT_OWNER_ID || env.TELEGRAM_ALLOWED_CHAT_ID || "default");
}

async function sendMessage(env, text, chatId = env.TELEGRAM_ALLOWED_CHAT_ID) {
  return request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { chat_id: chatId, text, disable_web_page_preview: true }
  });
}

async function request(url, options = {}) {
  const init = { method: options.method || "GET", headers: options.headers || {} };
  if (options.body) init.body = JSON.stringify(options.body);
  const res = await fetch(url, init);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || data.error || data.description || `HTTP ${res.status}`);
  }
  return data;
}

function money(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : "$0.00";
}
