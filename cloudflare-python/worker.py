from workers import WorkerEntrypoint, Response
from js import Object, fetch
from pyodide.ffi import to_js as _to_js

import json
import math
import re
import time
from urllib.parse import quote, urlencode, urlparse


DEFAULTS = {
    "WATCHLIST": "AAPL,TSLA,NVDA,MSFT,SPY",
    "RISK_PER_TRADE_PCT": "1",
    "STOP_LOSS_PCT": "2",
    "TAKE_PROFIT_PCT": "4",
    "MAX_OPEN_POSITIONS": "3",
    "MAX_DAILY_LOSS_PCT": "3",
    "MIN_CONFIDENCE": "72",
    "BAR_TIMEFRAME": "5Min",
    "ATR_STOP_MULTIPLIER": "1.5",
    "TAKE_PROFIT_R_MULTIPLIER": "2",
    "COOLDOWN_MINUTES": "30",
}

ALPACA_PAPER_API = "https://paper-api.alpaca.markets"
ALPACA_DATA_API = "https://data.alpaca.markets"


def to_js(obj):
    return _to_js(obj, dict_converter=Object.fromEntries)


def env_value(env, key, fallback=""):
    value = getattr(env, key, fallback)
    return "" if value is None else str(value)


async def request_json(url, method="GET", headers=None, body=None):
    init = {"method": method, "headers": headers or {}}
    if body is not None:
        init["body"] = json.dumps(body)
    res = await fetch(url, to_js(init))
    text = await res.text()
    try:
        data = json.loads(str(text)) if str(text) else {}
    except Exception:
        data = {"message": str(text)}
    telegram_error = isinstance(data, dict) and data.get("ok") is False
    if not bool(res.ok) or telegram_error:
        if isinstance(data, dict):
            message = data.get("message") or data.get("error") or data.get("description")
        else:
            message = None
        raise RuntimeError(message or f"HTTP {res.status}")
    return data


def money(value):
    return f"${value:.2f}" if isinstance(value, (int, float)) and math.isfinite(value) else "$0.00"


def round_price(value):
    return round(value, 2 if value >= 1 else 4)


def normalize_symbol(value):
    return re.sub(r"[^A-Z.]", "", str(value or "").upper())[:12]


async def send_message(env, text, chat_id=None):
    token = env_value(env, "TELEGRAM_BOT_TOKEN")
    target = chat_id or env_value(env, "TELEGRAM_ALLOWED_CHAT_ID")
    return await request_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        method="POST",
        headers={"content-type": "application/json"},
        body={"chat_id": target, "text": text, "disable_web_page_preview": True},
    )


def alpaca_headers(env):
    return {
        "APCA-API-KEY-ID": env_value(env, "ALPACA_API_KEY_ID"),
        "APCA-API-SECRET-KEY": env_value(env, "ALPACA_API_SECRET_KEY"),
        "content-type": "application/json",
    }


async def alpaca(env, pathname, method="GET", body=None):
    return await request_json(f"{ALPACA_PAPER_API}{pathname}", method=method, headers=alpaca_headers(env), body=body)


async def alpaca_data(env, pathname):
    return await request_json(f"{ALPACA_DATA_API}{pathname}", headers=alpaca_headers(env))


def owner_id(env):
    return env_value(env, "BOT_OWNER_ID") or env_value(env, "TELEGRAM_ALLOWED_CHAT_ID") or "default"


def has_supabase(env):
    return bool(env_value(env, "SUPABASE_URL") and env_value(env, "SUPABASE_SERVICE_ROLE_KEY"))


async def supabase(env, pathname, method="GET", headers=None, body=None):
    base = env_value(env, "SUPABASE_URL").rstrip("/")
    key = env_value(env, "SUPABASE_SERVICE_ROLE_KEY")
    merged = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "content-type": "application/json",
    }
    if headers:
        merged.update(headers)
    return await request_json(f"{base}{pathname}", method=method, headers=merged, body=body)


