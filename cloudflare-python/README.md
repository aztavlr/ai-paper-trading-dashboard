# Cloudflare Python Worker Bot

This is the Python Worker migration of the Telegram paper trading automation bot.

It uses the same Worker name as the current deployment:

```text
ai-paper-trading-telegram-bot
```

That means existing Cloudflare Worker secrets and the current `workers.dev` URL are reused when it deploys successfully.

## Deploy

Cloudflare Python Workers are currently a beta toolchain. Try the normal Wrangler deploy first:

```powershell
cd "C:\Users\Danny\Documents\Codex\2026-05-17\files-mentioned-by-the-user-telegram\cloudflare-python"
npx.cmd wrangler deploy
```

If Cloudflare asks for Python Worker tooling, follow Cloudflare's Python Worker docs and deploy with `pywrangler`.

## Telegram Commands

- `/auto_on` or `/start_trading`
- `/auto_off` or `/stop_trading`
- `/scan_now`
- `/paper_buy AAPL`
- `/force_buy AAPL`
- `/explain AAPL`
- `/ai AAPL`
- `/strategy`
- `/settings`
- `/set confidence 78`
- `/status`
- `/positions`
- `/close_all`
- `/cancel_orders`
- `/watch AAPL TSLA SPY`
- `/risk 1`
- `/test`

## Smarter Signal Engine

The Python Worker uses:

- Primary and higher-timeframe candle confirmation
- EMA trend alignment
- RSI, MACD, Bollinger position, VWAP, volume, ATR, support/resistance, and candlestick patterns
- Risk/reward filtering
- Fixed take-profit percent and R-multiple targets
- Max position value cap
- Buying-power-aware position sizing
- Open-order checks so queued orders count against position slots
- Market-open guard so automation does not queue surprise next-session orders
- Safer `/paper_buy` behavior; use `/force_buy` only for intentional paper tests
- Daily loss baseline stored in Supabase

## Free Built-In Review

The bot includes a free `/ai AAPL` review command that runs inside the Worker. It does not call Claude, OpenAI, or any paid external model. It summarizes the setup, main risk, invalidation level, and educational next step from the bot's own indicator engine.

## Rollback

If the Python Worker has a runtime issue, redeploy the working JavaScript Worker:

```powershell
cd "C:\Users\Danny\Documents\Codex\2026-05-17\files-mentioned-by-the-user-telegram\cloudflare"
npx.cmd wrangler deploy
```
