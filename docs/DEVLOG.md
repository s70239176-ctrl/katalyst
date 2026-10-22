# Development log

A dated record of what was built and decided. The public repository starts on 2026-10-21; work before the first commit was done locally and is summarised under "Before the first public commit".

## Before the first public commit

- **Spec to first build.** Started from an ink! smart-contract design for Portaldot, a GenLayer "intelligent contract" solver (Python) and a relayer. The model only *extracts constraints* from the prompt; allocation is deterministic code, so a prompt cannot name a destination.
- **ink! build and cost.** The ink! contract built, but deploying it was estimated at about 1,001 tPOT because Portaldot charges storage deposit per byte of code and state.
- **Pivot to Solidity.** When Portaldot V3 exposed an Ethereum RPC (pallet-revive), the vault was ported to Solidity, built around one storage slot per pending intent. Deploy cost fell to about 315 tPOT. The ink! version stays in `contracts/vault/` for reference.
- **First live runs (v1 vault).** Approved settlements including a 57/43 split, and a prompt-injection attempt that the solver rejected with an automatic refund.
- **Refund pass-through.** Settling frees the intent's storage slot and the chain refunds that deposit to the transaction sender (the relayer). The relayer forwards it back to the depositor.

## 2026-10-21

| Commit | What |
| --- | --- |
| `2674f0e` `5abfca2` `debc710` | Public repository, Vercel/relayer deployment config, MIT licence |
| `ba175f4` | **Relayer on Vercel**: a stateless, idempotent serverless relay driven by the dApp's polling, so no separate server is needed |
| `1bebe4e` | SDK, CLI, **independent verification** (Verify page and `katalyst verify`), shareable impact receipts, validator-reliability view |
| `4e2e3ff` | Observability (`/api/status`, Prometheus metrics, webhook and Telegram alerts), tests, CI, docs |
| `4a5ce8e` | **Multi-chain settlement** (one solver, several vaults, composite refs), embeddable widget, example consumer, integration docs |
| `4921e9f` | **v2 contracts**: refund after timeout, pause and two-step ownership, relayer rotation, immutable fee and cap, route lock, `PoolHub` positions, settlement delay with owner veto. 11 scenario tests and randomised invariant fuzzing |
| (deploy) | v2 deployed to the testnet for about 626 tPOT: PoolHub `0xE987…997E`, vault `0x786D…dD46` |
| `fb24ab3` | v2 off-chain: serverless relay with proposal then finalise, refund on expiry, route-lock checks; SDK verification for v2; the **guardian** that vetoes any proposal that differs from the validators' verdict |
| `f71755c` | dApp for v2: route-lock toggle, fixed-rules panel, delay countdown, Positions page (withdraw), vault rules on the Network page |
| `d6c33d6` | Same-origin read-only RPC proxy, because the public RPC sometimes answers throttled requests without CORS headers |
| `8b8b89a` `e8dc2ba` | New landing page and a restyle of every app page to one design system |

## 2026-10-22

| Commit | What |
| --- | --- |
| `ece355d` | README roadmap for the next 2 to 3 months |
| `ae5d29f` | Brand: the K mark, favicon set, social card |
| `e7a2c1e` | **Explorer fix.** The Portaldot node console opens on the *live* network by default, so block links opened an unrelated block. Links now point at the testnet node |
| `19e752d` | Demo video tooling, narration and captions |

## Things we learned about Portaldot V3 (worth knowing)

- **Funding.** Each EVM address maps to a native `5…` account (the 20 bytes plus twelve `0xEE` bytes). tPOT must be sent to the *native* address.
- **Gas reservation.** A transaction reserves about 9 tPOT of the sender's balance up front; below that the RPC rejects it as `Invalid Transaction` (code 1010).
- **Storage deposits.** About 0.06 tPOT per byte and 0.15 per item, charged to the transaction origin and refunded to whoever frees the slot. Designing for few, small storage items cut cost by about two thirds.
- **Pruning.** The public RPC prunes old blocks and transactions after a short while (under an hour in our tests), but event logs persist. Anything long-lived (history, verification) is built from events.
- **RPC quirks.** `eth_getLogs` works but filters do not; JSON-RPC batching is unsupported; `eth_getBlockByNumber('latest')` is cached briefly; balances are best read with a raw `eth_getBalance`.
- **Explorer.** EVM block numbers equal native block numbers on the testnet; the node console needs `?rpc=wss://test-node-v3.portaldot.dev` to show them.

## Verification performed

- `npm run test:evm` (11 scenarios) and `npm run fuzz:evm`; `npm run test:v2` (11 scenarios) and `npm run fuzz:v2` (about 1,500 randomised steps against an oracle model, both with and without the settlement delay).
- `npm run test:solver` (31 solver and example tests, with a GenVM stub).
- Live end-to-end runs on the testnet, each re-verified with `katalyst verify`; the full list with transaction hashes is in [TESTNET_EVIDENCE.md](TESTNET_EVIDENCE.md).

## Known gaps

See the roadmap and "Honest limitations" in the [README](../README.md): unaudited, single relayer and owner key, demo pools, placeholder price and eco feeds, settlement advances only while a page polls (until the keeper lands).
