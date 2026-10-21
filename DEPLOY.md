# Deploying Katalyst

Two pieces run separately:

| Piece | Where | Why |
| --- | --- | --- |
| **Frontend** (`frontend/`) | **Vercel** | Static Vite app. |
| **Relayer** (`relayer/`) | An always-on host (Railway, Render, Fly.io, a VPS) | It polls the chain and signs settlements continuously. Vercel functions are short-lived and cannot run it. |

Without a running relayer the dApp loads and previews verdicts, but **deposited intents are never settled** (users can
cancel for a refund). Deploy the relayer first, then point the frontend at it.

## 1. Relayer (always-on host)

Build from `relayer/` with the included `Dockerfile` (Railway/Render/Fly detect it), or run `npm ci && npm run build && npm run start:prod`.

Set these environment variables on the host (never commit them):

| Variable | Value |
| --- | --- |
| `PORTALDOT_EVM_RPC` | `https://test-evm-rpc-v3.portaldot.dev` |
| `PORTALDOT_CHAIN_ID` | `420420777` |
| `VAULT_CONTRACT_ADDRESS` | the deployed vault (`0x74fc…Cc71` on testnet) |
| `RELAYER_PRIVATE_KEY` | EVM key of the vault's `relayer`; fund its mapped native account |
| `GENLAYER_CHAIN` | `studionet` |
| `GENLAYER_CONTRACT_ADDRESS` | the deployed solver |
| `GENLAYER_PRIVATE_KEY` | any funded-or-gasless GenLayer key |
| `PORT` | provided by the host (the API listens on `RELAYER_API_PORT`, then `PORT`, then 8788) |

Mount a persistent volume at `/app/data` (verdict history). The host must expose the API over **HTTPS**; note the public
URL (e.g. `https://katalyst-relayer.up.railway.app`). Check `GET /health` returns `{"ok":true,...}`.

## 2. Frontend on Vercel

1. Import the GitHub repo in Vercel.
2. **Root Directory:** `frontend`. Framework preset: Vite (auto-detected; `frontend/vercel.json` sets the build and headers).
3. Add environment variables (Production and Preview):

| Variable | Value |
| --- | --- |
| `VITE_VAULT_ADDRESS` | `0x74fcFD25f70fcB562e09930D92d39d6B4cCFCc71` |
| `VITE_VAULT_DEPLOY_BLOCK` | `124470` |
| `VITE_GENLAYER_CONTRACT` | the deployed solver address |
| `VITE_RELAYER_API` | the relayer's public **https** URL (required in production; no `localhost` fallback) |
| `VITE_PORTALDOT_EVM_RPC` | `https://test-evm-rpc-v3.portaldot.dev` |

4. Deploy. Routing is hash-based (`/#/activity`), so no rewrite rules are needed.

`VITE_*` values are embedded in the public bundle: put only public addresses and URLs there, never keys.

## Updating contracts

A new vault or solver means new addresses: update the relayer's env **and** the Vercel env (then redeploy), and
set `VITE_VAULT_DEPLOY_BLOCK` to the new deployment block so history scans stay short.
