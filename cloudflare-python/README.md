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
- `/paper_buy BTC/USD`
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
- `/watch AAPL BTC/USD ETH/USD`
- `/risk 1`
- `/set leverage 2`
- `/set fast_scan on`
- `/latency`
- `/crypto_on` or `/crypto_off`
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
- Alpaca crypto market data from `v1beta3/crypto`
- Alpaca crypto spot paper orders using `BTC/USD` style symbols
- Managed crypto exits for stop/target checks on scheduled scans
- Paper-only leverage simulation for crypto risk sizing and liquidation guard
- Crypto source validation across Alpaca, Coinbase Exchange, and Binance Spot
- TradingView chart links in readouts for visual confirmation
- Lower-latency scan mode that reuses position/order snapshots and requests fewer candles

## Crypto And Leverage

Alpaca crypto is spot trading. Alpaca's docs say crypto orders cannot use leverage and are evaluated against `non_marginable_buying_power`.

This Worker therefore does two separate things:

- Sends Alpaca paper crypto spot orders for supported pairs like `BTC/USD` and `ETH/USD`.
- Simulates leverage in the bot's own risk model for education with `/set leverage 2`.

The simulated leverage is not real exchange leverage, does not borrow funds, and should not be treated like a live futures bot.

## Data Accuracy Guard

No bot can guarantee perfect market data. This Worker reduces bad reads by:

- Treating Alpaca as the execution/data source for paper orders.
- Cross-checking crypto prices against Coinbase Exchange and Binance Spot before buying.
- Blocking crypto buys when sources differ by more than `/set data_mismatch 1.25`.
- Showing a TradingView chart link in `/explain BTC/USD` so you can visually confirm the market.

TradingView is used as a visual reference link, not as an unofficial scraped data feed.

## Latency

This bot is designed for low-latency paper automation inside Cloudflare Worker limits, not high-frequency trading. Telegram, REST APIs, broker execution, and Cloudflare scheduling all add delay.

Use:

```text
/latency
/set fast_scan on
```

Fast scan mode reduces repeated broker calls during scans and uses smaller candle windows while keeping enough candles for indicators.

## Free Built-In Review

The bot includes a free `/ai AAPL` review command that runs inside the Worker. It does not call Claude, OpenAI, or any paid external model. It summarizes the setup, main risk, invalidation level, and educational next step from the bot's own indicator engine.

## Local Checks

Run the lightweight regression tests from the repo root:

```powershell
& 'C:\Users\Danny\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' tests\test_worker_logic.py
```

## Rollback

If the Python Worker has a runtime issue, redeploy the working JavaScript Worker:

```powershell
cd "C:\Users\Danny\Documents\Codex\2026-05-17\files-mentioned-by-the-user-telegram\cloudflare"
npx.cmd wrangler deploy
```