async def state_get(env, key):
    if not has_supabase(env):
        return None
    owner = owner_id(env)
    rows = await supabase(
        env,
        f"/rest/v1/bot_state?owner_id=eq.{quote(owner, safe='')}&key=eq.{quote(key, safe='')}&select=value",
    )
    return rows[0]["value"] if rows else None


async def state_put(env, key, value):
    if not has_supabase(env):
        raise RuntimeError("Supabase state backend is not configured.")
    await supabase(
        env,
        "/rest/v1/bot_state?on_conflict=owner_id,key",
        method="POST",
        headers={"Prefer": "resolution=merge-duplicates"},
        body=[{"owner_id": owner_id(env), "key": key, "value": value}],
    )


async def log_event(env, type_, payload=None, symbol=None):
    if not has_supabase(env):
        return
    try:
        await supabase(
            env,
            "/rest/v1/bot_events",
            method="POST",
            body=[{"owner_id": owner_id(env), "type": type_, "symbol": symbol, "payload": payload or {}}],
        )
    except Exception:
        pass


async def get_setting(env, key):
    value = await state_get(env, key)
    return str(DEFAULTS.get(key, "")) if value is None else str(value)


async def get_watchlist(env):
    raw = await get_setting(env, "WATCHLIST")
    return [s.strip().upper() for s in raw.split(",") if s.strip()]


async def get_risk(env):
    return {
        "risk_pct": float(await get_setting(env, "RISK_PER_TRADE_PCT")),
        "stop_pct": float(await get_setting(env, "STOP_LOSS_PCT")),
        "take_profit_pct": float(await get_setting(env, "TAKE_PROFIT_PCT")),
        "max_positions": int(float(await get_setting(env, "MAX_OPEN_POSITIONS"))),
        "max_daily_loss_pct": float(await get_setting(env, "MAX_DAILY_LOSS_PCT")),
        "min_confidence": float(await get_setting(env, "MIN_CONFIDENCE")),
        "timeframe": await get_setting(env, "BAR_TIMEFRAME"),
        "atr_stop_multiplier": float(await get_setting(env, "ATR_STOP_MULTIPLIER")),
        "take_profit_r": float(await get_setting(env, "TAKE_PROFIT_R_MULTIPLIER")),
        "cooldown_minutes": float(await get_setting(env, "COOLDOWN_MINUTES")),
    }


async def fetch_account(env):
    return await alpaca(env, "/v2/account")


async def fetch_positions(env):
    data = await alpaca(env, "/v2/positions")
    return data if isinstance(data, list) else []


async def fetch_bars(env, symbol, timeframe="5Min", limit=160):
    qs = urlencode({"symbols": symbol, "timeframe": timeframe, "limit": str(limit), "feed": "iex", "adjustment": "raw"})
    data = await alpaca_data(env, f"/v2/stocks/bars?{qs}")
    rows = data.get("bars", {}).get(symbol, [])
    bars = []
    for row in rows:
        try:
            bars.append({"o": float(row["o"]), "h": float(row["h"]), "l": float(row["l"]), "c": float(row["c"]), "v": float(row.get("v", 0))})
        except Exception:
            pass
    return bars


def sma(values, period):
    if not values:
        return 0.0
    chunk = values[-period:]
    return sum(chunk) / len(chunk)


def ema_series(values, period):
    if not values:
        return []
    k = 2 / (period + 1)
    ema = values[0]
    out = []
    for value in values:
        ema = value * k + ema * (1 - k)
        out.append(ema)
    return out


def calc_rsi(values, period=14):
    if len(values) < period + 1:
        return 50.0
    gains = losses = 0.0
    for prev, cur in zip(values[-period - 1 : -1], values[-period:]):
        change = cur - prev
        if change >= 0:
            gains += change
        else:
            losses -= change
    if losses == 0:
        return 100.0
    return 100 - 100 / (1 + gains / losses)


