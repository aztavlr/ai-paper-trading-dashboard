# Privacy Notes

This project is a static browser app. It has no backend server controlled by this repository.

## What Stays Local

- Simulated paper trades
- Risk settings
- Telegram token and chat id form fields
- Anthropic API key form field

The Anthropic key is session-only by default. It is saved to this browser's local storage only when the user explicitly enables "Remember AI key on this device."

## What Leaves the Browser

- Telegram alerts are sent to Telegram only when the user clicks test alert or enables auto-alerts.
- AI chat messages and the Anthropic API key are sent to Anthropic only when the user uses AI chat.
- No real broker orders are placed by this app.

## Repository Safety

Do not commit API keys, bot tokens, account numbers, secrets, screenshots containing keys, or broker credentials.
