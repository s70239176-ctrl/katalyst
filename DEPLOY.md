# Deploying Katalyst

Two supported modes. **Mode A runs entirely on Vercel**; Mode B is for an always-on host.

| | Mode A — Vercel only (recommended) | Mode B — always-on relayer |
| --- | --- | --- |
| Frontend | Vercel | Vercel |
| Relayer | Vercel Functions in `frontend/api/` | Docker/Node process in `relayer/` |
| Who drives settlement | The user's browser polls `/api/relay` | The daemon polls the chain |
| Settles if nobody has the page open | No (waits until someone opens it, or the user cancels) | Yes |

## Mode A — everything on Vercel

1. Import the GitHub repo in Vercel. **Root Directory:** `frontend`. Framework: Vite (auto-detected).
   `frontend/vercel.json` sets the build, security headers and `maxDuration: 60` for `api/*.ts`.
2. Add environment variables (Production **and** Preview):

**Public (embedded in the browser bundle — addresses and URLs only):**

| Variable | Value |
| --- | --- |
| `VITE_VAULT_ADDRESS` | `0x74fcFD25f70fcB562e09930D92d39d6B4cCFCc71` |
| `VITE_VAULT_DEPLOY_BLOCK` | `124470` |
| `VITE_GENLAYER_CONTRACT` | the deployed solver address |
| `VITE_PORTALDOT_EVM_RPC` | `https://test-evm-rpc-v3.portaldot.dev` |
| `VITE_RELAYER_API` | **leave unset** (unset ⇒ the app uses the same-origin serverless API) |

**Server-only (mark as Sensitive; never prefix with `VITE_`):**

| Variable | Value |
| --- | --- |
| `RELAYER_PRIVATE_KEY` | EVM key of the vault's `relayer`; fund its mapped native account with a little POT for gas |
| `GENLAYER_PRIVATE_KEY` | any GenLayer key (Studionet is gasless) |
| `GENLAYER_CONTRACT_ADDRESS` | the deployed solver (falls back to `VITE_GENLAYER_CONTRACT`) |
| `GENLAYER_CHAIN` | `studionet` |

Optional server-side overrides: `VAULT_CONTRACT_ADDRESS`, `VAULT_DEPLOY_BLOCK`, `PORTALDOT_EVM_RPC` (otherwise the `VITE_*` values are used).

3. Deploy, then open `/api/health`. You want `"ok": true` and `"relayerMatchesVault": true`.
   `false` means `RELAYER_PRIVATE_KEY` is not the account the vault was deployed with as `relayer`.

### How Mode A works

After a deposit the browser polls `GET /api/relay?nonce=N&block=B[&gl=0x…]`. Each call advances the intent by one
idempotent step and is safe to repeat or run concurrently:

1. reads the intent (user, amount, prompt) **from the vault's own event log**; nothing is trusted from the caller;
2. submits it to the GenLayer solver once, then follows that transaction until validators agree;
3. validates the verdict (shape, nonce, sum = 100) and sends the settlement transaction; the vault then re-checks
   the route on-chain (totals, whitelist, commitment) before any funds move;
4. forwards the storage-deposit refund to the depositor when the function's time budget allows.

### Mode A limits to know

- **Time limits.** A settling poll took ≈45 s in testing (consensus finishes on an earlier poll). The function budget is
  52 s of the 60 s `maxDuration`; if little time remains the refund-forwarding step is skipped rather than risked.
  On a Vercel plan with longer function durations, raise `maxDuration` and the budget in `api/relay.ts`.
- **No background work.** Settlement progresses only while someone's page is polling. If the tab is closed mid-way the
  intent stays pending (and cancellable) until it is polled again. For unattended settlement use Mode B, or add Vercel
  Cron (Pro plan, per-minute) calling a sweeper.
- **No database.** Consensus details (votes, refund) are cached in each browser's `localStorage`; the verdict itself is
  always recoverable from the GenLayer contract. Add Vercel KV if you need server-side history.
- **Public endpoint.** Anyone can call `/api/relay`, but it only acts on real, pending intents and derives every
  parameter from chain state, so a caller cannot redirect funds or change a route.
- **Rate limits.** Studionet allows roughly 30 requests/min per client; many simultaneous users polling through one
  deployment can hit it. Mode B (single poller) avoids that.

## Several settlement chains

Set `VAULTS` (server, secret-free JSON) and `VITE_CHAINS` (public) to the same list of chains; see
[docs/INTEGRATION.md](docs/INTEGRATION.md#multiple-settlement-chains). The relayer key must be funded on every chain, and each vault must have
been deployed with that key's address as `relayer`. `/api/status` then reports each chain separately.

If you redeploy the GenLayer solver, keep the old addresses in `VITE_GENLAYER_FALLBACKS` so earlier intents still verify.

## Using the v2 vault

Mark the chain entry `"version": 2` in both `VAULTS` (server) and `VITE_CHAINS` (browser; also add `"hub"`), see
`frontend/.env.example`. Points to know:

- **Fund the relayer well.** A settlement reserves about 9 tPOT up front, so a relayer below that gets `Invalid Transaction`.
- **The delay needs polling too.** With a settlement delay the route is *proposed* by one poll and *finalised* by a later one
  after the delay (60 s on the live vault); the dApp keeps polling and shows a countdown. Anyone can finalise, and after the
  timeout (1 h on the live vault) anyone can refund, so a stalled intent never traps funds.
- **Run the guardian** while `delay > 0`: `npm --prefix relayer run guardian -- --veto --loop 20`. It needs the vault owner's key
  (`DEPLOYER_PRIVATE_KEY`, or `GUARDIAN_PRIVATE_KEY`) and vetoes any proposal that differs from the validators' verdict.

## Widget

`npm run build` also emits `dist/widget/katalyst-widget.js` (the `<katalyst-preview>` web component) and `dist/widget-demo.html`.

## Mode B — always-on relayer

Vercel cannot run a long-lived process, so host `relayer/` elsewhere (Railway, Render, Fly.io, a VPS) with the
included `Dockerfile`, or `npm ci && npm run build && npm run start:prod`.

| Variable | Value |
| --- | --- |
| `PORTALDOT_EVM_RPC` / `PORTALDOT_CHAIN_ID` | `https://test-evm-rpc-v3.portaldot.dev` / `420420777` |
| `VAULT_CONTRACT_ADDRESS` | the deployed vault |
| `RELAYER_PRIVATE_KEY` | vault relayer key |
| `GENLAYER_CHAIN` / `GENLAYER_CONTRACT_ADDRESS` / `GENLAYER_PRIVATE_KEY` | `studionet` / solver / any key |
| `PORT` | provided by the host |

Mount a persistent volume at `/app/data` (verdict history) and expose the API over HTTPS. Then set
`VITE_RELAYER_API=https://<your-relayer-host>` on Vercel; the app switches to daemon mode automatically.

## Local development

- `npm run dev` in `frontend/` serves the app; with `VITE_RELAYER_API` unset it also serves `api/*.ts` locally, so
  Mode A can be tested without the Vercel CLI (start Vite with the server-only variables in the environment, e.g.
  `node --env-file=../relayer/.env node_modules/vite/bin/vite.js`).

## Updating contracts

A new vault or solver means new addresses: update the Vercel env (and the relayer's, in Mode B) and redeploy, and set
`VITE_VAULT_DEPLOY_BLOCK` to the new deployment block so history scans stay short.
