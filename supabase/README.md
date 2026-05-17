# Supabase Backend Setup

Supabase is used only by the Cloudflare Worker. Do not put the Supabase service-role key in the website, GitHub Pages, or browser local storage.

## Free Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste and run [`schema.sql`](schema.sql).
4. Open **Project Settings > API**.
5. Copy:
   - Project URL
   - `service_role` key

## Cloudflare Secrets

From the `cloudflare` folder, save these as encrypted Worker secrets:

```powershell
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put BOT_OWNER_ID
```

Use a private owner id for `BOT_OWNER_ID`, for example your GitHub username or Telegram chat id. It separates your bot rows from anyone else's if you later expand the project.

## Tables

- `bot_state` stores settings like `RUNNING`, `WATCHLIST`, risk percent, cooldowns, and price history.
- `bot_events` stores command, paper order, and risk guard events.

Row Level Security is enabled and no public policies are added. The Worker uses the service-role key from Cloudflare secrets, so visitors to the public site cannot read or write this backend.
