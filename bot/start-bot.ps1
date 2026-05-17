$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot\..
node bot/telegram-paper-bot.js
