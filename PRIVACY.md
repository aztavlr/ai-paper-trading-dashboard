# Privacy Notes

This project is a static browser app. It has no backend server controlled by this repository.

## What Stays Local

- Simulated paper trades
- Risk settings
- Telegram token and chat id form fields
- Anthropic API key form field
- Alpaca API key and secret form fields
- Telegram bot token and chat id form fields

Keys and tokens are session-only by default. They are saved to this browser's local storage only when the user explicitly enables a "Remember ... on this device" checkbox.

Remembered values are not uploaded to GitHub or to a project server. They can still be accessed by someone who has access to the same browser profile or device, so use them only on a trusted personal device.

## What Leaves the Browser

- Telegram alerts are sent to Telegram only when the user clicks test alert or enables auto-alerts.
- AI chat messages and the Anthropic API key are sent to Anthropic only when the user uses AI chat.
- Alpaca market-data requests send the Alpaca key and secret directly to Alpaca only when live stock/ETF data mode is enabled.
- Public crypto quote requests may be sent to Binance or Coinbase when live data mode is enabled.
- TradingView opens in a new tab only when the user clicks the TradingView button.
- No real broker orders are placed by this app.

## Repository Safety

Do not commit API keys, bot tokens, account numbers, secrets, screenshots containing keys, or broker credentials.

## Telegram Command Bot

The optional always-on Telegram command bot uses `bot/.env` for secrets. That file is ignored by Git and should stay only on the trusted device or server running the bot.

The optional Cloudflare Worker deployment stores secrets in Cloudflare Worker Secrets and stores bot state/event logs in Supabase. The Supabase service-role key must stay only in Cloudflare Worker Secrets. Do not put real secrets in `cloudflare/wrangler.toml`, GitHub Pages, browser code, screenshots, or commits.
