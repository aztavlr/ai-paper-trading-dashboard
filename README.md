# AI Paper Trading Bot Dashboard

Browser-only paper trading simulator with simulated or live market data, risk controls, stop loss, take profit, trailing stops, Telegram alerts, and optional AI chat.

## Open Locally

Open `index.html` in a browser.

## Features

- Simulated watchlist and technical indicators
- Optional live market data mode
- Public crypto quotes through Binance/Coinbase fallback
- Optional Alpaca market-data keys for live stock/ETF paper prices
- TradingView chart shortcut for visual reference
- Paper Buy, Paper Sell, and Close Selected controls
- Risk-based position sizing
- Stop loss, take profit, trailing stop, max daily loss, max open positions, and cooldown guard
- Open positions table with unrealized P&L
- Session stats with trades, win rate, average win/loss, realized P&L, and max drawdown
- Telegram signal and trade alerts
- Optional Anthropic-powered educational AI chat
- Optional always-on Telegram command bot in `bot/`
- Optional free Cloudflare Worker deployment in `cloudflare/`
- Optional Supabase backend schema in `supabase/`

## Safety Note

This is an educational paper trading simulator. It does not connect to a broker, place real trades, or guarantee trading results.

TradingView widgets/charts are used only as visual references. TradingView does not provide a public data export API for prices or indicators, so paper-trade pricing comes from simulator mode or live quote providers such as Alpaca/Binance/Coinbase.

Live mode labels each symbol as `LIVE`, `STALE`, or `SIM`. New paper entries are blocked for symbols that are not currently using live data, so the app does not silently trade from simulated fallback prices.

## Privacy

The app is static and runs in the browser. It does not store user data on a project server. API keys and Telegram details are session-only by default, and users must explicitly opt in before any remembered value is saved on their own device.

See `PRIVACY.md` for details.

## Always-On Telegram Command Bot

The GitHub Pages website cannot listen to Telegram after the browser tab closes. For start/stop commands without the website open, run the separate Node bot in `bot/`.

See `bot/README.md`.

For a free no-PC deployment, use the Cloudflare Worker version in `cloudflare/`. It uses Telegram webhooks plus scheduled Cloudflare cron checks, so it does not run on your computer. The Worker can use Supabase as a private backend for bot state and event logs.

See `cloudflare/README.md`.
