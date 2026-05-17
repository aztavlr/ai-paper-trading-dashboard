# Free Cloudflare Worker Telegram Bot

This version runs on Cloudflare Workers, so it does not use your PC/laptop after deployment.

Cloudflare Workers Free includes enough requests for a small private Telegram command bot, cron triggers, and encrypted secrets. The worker uses:

- Telegram webhook for commands
- Cloudflare Cron every 5 minutes for paper-trading checks
- Cloudflare KV for bot state
- Alpaca Paper Trading API only

## What You Need

- Free Cloudflare account
- Node.js installed locally for deployment
- Your Telegram bot token
- Your Telegram chat ID
- Alpaca Paper API key and secret

## Setup

From the repo root:

```powershell
cd cloudflare
npm create cloudflare@latest -- --help
npm install -g wrangler
wrangler login
```

Create a free KV namespace:

```powershell
wrangler kv namespace create STATE
```

Copy the printed `id` into `cloudflare/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "paste_id_here"
```

Add secrets:

```powershell
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_ALLOWED_CHAT_ID
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put ALPACA_API_KEY_ID
wrangler secret put ALPACA_API_SECRET_KEY
```

Use a random secret for `TELEGRAM_WEBHOOK_SECRET`, for example:

```powershell
[guid]::NewGuid().ToString("N")
```

Deploy:

```powershell
wrangler deploy
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
```

## Commands

- `/start_trading`
- `/stop_trading`
- `/status`
- `/positions`
- `/close_all`
- `/watch AAPL TSLA SPY`
- `/risk 1`
- `/test`

## Important

This is still an educational paper-trading bot. It is not guaranteed to be profitable. It opens Alpaca paper bracket buy orders only.
