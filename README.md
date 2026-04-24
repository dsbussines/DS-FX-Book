# DS FX Book

Full-stack trading journal web app with auth, SQLite persistence, analytics, backtesting, and MT5 webhook ingestion.

## Run

1. Copy `.env.example` to `.env` and set secrets.
2. Install deps:
   - `npm install`
3. Start server:
   - `npm start`
4. Open:
   - `http://localhost:3000`

## MT5 Webhook Security

Webhook endpoint:

- `POST /api/integrations/mt5/webhook`

Required headers:

- `x-mt5-timestamp`: unix epoch ms
- `x-mt5-signature`: hex hmac sha256 of `<timestamp>.<raw_json_body>`
- `x-mt5-event-id`: unique id from MT5 bridge (recommended)

Signature formula:

`HMAC_SHA256(MT5_WEBHOOK_SECRET, timestamp + "." + rawBody)`

Replay protection:

- request timestamp must be within `MT5_WEBHOOK_TOLERANCE_MS`
- duplicate `x-mt5-event-id` is rejected
- if event id missing, server hashes timestamp+body as fallback id

## Example Signed Request (PowerShell)

```powershell
$secret = "replace-with-webhook-secret"
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$eventId = [guid]::NewGuid().ToString()
$body = '{"account":"12345678","platform":"MT5","symbol":"XAUUSD","direction":"buy","pnl":75.25,"note":"Bridge closed trade"}'
$payloadToSign = "$timestamp.$body"
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
$signature = ([System.BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($payloadToSign)))).Replace("-", "").ToLower()

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/integrations/mt5/webhook" `
  -Headers @{
    "x-mt5-timestamp" = "$timestamp"
    "x-mt5-signature" = $signature
    "x-mt5-event-id" = $eventId
    "Content-Type" = "application/json"
  } `
  -Body $body
```

## MT5 Connector Mapping

- User connects an account in the UI (`platform + account`)
- Incoming webhook payload with same `platform + account` is mapped to that user
- If payload contains `symbol`, `direction`, and `pnl`, a trade is inserted automatically
- Webhook logs are available at:
  - `GET /api/integrations/mt5/events` (auth required)
