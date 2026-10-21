# Katalyst — cross-chain intent settlement for Portaldot

**GenLayer decides, Portaldot settles.** A user states an intent in plain language ("max yield, A-Tier carbon only").
GenLayer validators read it, apply guardrails and agree on a route; the Portaldot vault re-validates that route on-chain
and only then moves funds. Built for the Portaldot Hacker House — **Multi-Chain & Cross-Chain Infra** track
(cross-chain decision layer), with Ecosystem-DApp metrics.

```
Wallet ──depositIntent──▶ KatalystVault (Solidity, Portaldot / pallet-revive)
                               │ IntentDeposited
                               ▼
                     Relayer (Node, read-only API) ──adjudicate_intent──▶ GenLayer solver (Python, consensus)
                               ▲                                                  │ verdict + decision trace + votes
                               └──────────────────────────────────────────────────┘
                               │ executeAdjudicatedIntent (relayer-only, re-validated on-chain)
                               ▼
                     Whitelisted pools (funds split by %)
```

## What makes it different
- **Verifiable AI decisions.** Every verdict ships a decision trace: what was understood from the prompt, and why each pool
  was kept or excluded. The UI also shows the real validator votes and links the GenLayer and Portaldot transactions.
- **Free preview.** `preview_intent` runs the full adjudication via `simulateWriteContract`: users see the route before
  depositing, with nothing stored and nothing at stake.
- **Defence in depth.** Static screen → constrained model → deterministic allocation code → on-chain re-validation.
  The Security lab in the UI fires injection attempts at the live solver and shows them contained.
- **Trustless history and metrics.** Activity and Network pages are computed from vault events, not a database.
- **Runs entirely on Vercel.** The relayer logic also ships as Vercel Functions (`frontend/api/`): the dApp's polling drives
  GenLayer adjudication and on-chain settlement with no separate server (see [DEPLOY.md](DEPLOY.md)). An always-on
  relayer (`relayer/`, Docker) remains available for unattended settlement and exposes a read-only API.

## Layout

```
contracts/evm       KatalystVault.sol  — the deployed vault (Solidity, EVM RPC)   ← primary
contracts/vault     ink! 4.3 version   — built OK, but ~1,000 tPOT to deploy; kept for reference
genlayer            intelligent_vault_solver.py (GenVM Python)
relayer             always-on relayer (optional) + compile/test/deploy scripts (Node ≥ 20)
frontend            Vite + React + Tailwind v4 dApp (MetaMask / EIP-1193) + api/ (serverless relayer for Vercel)
```

## Trust model

| Layer | Guarantee |
| --- | --- |
| `KatalystVault.sol` | Only `relayer` can settle. Percentages must total 100, every pool must be whitelisted, no duplicate legs. A pending intent is **one storage slot**: `keccak256(nonce, user, amount, promptHash)`; the relayer must present exactly those values, so it cannot change the payer, amount or prompt. The commitment is deleted *before* any transfer (replay- and re-entrancy-safe); a failed transfer reverts everything. Depositors can `cancelIntent`; rejected intents are refunded. |
| `genlayer/` | The LLM only *extracts constraints*. Percentages and addresses come from deterministic Python over an embedded pool whitelist, so validators converge under `strict_eq`. Prompts with foreign addresses or override phrases are rejected before any LLM call. |
| `relayer/` | Validates the solver JSON (shape, nonce, sum == 100, address format), simulates every transaction with `staticCall` first. |

### Why so little storage?
PortaldotV3 charges a storage deposit (**0.06 tPOT/byte, 0.15 tPOT/item**) for contract code and storage.
The prompt, route and status therefore live in **events**, not storage.
Measured with `ReviveApi`: deploying the vault costs **≈ 315 tPOT** (≈ 298 for code + ≈ 5.6 per whitelisted pool).

## Run it

```bash
cd relayer && cp .env.example .env && npm install
npm run compile:evm        # solc -> contracts/evm/build/KatalystVault.json
npm run test:evm           # 11 logic tests on an in-process EVM
npm run fund:info          # prints each key's mapped native account — send tPOT THERE
npm run estimate:evm       # balance check + gas/deposit estimate, sends nothing
npm run deploy:evm         # deploy; writes VAULT_CONTRACT_ADDRESS into .env
```

1. **Funding.** EVM keys hold $POT in a *mapped native account* (`fund:info` prints it). Send tPOT to that
   `5…` address, **not** to the `0x…` address. Testnet tokens come from the Portaldot team (no public faucet).
2. **GenLayer solver** — deploy `genlayer/intelligent_vault_solver.py` (constructor arg: `admin_address`) with the
   GenLayer CLI/Studio; set `GENLAYER_CONTRACT_ADDRESS`, `GENLAYER_PRIVATE_KEY` in `relayer/.env`.
3. **Relayer** — `cd relayer && npm start`.
4. **Frontend** — `cd frontend && cp .env.example .env` (set `VITE_VAULT_ADDRESS`), `npm install && npm run dev`.
   MetaMask is switched to / configured for PortaldotV3 (chain 420420777) automatically.

## Notes

- **Demo pools** are three freshly generated addresses (keys in `relayer/.env`, git-ignored) listed in the solver's
  `POOLS`. Replace them with real pool addresses (and `setPoolWhitelisted`) before holding real value.
- Oracle endpoints in the solver (`MARKET_URL`, `CARBON_URL`) are placeholders; on fetch failure the solver falls back
  to the embedded APY/eco table. Feeds can only change APY and tier of known pools, never addresses.
- **Validator counts are real.** The relayer reads the vote map from the GenLayer transaction receipt and serves it
  (with the decision trace and transaction links) through its read-only API; the UI shows exactly that. If the relayer
  has no record for an intent, the UI says "Consensus details unavailable" instead of guessing.
- **Storage-deposit refund.** Settling an intent frees its storage slot, and the chain pays that deposit refund to whoever
  freed it (the relayer), although the depositor paid it. The relayer therefore forwards the refund to the depositor
  (`RELAYER_RETURN_REFUND=true`, default): measured live, ≈3.8 tPOT per intent. Per-intent cost to a user is then
  ≈3.9 tPOT of gas on top of the deposit (was ≈7.7 before). A fixed protocol fee instead would need a contract change
  (redeploy ≈ 315 tPOT).
- `owner` and `relayer` are `immutable` (no storage deposit): rotating the relayer means redeploying.
- Untested against the live chain: end-to-end deposit → GenLayer → settle (needs a funded deployment and a deployed solver).

## License

[MIT](LICENSE)