def calc_macd(values):
    ema12 = ema_series(values, 12)
    ema26 = ema_series(values, 26)
    macd = [(ema12[i] if i < len(ema12) else values[i]) - (ema26[i] if i < len(ema26) else values[i]) for i in range(len(values))]
    signal = ema_series(macd, 9)
    hist = macd[-1] - signal[-1]
    prev_hist = macd[-2] - signal[-2] if len(macd) > 1 and len(signal) > 1 else hist
    return hist, prev_hist


def calc_atr(bars, period=14):
    if len(bars) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(bars)):
        prev_close = bars[i - 1]["c"]
        trs.append(max(bars[i]["h"] - bars[i]["l"], abs(bars[i]["h"] - prev_close), abs(bars[i]["l"] - prev_close)))
    return sma(trs[-period:], period)


def calc_bollinger(values, period=20):
    chunk = values[-period:]
    mid = sma(chunk, len(chunk))
    variance = sum((value - mid) ** 2 for value in chunk) / max(len(chunk), 1)
    sd = math.sqrt(variance)
    return mid + sd * 2, mid - sd * 2, (sd * 4 / mid) * 100 if mid else 0


def calc_vwap(bars):
    pv = vol = 0.0
    for bar in bars:
        typical = (bar["h"] + bar["l"] + bar["c"]) / 3
        pv += typical * bar["v"]
        vol += bar["v"]
    return pv / vol if vol else (bars[-1]["c"] if bars else 0.0)


def candle_pattern(bars):
    if len(bars) < 3:
        return None
    a, b, c = bars[-3], bars[-2], bars[-1]
    body = abs(c["c"] - c["o"])
    rng = max(c["h"] - c["l"], 0.0001)
    upper = c["h"] - max(c["o"], c["c"])
    lower = min(c["o"], c["c"]) - c["l"]
    if c["c"] > c["o"] and b["c"] < b["o"] and c["c"] > b["o"] and c["o"] < b["c"]:
        return {"name": "Bullish engulfing", "bullish": True, "weight": 12}
    if c["c"] < c["o"] and b["c"] > b["o"] and c["o"] > b["c"] and c["c"] < b["o"]:
        return {"name": "Bearish engulfing", "bearish": True, "weight": 12}
    if lower > body * 2 and upper < body and c["c"] > c["o"]:
        return {"name": "Hammer reversal", "bullish": True, "weight": 8}
    if upper > body * 2 and lower < body and c["c"] < c["o"]:
        return {"name": "Shooting star", "bearish": True, "weight": 8}
    if body / rng < 0.12:
        return {"name": "Doji indecision", "bearish": True, "weight": 4}
    if a["c"] < a["o"] and b["c"] > b["o"] and c["c"] > c["o"] and c["c"] > a["o"]:
        return {"name": "Morning-star style reversal", "bullish": True, "weight": 10}
    return None


