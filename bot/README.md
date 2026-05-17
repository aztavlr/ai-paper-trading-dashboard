# Telegram Paper Trading Command Bot

This is a separate always-on process for Telegram commands. It keeps working when the GitHub Pages website is closed, as long as this process is running on your PC or a server.

It is forced to use Alpaca's paper trading API domain:

`https://paper-api.alpaca.markets`

It does not use live-trading endpoints.

## Setup

1. Copy `bot/.env.example` to `bot/.env`.
2. Fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_CHAT_ID`
   - `ALPACA_API_KEY_ID`
   - `ALPACA_API_SECRET_KEY`
3. Run:

```powershell
node bot/telegram-paper-bot.js
```

Or on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File bot/start-bot.ps1
```

Keep that terminal open. If it closes, the bot stops listening.

## Telegram Commands

- `/start_trading` or `/auto_on` - start paper auto-trading and scan immediately
- `/stop_trading` or `/auto_off` - stop opening new paper trades
- `/scan_now` - scan the watchlist right now
- `/paper_buy AAPL` - manually open a risk-sized paper bracket buy
- `/status` - show bot/account status
- `/positions` - list open paper positions
- `/close_all` - close all open paper positions and stop trading
- `/watch AAPL TSLA SPY` - replace watchlist
- `/risk 1` - set risk per trade percent
- `/test` - test Alpaca Paper API

## Safety

This bot opens paper bracket buy orders only. It uses a simple educational RSI/SMA signal and should not be treated as a profitable trading system.

Automation starts only after you send `/start_trading` or `/auto_on` in Telegram. It checks the watchlist on the configured interval and applies max daily loss, max open positions, duplicate-position, cooldown, stop-loss, and take-profit rules.

Do not commit `bot/.env`.
