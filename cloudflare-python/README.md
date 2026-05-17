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
- `/explain AAPL`
- `/strategy`
- `/status`
- `/positions`
- `/close_all`
- `/watch AAPL TSLA SPY`
- `/risk 1`
- `/test`

## Rollback

If the Python Worker has a runtime issue, redeploy the working JavaScript Worker:

```powershell
cd "C:\Users\Danny\Documents\Codex\2026-05-17\files-mentioned-by-the-user-telegram\cloudflare"
npx.cmd wrangler deploy
```