def analyze_bars(bars, risk):
    if len(bars) < 60:
        return {"action": "WARMUP", "confidence": 0, "price": bars[-1]["c"] if bars else 0, "reasons": ["Need at least 60 candles"]}
    closes = [b["c"] for b in bars]
    highs = [b["h"] for b in bars]
    lows = [b["l"] for b in bars]
    volumes = [b["v"] for b in bars]
    price = closes[-1]
    ema9, ema21, ema50 = ema_series(closes, 9)[-1], ema_series(closes, 21)[-1], ema_series(closes, 50)[-1]
    rsi = calc_rsi(closes)
    macd_hist, prev_hist = calc_macd(closes)
    atr = calc_atr(bars)
    bb_upper, bb_lower, bb_width = calc_bollinger(closes)
    vwap = calc_vwap(bars[-40:])
    avg_vol = sma(volumes[-21:-1], 20)
    vol_ratio = volumes[-1] / avg_vol if avg_vol else 1
    recent_high = max(highs[-30:-1])
    recent_low = min(lows[-30:-1])
    pattern = candle_pattern(bars)
    score = 50
    reasons = []
    trend_up = ema9 > ema21 > ema50
    trend_down = ema9 < ema21 < ema50
    if trend_up:
        score += 16; reasons.append("EMA trend up")
    elif trend_down:
        score -= 18; reasons.append("EMA trend down")
    else:
        reasons.append("Mixed EMA trend")
    if price > vwap:
        score += 7; reasons.append("Price above VWAP")
    else:
        score -= 5; reasons.append("Price below VWAP")
    if 42 <= rsi <= 62:
        score += 8; reasons.append("RSI healthy")
    elif rsi < 35:
        score += 5; reasons.append("RSI oversold bounce candidate")
    elif rsi > 72:
        score -= 12; reasons.append("RSI overbought")
    if macd_hist > 0 and macd_hist > prev_hist:
        score += 12; reasons.append("MACD improving")
    elif macd_hist < 0 and macd_hist < prev_hist:
        score -= 12; reasons.append("MACD weakening")
    if 0.6 < bb_width < 8:
        score += 4; reasons.append("Volatility usable")
    elif bb_width >= 8:
        score -= 8; reasons.append("Volatility elevated")
    if price > bb_upper:
        score -= 8; reasons.append("Extended above Bollinger band")
    if price < bb_lower:
        score += 5; reasons.append("Below lower Bollinger band")
    if vol_ratio >= 1.15:
        score += 7; reasons.append("Volume confirmation")
    if price > recent_high:
        score += 9; reasons.append("Breakout above recent high")
    if price < recent_low:
        score -= 10; reasons.append("Breakdown below recent low")
    if pattern and pattern.get("bullish"):
        score += pattern["weight"]; reasons.append(pattern["name"])
    if pattern and pattern.get("bearish"):
        score -= pattern["weight"]; reasons.append(pattern["name"])
    confidence = max(1, min(96, round(score)))
    stop_distance = max(atr * risk["atr_stop_multiplier"], price * risk["stop_pct"] / 100)
    stop = round_price(price - stop_distance)
    target = round_price(price + stop_distance * risk["take_profit_r"])
    action = "BUY" if confidence >= risk["min_confidence"] and not trend_down else "HOLD"
    return {
        "action": action, "confidence": confidence, "price": price, "stop": stop, "target": target,
        "atr": atr, "rsi": rsi, "macd_hist": macd_hist, "trend": "up" if trend_up else "down" if trend_down else "mixed",
        "pattern": pattern["name"] if pattern else "", "reasons": reasons,
    }


def position_size(equity, price, risk, stop_price=None):
    risk_dollars = equity * risk["risk_pct"] / 100
    risk_per_share = abs(price - stop_price) if stop_price else price * risk["stop_pct"] / 100
    return max(0, math.floor(risk_dollars / max(risk_per_share, 0.01)))


def now_ms():
    return int(time.time() * 1000)


async def cooldown_active(env, symbol):
    raw = await state_get(env, f"COOLDOWN:{symbol}")
    try:
        until = float(raw or 0)
    except Exception:
        until = 0
    return until > now_ms()


async def set_cooldown(env, symbol, risk):
    until = now_ms() + int(risk["cooldown_minutes"] * 60 * 1000)
    await state_put(env, f"COOLDOWN:{symbol}", str(until))


async def submit_bracket_buy(env, symbol, qty, analysis):
    return await alpaca(env, "/v2/orders", method="POST", body={
        "symbol": symbol,
        "qty": str(qty),
        "side": "buy",
        "type": "market",
        "time_in_force": "day",
        "order_class": "bracket",
        "take_profit": {"limit_price": analysis["target"]},
        "stop_loss": {"stop_price": analysis["stop"]},
    })


def strategy_text(risk):
    return "\n".join([
        "Advanced Python Worker paper strategy:",
        f"Timeframe: {risk['timeframe']}",
        f"Minimum confidence: {risk['min_confidence']}%",
        f"Risk per trade: {risk['risk_pct']}%",
        f"ATR stop multiplier: {risk['atr_stop_multiplier']}x",
        f"Take profit: {risk['take_profit_r']}R",
        "Reads: EMA trend, RSI, MACD, Bollinger position, VWAP, volume, ATR volatility, support/resistance, and candlestick patterns.",
        "Still educational paper trading only. No method is 100% accurate.",
    ])


