# Free Cloudflare Worker Telegram Bot

This version runs on Cloudflare Workers, so it does not use your PC/laptop after deployment.

Cloudflare Workers Free includes enough requests for a small private Telegram command bot, cron triggers, and encrypted secrets. Supabase Free is used as the private backend for bot state and event history. The worker uses:

- Telegram webhook for commands
- Cloudflare Cron every 5 minutes for paper-trading checks
- Supabase for bot state and event logs
- Alpaca Paper Trading API only

## What You Need

- Free Cloudflare account
- Free Supabase account
- Node.js installed locally for deployment
- Your Telegram bot token
- Your Telegram chat ID
- Alpaca Paper API key and secret

## Supabase Setup

1. Create a Supabase project.
2. Open Supabase **SQL Editor**.
3. Run the SQL in `../supabase/schema.sql`.
4. Copy your Supabase Project URL and `service_role` key from **Project Settings > API**.

Keep the `service_role` key private. It goes only into Cloudflare Worker secrets, never into GitHub Pages or browser code.

## Cloudflare Setup

From the repo root:

```powershell
cd cloudflare
npm create cloudflare@latest -- --help
npx.cmd wrangler login
```

Add secrets:

```powershell
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler secret put TELEGRAM_ALLOWED_CHAT_ID
npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx.cmd wrangler secret put ALPACA_API_KEY_ID
npx.cmd wrangler secret put ALPACA_API_SECRET_KEY
npx.cmd wrangler secret put SUPABASE_URL
npx.cmd wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx.cmd wrangler secret put BOT_OWNER_ID
```

Use a random secret for `TELEGRAM_WEBHOOK_SECRET`, for example:

```powershell
[guid]::NewGuid().ToString("N")
```

Deploy:

```powershell
npx.cmd wrangler deploy
```

Wrangler prints your worker URL, like:

```text
https://ai-paper-trading-telegram-bot.YOURNAME.workers.dev
```

Set the Telegram webhook:

```powershell
$BOT_TOKEN = "paste_telegram_bot_token_here"
$SECRET = "same_webhook_secret_you_set_above"
$WORKER_URL = "https://ai-paper-trading-telegram-bot.YOURNAME.workers.dev"
Invoke-RestMethod "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=$WORKER_URL/webhook/$SECRET"
```

Then message your Telegram bot:

```text
/test
/status
/start_trading
/scan_now
```

## Commands

- `/start_trading` or `/auto_on` - start paper auto-trading and scan immediately
- `/stop_trading` or `/auto_off` - stop opening new paper trades
- `/scan_now` - scan the watchlist right now
- `/paper_buy AAPL` - manually open a risk-sized paper bracket buy
- `/status`
- `/positions`
- `/close_all`
- `/watch AAPL TSLA SPY`
- `/risk 1`
- `/test`

## Important

This is still an educational paper-trading bot. It is not guaranteed to be profitable. It opens Alpaca paper bracket buy orders only.

Automation works like this:

1. You send `/start_trading` or `/auto_on` in Telegram.
2. The Worker scans immediately, then every 5 minutes through Cloudflare Cron.
3. If the simple RSI/SMA rule says `BUY`, the bot submits an Alpaca Paper bracket buy with stop loss and take profit.
4. Risk guards block new orders when max daily loss, max positions, duplicate positions, cooldowns, or invalid sizing applies.
5. You can stop new orders with `/stop_trading` or close paper positions with `/close_all`.

## Privacy Model

- Public GitHub Pages site: can be used by visitors, but should not contain private API keys.
- Cloudflare Worker: private command and automation layer, protected by a secret webhook URL and your allowed Telegram chat id.
- Supabase: private bot state and event database. Row Level Security is enabled and no public read/write policies are created.
- Alpaca and Telegram secrets: stored as encrypted Cloudflare Worker secrets only.
