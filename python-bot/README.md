# Python Telegram Paper Trading Bot

This is a Python version of the Telegram paper trading bot. It uses Alpaca Paper Trading only and keeps the same educational/risk-managed behavior as the JavaScript bot.

The current Cloudflare Worker deployment can stay active while you test this. Cloudflare Python Workers exist, but they use the beta Python Workers toolchain, so this folder is the safer Python runtime path for a Python server, VPS, or local testing.

## Setup

1. Install Python 3.11+.
2. Copy `.env.example` to `.env`.
3. Fill in your Telegram and Alpaca Paper secrets.
4. Run:

```powershell
python telegram_paper_bot.py
```

## Commands

- `/auto_on` or `/start_trading` - start paper automation
- `/auto_off` or `/stop_trading` - stop new paper orders
- `/scan_now` - scan now
- `/paper_buy AAPL` - manual risk-sized paper bracket buy
- `/explain AAPL` - explain candle/indicator readout
- `/strategy` - show strategy settings
- `/status` - show account/bot status
- `/positions` - show open paper positions
- `/close_all` - close paper positions and stop automation
- `/watch AAPL TSLA SPY` - replace watchlist
- `/risk 1` - set risk per trade percent
- `/test` - test Alpaca Paper API

## Safety

This is not a guarantee of profitable trading. It scores EMA trend, RSI, MACD, Bollinger Bands, VWAP, volume, ATR volatility, support/resistance, and candlestick patterns, then applies risk guards before sending Alpaca Paper orders.