async def explain_symbol(env, raw_symbol):
    symbol = normalize_symbol(raw_symbol)
    if not symbol:
        return await send_message(env, "Usage: /explain AAPL")
    risk = await get_risk(env)
    analysis = analyze_bars(await fetch_bars(env, symbol, risk["timeframe"], 160), risk)
    if not analysis["price"]:
        return await send_message(env, f"No candle data available for {symbol}.")
    return await send_message(env, "\n".join([
        f"{symbol} Python Worker readout ({risk['timeframe']})",
        f"Action: {analysis['action']}",
        f"Confidence: {analysis['confidence']}% / required {risk['min_confidence']}%",
        f"Price: {money(analysis['price'])}",
        f"RSI: {analysis['rsi']:.1f} | MACD hist: {analysis['macd_hist']:.3f}",
        f"Trend: {analysis['trend']}",
        f"ATR: {money(analysis['atr'])} | Stop: {money(analysis['stop'])} | Target: {money(analysis['target'])}",
        f"Pattern: {analysis['pattern'] or 'none'}",
        f"Why: {'; '.join(analysis['reasons'])}",
    ]))


async def manual_paper_buy(env, raw_symbol):
    symbol = normalize_symbol(raw_symbol)
    if not symbol:
        return await send_message(env, "Usage: /paper_buy AAPL")
    risk = await get_risk(env)
    account = await fetch_account(env)
    equity = float(account.get("equity") or account.get("portfolio_value") or 0)
    open_positions = await fetch_positions(env)
    if len(open_positions) >= risk["max_positions"]:
        return await send_message(env, f"Risk guard blocked {symbol}: max positions reached.")
    if any(p.get("symbol") == symbol for p in open_positions):
        return await send_message(env, f"Risk guard blocked {symbol}: position already open.")
    if await cooldown_active(env, symbol):
        return await send_message(env, f"Risk guard blocked {symbol}: cooldown is active.")
    analysis = analyze_bars(await fetch_bars(env, symbol, risk["timeframe"], 160), risk)
    qty = position_size(equity, analysis["price"], risk, analysis.get("stop"))
    if qty < 1:
        return await send_message(env, f"Risk sizing blocked {symbol}: quantity below 1 share.")
    order = await submit_bracket_buy(env, symbol, qty, analysis)
    await set_cooldown(env, symbol, risk)
    await log_event(env, "manual_python_order", {"symbol": symbol, "qty": qty, "analysis": analysis}, symbol)
    return await send_message(env, f"Manual paper BUY submitted: {symbol}\nConfidence: {analysis['confidence']}%\nQty: {qty}\nEntry ref: {money(analysis['price'])}\nStop: {money(analysis['stop'])}\nTarget: {money(analysis['target'])}\nWhy: {'; '.join(analysis['reasons'][:4])}\nOrder: {order.get('id', 'submitted')}")


