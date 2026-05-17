$ErrorActionPreference = "Stop"

function Read-Required($label) {
  do {
    $value = Read-Host $label
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }
    Write-Host "Value required." -ForegroundColor Yellow
  } while ($true)
}

function Put-Secret($name, $value) {
  Write-Host "Saving $name to Cloudflare..." -ForegroundColor Cyan
  $value | npx.cmd wrangler secret put $name
}

Write-Host ""
Write-Host "Cloudflare Telegram Paper Bot Setup" -ForegroundColor Green
Write-Host "Paste secrets only into this PowerShell window. They will be saved to Cloudflare Worker Secrets." -ForegroundColor Gray
Write-Host ""

$workerUrl = "https://ai-paper-trading-telegram-bot.danny-ai-paper-bot-2026.workers.dev"
$telegramToken = Read-Required "Telegram bot token from BotFather"
$telegramChatId = Read-Required "Your Telegram chat ID"
$alpacaKey = Read-Required "Alpaca Paper API Key ID"
$alpacaSecret = Read-Required "Alpaca Paper API Secret Key"
$supabaseUrl = Read-Required "Supabase Project URL"
$supabaseServiceKey = Read-Required "Supabase service_role key"
$botOwnerId = Read-Required "Bot owner id, e.g. Danny"

$webhookSecret = [guid]::NewGuid().ToString("N")
Write-Host ""
Write-Host "Generated Telegram webhook secret: $webhookSecret" -ForegroundColor DarkGray
Write-Host ""

Put-Secret "TELEGRAM_BOT_TOKEN" $telegramToken
Put-Secret "TELEGRAM_ALLOWED_CHAT_ID" $telegramChatId
Put-Secret "TELEGRAM_WEBHOOK_SECRET" $webhookSecret
Put-Secret "ALPACA_API_KEY_ID" $alpacaKey
Put-Secret "ALPACA_API_SECRET_KEY" $alpacaSecret
Put-Secret "SUPABASE_URL" $supabaseUrl
Put-Secret "SUPABASE_SERVICE_ROLE_KEY" $supabaseServiceKey
Put-Secret "BOT_OWNER_ID" $botOwnerId

Write-Host ""
Write-Host "Deploying Worker..." -ForegroundColor Cyan
npx.cmd wrangler deploy

Write-Host ""
Write-Host "Setting Telegram webhook..." -ForegroundColor Cyan
$result = Invoke-RestMethod "https://api.telegram.org/bot$telegramToken/setWebhook?url=$workerUrl/webhook/$webhookSecret"
$result | Format-List

Write-Host ""
Write-Host "Done. Test the bot in Telegram with /test and /status." -ForegroundColor Green
Write-Host "Worker URL: $workerUrl" -ForegroundColor Gray
