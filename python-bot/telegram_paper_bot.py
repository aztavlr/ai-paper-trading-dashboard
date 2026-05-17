#!/usr/bin/env python3
"""Telegram-controlled Alpaca paper trading bot.

This is paper trading only. It never uses Alpaca live-trading endpoints.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
ALPACA_PAPER_API = "https://paper-api.alpaca.markets"
ALPACA_DATA_API = "https://data.alpaca.markets"


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


load_env(ROOT / ".env")


CFG = {
    "telegram_token": os.getenv("TELEGRAM_BOT_TOKEN", ""),
    "allowed_chat_id": os.getenv("TELEGRAM_ALLOWED_CHAT_ID", ""),
    "alpaca_key": os.getenv("ALPACA_API_KEY_ID", ""),
    "alpaca_secret": os.getenv("ALPACA_API_SECRET_KEY", ""),
    "poll_ms": float(os.getenv("POLL_INTERVAL_MS", "2500")),
    "trade_ms": float(os.getenv("TRADE_INTERVAL_MS", "60000")),
    "risk_pct": float(os.getenv("RISK_PER_TRADE_PCT", "1")),
    "stop_pct": float(os.getenv("STOP_LOSS_PCT", "2")),
    "take_profit_pct": float(os.getenv("TAKE_PROFIT_PCT", "4")),
    "max_positions": int(float(os.getenv("MAX_OPEN_POSITIONS", "3"))),
    "max_daily_loss_pct": float(os.getenv("MAX_DAILY_LOSS_PCT", "3")),
    "min_confidence": float(os.getenv("MIN_CONFIDENCE", "72")),
    "timeframe": os.getenv("BAR_TIMEFRAME", "5Min"),
    "atr_stop_multiplier": float(os.getenv("ATR_STOP_MULTIPLIER", "1.5")),
    "take_profit_r": float(os.getenv("TAKE_PROFIT_R_MULTIPLIER", "2")),
    "watchlist": [s.strip().upper() for s in os.getenv("WATCHLIST", "AAPL,TSLA,NVDA,MSFT,SPY").split(",") if s.strip()],
}

TELEGRAM_API = f"https://api.telegram.org/bot{CFG['telegram_token']}"
offset = 0
trading_enabled = False
last_trade_at = 0.0
cooldowns: dict[str, float] = {}


def request_json(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req_headers = {"content-type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"message": text}
        raise RuntimeError(payload.get("message") or payload.get("error") or payload.get("description") or f"HTTP {exc.code}") from exc
    payload = json.loads(text) if text else {}
    if payload.get("ok") is False:
        raise RuntimeError(payload.get("description") or "Telegram API error")
    return payload


def alpaca_headers() -> dict:
    return {
        "APCA-API-KEY-ID": CFG["alpaca_key"],
        "APCA-API-SECRET-KEY": CFG["alpaca_secret"],
        "content-type": "application/json",
    }


def alpaca(pathname: str, method: str = "GET", body: dict | None = None) -> dict:
    return request_json(f"{ALPACA_PAPER_API}{pathname}", method=method, body=body, headers=alpaca_headers())


def alpaca_data(pathname: str) -> dict:
    return request_json(f"{ALPACA_DATA_API}{pathname}", headers=alpaca_headers())


def tg(method: str, body: dict) -> dict:
    return request_json(f"{TELEGRAM_API}/{method}", method="POST", body=body)


def send_message(text: str, chat_id: str | None = None) -> None:
    tg("sendMessage", {"chat_id": chat_id or CFG["allowed_chat_id"], "text": text, "disable_web_page_preview": True})


def money(value: float) -> str:
    return f"${value:.2f}" if math.isfinite(value) else "$0.00"


def normalize_symbol(value: str | None) -> str:
    return re.sub(r"[^A-Z.]", "", (value or "").upper())[:12]


def round_price(value: float) -> float:
    return round(value, 2 if value >= 1 else 4)


def fetch_account() -> dict:
    return alpaca("/v2/account")


def fetch_positions() -> list[dict]:
    data = alpaca("/v2/positions")
    return data if isinstance(data, list) else []


def fetch_bars(symbol: str, timeframe: str = "5Min", limit: int = 160) -> list[dict]:
    qs = urllib.parse.urlencode({"symbols": symbol, "timeframe": timeframe, "limit": str(limit), "feed": "iex", "adjustment": "raw"})
    data = alpaca_data(f"/v2/stocks/bars?{qs}")
    rows = data.get("bars", {}).get(symbol, [])
    bars = []
    for row in rows:
        try:
            bars.append({"o": float(row["o"]), "h": float(row["h"]), "l": float(row["l"]), "c": float(row["c"]), "v": float(row.get("v", 0))})
        except (KeyError, TypeError, ValueError):
            pass
    return bars


def sma(values: list[float], period: int) -> float:
    if not values:
        return 0.0
    chunk = values[-period:]
    return sum(chunk) / len(chunk)


def ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2 / (period + 1)
    ema = values[0]
    out = []
    for value in values:
        ema = value * k + ema * (1 - k)
        out.append(ema)
    return out


def calc_rsi(values: list[float], period: int = 14) -> float:
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


def calc_macd(values: list[float]) -> tuple[float, float]:
    ema12 = ema_series(values, 12)
    ema26 = ema_series(values, 26)
    macd = [(ema12[i] if i < len(ema12) else values[i]) - (ema26[i] if i < len(ema26) else values[i]) for i in range(len(values))]
    signal = ema_series(macd, 9)
    hist = macd[-1] - signal[-1]
    prev_hist = macd[-2] - signal[-2] if len(macd) > 1 and len(signal) > 1 else hist
    return hist, prev_hist


def calc_atr(bars: list[dict], period: int = 14) -> float:
    if len(bars) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(bars)):
        prev_close = bars[i - 1]["c"]
        trs.append(max(bars[i]["h"] - bars[i]["l"], abs(bars[i]["h"] - prev_close), abs(bars[i]["l"] - prev_close)))
    return sma(trs[-period:], period)


def calc_bollinger(values: list[float], period: int = 20) -> tuple[float, float, float]:
    chunk = values[-period:]
    mid = sma(chunk, len(chunk))
    variance = sum((value - mid) ** 2 for value in chunk) / max(len(chunk), 1)
    sd = math.sqrt(variance)
    return mid + sd * 2, mid - sd * 2, (sd * 4 / mid) * 100 if mid else 0.0


def calc_vwap(bars: list[dict]) -> float:
    pv = vol = 0.0
    for bar in bars:
        typical = (bar["h"] + bar["l"] + bar["c"]) / 3
        pv += typical * bar["v"]
        vol += bar["v"]
    return pv / vol if vol else (bars[-1]["c"] if bars else 0.0)


def candle_pattern(bars: list[dict]) -> dict | None:
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


def analyze_bars(bars: list[dict]) -> dict:
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
    stop_distance = max(atr * CFG["atr_stop_multiplier"], price * CFG["stop_pct"] / 100)
    stop = round_price(price - stop_distance)
    target = round_price(price + stop_distance * CFG["take_profit_r"])
    action = "BUY" if confidence >= CFG["min_confidence"] and not trend_down else "HOLD"
    return {
        "action": action, "confidence": confidence, "price": price, "stop": stop, "target": target,
        "atr": atr, "rsi": rsi, "macd_hist": macd_hist, "trend": "up" if trend_up else "down" if trend_down else "mixed",
        "pattern": pattern["name"] if pattern else "", "reasons": reasons,
    }


def position_size(equity: float, price: float, stop_price: float | None = None) -> int:
    risk_dollars = equity * CFG["risk_pct"] / 100
    risk_per_share = abs(price - stop_price) if stop_price else price * CFG["stop_pct"] / 100
    return max(0, math.floor(risk_dollars / risk_per_share))


def submit_bracket_buy(symbol: str, qty: int, analysis: dict) -> dict:
    body = {
        "symbol": symbol, "qty": str(qty), "side": "buy", "type": "market", "time_in_force": "day",
        "order_class": "bracket",
        "take_profit": {"limit_price": analysis["target"]},
        "stop_loss": {"stop_price": analysis["stop"]},
    }
    return alpaca("/v2/orders", method="POST", body=body)


def strategy_text() -> str:
    return "\n".join([
        "Advanced Python paper strategy:",
        f"Timeframe: {CFG['timeframe']}",
        f"Minimum confidence: {CFG['min_confidence']}%",
        f"Risk per trade: {CFG['risk_pct']}%",
        f"ATR stop multiplier: {CFG['atr_stop_multiplier']}x",
        f"Take profit: {CFG['take_profit_r']}R",
        "Reads: EMA trend, RSI, MACD, Bollinger position, VWAP, volume, ATR volatility, support/resistance, and candlestick patterns.",
        "Still educational paper trading only. No method is 100% accurate.",
    ])


def help_text() -> str:
    return "\n".join([
        "Commands:",
        "/auto_on or /start_trading - turn paper auto-trading on",
        "/auto_off or /stop_trading - stop opening new paper trades",
        "/scan_now - check the watchlist right now",
        "/paper_buy AAPL - manually open a risk-sized paper bracket buy",
        "/explain AAPL - show candle/indicator readout",
        "/strategy - show settings",
        "/status - show bot/account status",
        "/positions - list open paper positions",
        "/close_all - close paper positions",
        "/watch AAPL TSLA SPY - replace watchlist",
        "/risk 1 - set risk per trade percent",
        "/test - test Alpaca Paper API",
    ])


def status_text() -> str:
    account = fetch_account()
    positions = fetch_positions()
    return "\n".join([
        f"Paper auto-trading: {'ON' if trading_enabled else 'OFF'}",
        f"Equity: {money(float(account.get('equity') or 0))}",
        f"Buying power: {money(float(account.get('buying_power') or 0))}",
        f"Open positions: {len(positions)}/{CFG['max_positions']}",
        f"Watchlist: {', '.join(CFG['watchlist'])}",
        f"Strategy: {CFG['timeframe']} candles, min confidence {CFG['min_confidence']}%",
        f"Last trade: {time.ctime(last_trade_at) if last_trade_at else 'none'}",
    ])


def positions_text() -> str:
    positions = fetch_positions()
    if not positions:
        return "No open paper positions."
    return "\n".join(f"{p.get('symbol')}: {p.get('qty')} @ {money(float(p.get('avg_entry_price') or 0))} | P&L {money(float(p.get('unrealized_pl') or 0))}" for p in positions)


def close_all_positions() -> None:
    global trading_enabled
    positions = fetch_positions()
    if not positions:
        send_message("No open paper positions to close.")
        return
    alpaca("/v2/positions", method="DELETE")
    trading_enabled = False
    send_message("Close-all request sent. Auto-trading is now OFF.")


def explain_symbol(raw_symbol: str | None) -> None:
    symbol = normalize_symbol(raw_symbol)
    if not symbol:
        send_message("Usage: /explain AAPL")
        return
    analysis = analyze_bars(fetch_bars(symbol, CFG["timeframe"], 160))
    if not analysis["price"]:
        send_message(f"No candle data available for {symbol}.")
        return
    send_message("\n".join([
        f"{symbol} Python readout ({CFG['timeframe']})",
        f"Action: {analysis['action']}",
        f"Confidence: {analysis['confidence']}% / required {CFG['min_confidence']}%",
        f"Price: {money(analysis['price'])}",
        f"RSI: {analysis['rsi']:.1f} | MACD hist: {analysis['macd_hist']:.3f}",
        f"Trend: {analysis['trend']}",
        f"ATR: {money(analysis['atr'])} | Stop: {money(analysis['stop'])} | Target: {money(analysis['target'])}",
        f"Pattern: {analysis['pattern'] or 'none'}",
        f"Why: {'; '.join(analysis['reasons'])}",
    ]))


def manual_paper_buy(raw_symbol: str | None) -> None:
    global last_trade_at
    symbol = normalize_symbol(raw_symbol)
    if not symbol:
        send_message("Usage: /paper_buy AAPL")
        return
    account = fetch_account()
    equity = float(account.get("equity") or account.get("portfolio_value") or 0)
    open_positions = fetch_positions()
    if len(open_positions) >= CFG["max_positions"]:
        send_message(f"Risk guard blocked {symbol}: max positions reached.")
        return
    if any(p.get("symbol") == symbol for p in open_positions):
        send_message(f"Risk guard blocked {symbol}: position already open.")
        return
    if cooldowns.get(symbol, 0) > time.time():
        send_message(f"Risk guard blocked {symbol}: cooldown is active.")
        return
    analysis = analyze_bars(fetch_bars(symbol, CFG["timeframe"], 160))
    qty = position_size(equity, analysis["price"], analysis.get("stop"))
    if qty < 1:
        send_message(f"Risk sizing blocked {symbol}: quantity below 1 share.")
        return
    order = submit_bracket_buy(symbol, qty, analysis)
    last_trade_at = time.time()
    cooldowns[symbol] = time.time() + CFG["trade_ms"] / 1000 * 3
    send_message(f"Manual paper BUY submitted: {symbol}\nConfidence: {analysis['confidence']}%\nQty: {qty}\nEntry ref: {money(analysis['price'])}\nStop: {money(analysis['stop'])}\nTarget: {money(analysis['target'])}\nWhy: {'; '.join(analysis['reasons'][:4])}\nOrder: {order.get('id', 'submitted')}")


def trade_loop(notify: bool = False) -> None:
    global trading_enabled, last_trade_at
    if not trading_enabled and not notify:
        return
    account = fetch_account()
    equity = float(account.get("equity") or account.get("portfolio_value") or 0)
    daily_loss = float(account.get("equity") or 0) - float(account.get("last_equity") or account.get("equity") or 0)
    if daily_loss <= -(equity * CFG["max_daily_loss_pct"] / 100):
        trading_enabled = False
        send_message(f"Daily loss guard triggered ({money(daily_loss)}). Auto-trading stopped.")
        return
    summary = {"scanned": 0, "warmup": 0, "hold": 0, "low": 0, "blocked": 0, "orders": 0}
    for symbol in CFG["watchlist"]:
        summary["scanned"] += 1
        positions = fetch_positions()
        if len(positions) >= CFG["max_positions"]:
            summary["blocked"] += 1; break
        if any(p.get("symbol") == symbol for p in positions) or cooldowns.get(symbol, 0) > time.time():
            summary["blocked"] += 1; continue
        analysis = analyze_bars(fetch_bars(symbol, CFG["timeframe"], 160))
        if analysis["action"] == "WARMUP":
            summary["warmup"] += 1; continue
        if analysis["action"] != "BUY":
            summary["hold"] += 1; continue
        if analysis["confidence"] < CFG["min_confidence"]:
            summary["low"] += 1; continue
        if not trading_enabled:
            summary["blocked"] += 1; continue
        qty = position_size(equity, analysis["price"], analysis["stop"])
        if qty < 1:
            summary["blocked"] += 1; continue
        order = submit_bracket_buy(symbol, qty, analysis)
        last_trade_at = time.time()
        cooldowns[symbol] = time.time() + CFG["trade_ms"] / 1000 * 3
        summary["orders"] += 1
        send_message(f"Paper BUY submitted: {symbol}\nConfidence: {analysis['confidence']}%\nQty: {qty}\nEntry ref: {money(analysis['price'])}\nStop: {money(analysis['stop'])}\nTarget: {money(analysis['target'])}\nWhy: {'; '.join(analysis['reasons'][:4])}\nOrder: {order.get('id', 'submitted')}")
    if notify and summary["orders"] == 0:
        send_message(f"Scan complete. No paper orders opened.\nScanned: {summary['scanned']}\nWarmup: {summary['warmup']}\nHold: {summary['hold']}\nLow confidence: {summary['low']}\nBlocked: {summary['blocked']}")


def update_watchlist(symbols: list[str]) -> None:
    next_symbols = [normalize_symbol(s) for s in symbols]
    next_symbols = [s for s in next_symbols if s][:12]
    if not next_symbols:
        send_message(f"Current watchlist: {', '.join(CFG['watchlist'])}")
        return
    CFG["watchlist"] = next_symbols
    send_message(f"Watchlist updated: {', '.join(CFG['watchlist'])}")


def update_risk(value: str | None) -> None:
    try:
        risk = float(value or "")
    except ValueError:
        risk = 0
    if risk <= 0 or risk > 5:
        send_message("Use /risk with a value from 0.1 to 5. Example: /risk 1")
        return
    CFG["risk_pct"] = risk
    send_message(f"Risk per paper trade set to {risk}%.")


def handle_command(text: str) -> None:
    global trading_enabled
    parts = text.split()
    cmd = parts[0].lower()
    rest = parts[1:]
    if cmd in {"/start", "/help"}:
        send_message(help_text())
    elif cmd in {"/start_trading", "/starttrading", "/auto_on"}:
        trading_enabled = True
        send_message("Python paper auto-trading is ON.")
        trade_loop(True)
    elif cmd in {"/stop_trading", "/stoptrading", "/auto_off"}:
        trading_enabled = False
        send_message("Python paper auto-trading is OFF.")
    elif cmd == "/scan_now":
        trade_loop(True)
    elif cmd in {"/paper_buy", "/buy"}:
        manual_paper_buy(rest[0] if rest else None)
    elif cmd == "/explain":
        explain_symbol(rest[0] if rest else None)
    elif cmd == "/strategy":
        send_message(strategy_text())
    elif cmd == "/status":
        send_message(status_text())
    elif cmd == "/positions":
        send_message(positions_text())
    elif cmd == "/close_all":
        close_all_positions()
    elif cmd == "/watch":
        update_watchlist(rest)
    elif cmd == "/risk":
        update_risk(rest[0] if rest else None)
    elif cmd == "/test":
        fetch_account()
        send_message("Alpaca Paper API connection works.")
    else:
        send_message(f"Unknown command.\n\n{help_text()}")


def poll_telegram() -> None:
    global offset
    data = tg("getUpdates", {"offset": offset, "timeout": 20, "allowed_updates": ["message"]})
    for update in data.get("result", []):
        offset = max(offset, int(update["update_id"]) + 1)
        msg = update.get("message") or {}
        text = msg.get("text")
        chat_id = str((msg.get("chat") or {}).get("id", ""))
        if not text:
            continue
        if chat_id != str(CFG["allowed_chat_id"]):
            send_message("Unauthorized chat. This bot is locked to its owner.", chat_id)
            continue
        try:
            handle_command(text.strip())
        except Exception as exc:  # noqa: BLE001 - send operational failures to Telegram.
            send_message(f"Bot warning: {exc}")


def validate_config() -> None:
    missing = [key for key in ("telegram_token", "allowed_chat_id", "alpaca_key", "alpaca_secret") if not CFG[key]]
    if missing:
        raise RuntimeError(f"Missing required .env values: {', '.join(missing)}")


def main() -> None:
    validate_config()
    print("Python Telegram paper bot starting. Paper trading only.")
    print(f"Watchlist: {', '.join(CFG['watchlist'])}")
    send_message(f"Python paper trading command bot is online.\n\n{help_text()}")
    next_trade = time.time() + CFG["trade_ms"] / 1000
    while True:
        poll_telegram()
        if time.time() >= next_trade:
            trade_loop(False)
            next_trade = time.time() + CFG["trade_ms"] / 1000
        time.sleep(max(0.5, CFG["poll_ms"] / 1000))


if __name__ == "__main__":
    main()