async def trade_loop(env, notify=False):
    running = await state_get(env, "RUNNING") == "true"
    if not running and not notify:
        return
    risk = await get_risk(env)
    account = await fetch_account(env)
    equity = float(account.get("equity") or account.get("portfolio_value") or 0)
    daily_loss = float(account.get("equity") or 0) - float(account.get("last_equity") or account.get("equity") or 0)
    if daily_loss <= -(equity * risk["max_daily_loss_pct"] / 100):
        await state_put(env, "RUNNING", "false")
        await send_message(env, f"Daily loss guard triggered ({money(daily_loss)}). Auto-trading stopped.")
        return
    summary = {"scanned": 0, "warmup": 0, "hold": 0, "low": 0, "blocked": 0, "orders": 0}
    for symbol in await get_watchlist(env):
        summary["scanned"] += 1
        positions = await fetch_positions(env)
        if len(positions) >= risk["max_positions"]:
            summary["blocked"] += 1
            break
        if any(p.get("symbol") == symbol for p in positions):
            summary["blocked"] += 1
            continue
        if await cooldown_active(env, symbol):
            summary["blocked"] += 1
            continue
        analysis = analyze_bars(await fetch_bars(env, symbol, risk["timeframe"], 160), risk)
        if analysis["action"] == "WARMUP":
            summary["warmup"] += 1
            continue
        if analysis["action"] != "BUY":
            summary["hold"] += 1
            continue
        if analysis["confidence"] < risk["min_confidence"]:
            summary["low"] += 1
            continue
        if not running:
            summary["blocked"] += 1
            continue
        qty = position_size(equity, analysis["price"], risk, analysis["stop"])
        if qty < 1:
            summary["blocked"] += 1
            continue
        order = await submit_bracket_buy(env, symbol, qty, analysis)
        summary["orders"] += 1
        await set_cooldown(env, symbol, risk)
        await log_event(env, "python_paper_order", {"symbol": symbol, "qty": qty, "analysis": analysis, "order_id": order.get("id")}, symbol)
        await send_message(env, f"Paper BUY submitted: {symbol}\nConfidence: {analysis['confidence']}%\nQty: {qty}\nEntry ref: {money(analysis['price'])}\nStop: {money(analysis['stop'])}\nTarget: {money(analysis['target'])}\nWhy: {'; '.join(analysis['reasons'][:4])}\nOrder: {order.get('id', 'submitted')}")
    await log_event(env, "python_scan", summary)
    if notify and summary["orders"] == 0:
        await send_message(env, f"Python scan complete. No paper orders opened.\nScanned: {summary['scanned']}\nWarmup: {summary['warmup']}\nHold: {summary['hold']}\nLow confidence: {summary['low']}\nBlocked: {summary['blocked']}")


async def status_text(env):
    risk = await get_risk(env)
    account = await fetch_account(env)
    positions = await fetch_positions(env)
    return "\n".join([
        f"Python Worker auto-trading: {'ON' if await state_get(env, 'RUNNING') == 'true' else 'OFF'}",
        f"Equity: {money(float(account.get('equity') or 0))}",
        f"Buying power: {money(float(account.get('buying_power') or 0))}",
        f"Open positions: {len(positions)}/{risk['max_positions']}",
        f"Watchlist: {', '.join(await get_watchlist(env))}",
            f"Strategy: {risk['timeframe']} candles, min confidence {risk['min_confidence']}%",
            f"Cooldown after entries: {risk['cooldown_minutes']:.0f} minutes",
    ])


async def positions_text(env):
    positions = await fetch_positions(env)
    if not positions:
        return "No open paper positions."
    return "\n".join(f"{p.get('symbol')}: {p.get('qty')} @ {money(float(p.get('avg_entry_price') or 0))} | P&L {money(float(p.get('unrealized_pl') or 0))}" for p in positions)


async def close_all_positions(env):
    positions = await fetch_positions(env)
    if not positions:
        return await send_message(env, "No open paper positions to close.")
    await alpaca(env, "/v2/positions", method="DELETE")
    await state_put(env, "RUNNING", "false")
    return await send_message(env, "Close-all request sent. Auto-trading is now OFF.")


async def update_watchlist(env, symbols):
    next_symbols = [normalize_symbol(s) for s in symbols]
    next_symbols = [s for s in next_symbols if s][:12]
    if not next_symbols:
        return await send_message(env, f"Current watchlist: {', '.join(await get_watchlist(env))}")
    await state_put(env, "WATCHLIST", ",".join(next_symbols))
    return await send_message(env, f"Watchlist updated: {', '.join(next_symbols)}")


