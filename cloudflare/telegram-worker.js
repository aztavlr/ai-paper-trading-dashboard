const DEFAULTS = {
  WATCHLIST: "AAPL,TSLA,NVDA,MSFT,SPY",
  RISK_PER_TRADE_PCT: "1",
  STOP_LOSS_PCT: "2",
  TAKE_PROFIT_PCT: "4",
  MAX_OPEN_POSITIONS: "3",
  MAX_DAILY_LOSS_PCT: "3"
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

    await handleCommand(env, msg.text.trim());
    return new Response("ok");
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tradeLoop(env));
  }
};

async function handleCommand(env, text) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.toLowerCase();
  if (cmd === "/start" || cmd === "/help") return sendMessage(env, helpText());
  if (cmd === "/start_trading" || cmd === "/starttrading") {
    await statePut(env, "RUNNING", "true");
    await logEvent(env, "command", { command: "start_trading" });
    return sendMessage(env, "Paper auto-trading is ON. Cloudflare will check the watchlist on the schedule.");
  }
  if (cmd === "/stop_trading" || cmd === "/stoptrading") {
    await statePut(env, "RUNNING", "false");
    await logEvent(env, "command", { command: "stop_trading" });
    return sendMessage(env, "Paper auto-trading is OFF. Existing paper positions are left alone. Use /close_all to close them.");
  }
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
    "/start_trading - turn paper auto-trading on",
    "/stop_trading - stop opening new paper trades",
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
    maxDailyLossPct: Number(await getSetting(env, "MAX_DAILY_LOSS_PCT"))
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

async function tradeLoop(env) {
  if ((await stateGet(env, "RUNNING")) !== "true") return;
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
  if (open.length >= risk.maxPositions) return;

  const watchlist = await getWatchlist(env);
  const snapshots = await fetchSnapshots(env, watchlist);
  for (const symbol of watchlist) {
    const currentPositions = await fetchPositions(env);
    if (currentPositions.length >= risk.maxPositions) break;
    if (currentPositions.some(p => p.symbol === symbol)) continue;
    if (Number(await stateGet(env, `COOLDOWN:${symbol}`) || 0) > Date.now()) continue;

    const price = snapshotPrice(snapshots[symbol]);
    if (!price) continue;
    const history = await pushHistory(env, symbol, price);
    if (getSignal(history) !== "BUY") continue;

    const qty = positionSize(equity, price, risk);
    if (qty < 1) continue;
    const order = await submitBracketBuy(env, symbol, qty, price, risk);
    await statePut(env, `COOLDOWN:${symbol}`, String(Date.now() + 180000));
    await logEvent(env, "paper_order", {
      side: "buy",
      qty,
      entryReference: price,
      stop: roundPrice(price * (1 - risk.stopPct / 100)),
      target: roundPrice(price * (1 + risk.takeProfitPct / 100)),
      orderId: order.id || null
    }, symbol);
    await sendMessage(env, `Paper BUY submitted: ${symbol}\nQty: ${qty}\nEntry ref: ${money(price)}\nStop: ${money(price * (1 - risk.stopPct / 100))}\nTarget: ${money(price * (1 + risk.takeProfitPct / 100))}\nOrder: ${order.id || "submitted"}`);
  }
}

async function pushHistory(env, symbol, price) {
  const key = `HISTORY:${symbol}`;
  const raw = await stateGet(env, key);
  const old = Array.isArray(raw) ? raw : JSON.parse(raw || "[]");
  old.push(price);
  while (old.length > 60) old.shift();
  await statePut(env, key, old);
  return old;
}

function getSignal(history) {
  if (history.length < 20) return "WARMUP";
  const rsi = calcRSI(history);
  const sma8 = sma(history, 8);
  const sma20 = sma(history, 20);
  return rsi < 38 && sma8 > sma20 ? "BUY" : "HOLD";
}

function calcRSI(values, period = 14) {
  const slice = values.slice(-period - 1);
  if (slice.length < period + 1) return 50;
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

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function positionSize(equity, price, risk) {
  const riskDollars = equity * risk.riskPct / 100;
  const riskPerShare = price * risk.stopPct / 100;
  return Math.max(0, Math.floor(riskDollars / riskPerShare));
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
    `Risk/trade: ${risk.riskPct}%`
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

async function submitBracketBuy(env, symbol, qty, price, risk) {
  return alpaca(env, "/v2/orders", {
    method: "POST",
    body: {
      symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      take_profit: { limit_price: roundPrice(price * (1 + risk.takeProfitPct / 100)) },
      stop_loss: { stop_price: roundPrice(price * (1 - risk.stopPct / 100)) }
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
