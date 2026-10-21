# Observability and alerts

Katalyst exposes the same operational signals in both relayer modes.

## Status and metrics

| Mode | Endpoint | Purpose |
| --- | --- | --- |
| Serverless | `GET /api/status` | JSON checks. **HTTP 200 healthy, 503 unhealthy**, so `curl -f` or an uptime monitor can alert |
| Serverless | `GET /api/metrics` | Prometheus text, computed from chain state at scrape time |
| Serverless | `GET /api/health` | Relayer identity, key-matches-vault flag, balance |
| Daemon | `GET /health`, `/stats`, `/metrics` | Process health, aggregate stats, Prometheus text |

`/api/status` checks:

- **Portaldot RPC** reachable and fast
- **GenLayer solver** reachable
- **Relayer key** is the vault's configured `relayer` (catches a wrong `RELAYER_PRIVATE_KEY`)
- **Relayer gas balance** above `STATUS_MIN_BALANCE_TPOT` (default 2)
- **Pending intents**: fails when the oldest pending intent is older than `STATUS_STUCK_MINUTES` (default 15).
  This is the key signal in serverless mode, where settlement only advances while a page is polling.

Tunables (server env): `STATUS_MIN_BALANCE_TPOT`, `STATUS_STUCK_MINUTES`, `STATUS_WINDOW_BLOCKS` (default 3000).

Prometheus series: `katalyst_up`, `katalyst_portaldot_head_block`, `katalyst_portaldot_latency_ms`,
`katalyst_genlayer_latency_ms`, `katalyst_relayer_balance_tpot`, `katalyst_intents_total`, `katalyst_intents_pending`,
`katalyst_oldest_pending_minutes`, `katalyst_check{id,level}` (serverless), plus queue/uptime/last-settlement series
(daemon). Example alert: `katalyst_oldest_pending_minutes > 15`.

The Network page of the dApp renders the same checks.

## Free uptime alerts (GitHub Actions)

`.github/workflows/uptime.yml` polls `/api/status` every 15 minutes and fails the run (GitHub emails maintainers) when
anything is red. Set:

- Repository **variable** `STATUS_URL` = `https://<your-app>.vercel.app/api/status`
- Optional repository **secret** `NOTIFY_WEBHOOK_URL` for an immediate chat message

## Notifications

Set any of these (Vercel server env, or the daemon's env) to get a message when an intent settles, is rejected, or fails:

| Variable | Notes |
| --- | --- |
| `NOTIFY_WEBHOOK_URL` | Generic JSON POST with `{text, content}`; works with Slack and Discord incoming webhooks |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram Bot API |

Messages contain the intent number, amount, route, validator agreement and a block link. They do **not** include the
prompt or the depositor's address. Delivery failures are logged and never block settlement.

Users can also tick **Notify me when it settles** on a pending intent for a browser notification.