async def update_risk(env, value):
    try:
        risk = float(value)
    except Exception:
        risk = 0
    if risk <= 0 or risk > 5:
        return await send_message(env, "Use /risk with a value from 0.1 to 5. Example: /risk 1")
    await state_put(env, "RISK_PER_TRADE_PCT", str(risk))
    return await send_message(env, f"Risk per paper trade set to {risk}%.")


def help_text():
    return "\n".join([
        "Python Worker commands:",
        "/auto_on or /start_trading - start paper automation",
        "/auto_off or /stop_trading - stop new paper orders",
        "/scan_now - scan now",
        "/paper_buy AAPL - manual risk-sized bracket buy",
        "/explain AAPL - explain candle/indicator readout",
        "/strategy - show strategy settings",
        "/status - show account/bot status",
        "/positions - show positions",
        "/close_all - close paper positions",
        "/watch AAPL TSLA SPY - replace watchlist",
        "/risk 1 - set risk percent",
        "/test - test Alpaca Paper API",
    ])


async def handle_command(env, text):
    parts = text.split()
    cmd = parts[0].lower()
    rest = parts[1:]
    if cmd in {"/start", "/help"}:
        return await send_message(env, help_text())
    if cmd in {"/start_trading", "/starttrading", "/auto_on"}:
        await state_put(env, "RUNNING", "true")
        await send_message(env, "Python Worker paper auto-trading is ON.")
        return await trade_loop(env, True)
    if cmd in {"/stop_trading", "/stoptrading", "/auto_off"}:
        await state_put(env, "RUNNING", "false")
        return await send_message(env, "Python Worker paper auto-trading is OFF.")
    if cmd == "/scan_now":
        return await trade_loop(env, True)
    if cmd in {"/paper_buy", "/buy"}:
        return await manual_paper_buy(env, rest[0] if rest else "")
    if cmd == "/explain":
        return await explain_symbol(env, rest[0] if rest else "")
    if cmd == "/strategy":
        return await send_message(env, strategy_text(await get_risk(env)))
    if cmd == "/status":
        return await send_message(env, await status_text(env))
    if cmd == "/positions":
        return await send_message(env, await positions_text(env))
    if cmd == "/close_all":
        return await close_all_positions(env)
    if cmd == "/watch":
        return await update_watchlist(env, rest)
    if cmd == "/risk":
        return await update_risk(env, rest[0] if rest else "")
    if cmd == "/test":
        await fetch_account(env)
        return await send_message(env, "Alpaca Paper API connection works from Python Worker.")
    return await send_message(env, f"Unknown command.\n\n{help_text()}")


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        parsed = urlparse(str(request.url))
        if parsed.path == "/":
            return Response("Python Telegram paper bot worker is online.")
        if parsed.path == "/debug":
            payload = {"runtime": "python-worker", "status": "ok"}
            try:
                payload["risk"] = await get_risk(self.env)
            except Exception as exc:
                payload["status"] = "degraded"
                payload["risk_error"] = str(exc)
            return Response(json.dumps(payload))
        if parsed.path != f"/webhook/{env_value(self.env, 'TELEGRAM_WEBHOOK_SECRET')}":
            return Response("Not found", status=404)
        if str(request.method).upper() != "POST":
            return Response("Method not allowed", status=405)
        try:
            update = await request.json()
            if hasattr(update, "to_py"):
                update = update.to_py()
            msg = update.get("message") or {}
            text = msg.get("text")
            chat_id = str((msg.get("chat") or {}).get("id", ""))
            if not text:
                return Response("ok")
            if chat_id != env_value(self.env, "TELEGRAM_ALLOWED_CHAT_ID"):
                await send_message(self.env, "Unauthorized chat. This bot is locked to its owner.", chat_id)
                return Response("ok")
            await handle_command(self.env, text.strip())
        except Exception as exc:
            await log_event(self.env, "python_worker_error", {"message": str(exc)})
            await send_message(self.env, f"Python Worker warning: {exc}")
        return Response("ok")

    async def scheduled(self, controller, env, ctx):
        ctx.waitUntil(trade_loop(env, False))
