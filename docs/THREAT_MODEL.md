# Katalyst threat model

Status: hackathon build on a testnet. **Unaudited.** This document is deliberately blunt about what is and is not
guaranteed, so reviewers can judge the design rather than the marketing.

## What is protected

User deposits held by `KatalystVault` (Solidity, Portaldot / pallet-revive) while an intent is pending.

## Who is trusted, and for what

| Party | Trusted to | NOT trusted to |
| --- | --- | --- |
| **Vault contract** | Enforce the rules below, deterministically | n/a — it is the enforcement point |
| **Relayer** (one key) | Deliver GenLayer's verdict on-chain; stay online | Change who is paid, how much, or the prompt; pay a non-whitelisted address |
| **GenLayer validators** | Reach honest consensus on the verdict (optimistic democracy) | Move funds — they have no key on Portaldot |
| **Vault owner** (one key) | Curate the pool whitelist | Anything else; the owner cannot move deposits |
| **Public Portaldot RPC** | Serve events honestly | — (single provider; see R9) |

**The central assumption:** the vault cannot verify GenLayer's result on-chain (there is no light client or bridge
proof). It trusts the relayer to relay the verdict faithfully. Everything else is built to *bound* that trust and to
make any deviation **detectable** (see the Verify page).

## Guarantees enforced on-chain (tested)

1. **Binding.** A pending intent is one commitment `keccak256(nonce, user, amount, keccak256(prompt))`. Settlement must
   reproduce it, so the relayer cannot change payer, amount or prompt.
2. **Whitelist.** Funds can only go to pools on the whitelist; duplicates and zero-share legs are rejected.
3. **Totals.** Percentages must sum to exactly 100; the last leg takes the rounding remainder, so the whole deposit is
   distributed and nothing is left in the vault.
4. **Single use.** The commitment is deleted *before* any transfer (checks-effects-interactions), so an intent cannot be
   settled, rejected or cancelled twice, and a re-entering pool cannot double-settle.
5. **Access control.** Only the relayer settles; only the owner edits the whitelist; only the depositor cancels.
6. **Atomicity.** A failing transfer reverts the whole settlement.
7. **User escape hatch.** The depositor can `cancelIntent` at any time before settlement for a full refund.

Evidence: 11 scenario tests and a randomised invariant test (`npm run fuzz:evm`) that checks, after every step, that the
vault balance equals the sum of pending deposits, reverted calls change nothing, shares are exact, and replays fail.

## Threats

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| R1 | **Prompt injection** tries to redirect funds or override eco rules | Static screen rejects foreign addresses and override phrasing *before any model call*; the model only **extracts constraints**; percentages and addresses come from deterministic code over an embedded whitelist; the vault re-validates; the stricter of model-vs-regex constraints wins | A model could mis-extract a constraint. Impact is a *different valid route among whitelisted pools*, never an outside address |
| R2 | **Compromised or malicious relayer** | Binding, whitelist and totals (above) cap what it can do | It can **settle a valid-but-different route** than GenLayer's verdict, or **refuse to settle**. The first is *detectable* via Verify (verdict-vs-paid check); it is not prevented. Planned: signed attestations from a relayer quorum and a challenge window |
| R3 | **Relayer offline** | Depositors can cancel for a full refund; settlement is idempotent so any restart resumes | A permissionless `refundExpired` after a timeout is planned (needs the v2 contract) |
| R4 | **Owner key compromised** | Owner can only edit the whitelist, not move funds | A malicious owner + colluding relayer could route to an attacker pool. Planned: multisig/timelock, two-step ownership |
| R5 | **Re-entrancy via a pool contract** | State deleted before transfers; settle is relayer-only | None known (fuzz + scenario tests) |
| R6 | **Replay / double settlement** | Commitment deleted on settle | None known |
| R7 | **GenLayer validators collude or stall** | Majority consensus; idle validators tolerated; no verdict ⇒ nothing moves ⇒ cancel/refund | Collusion by a validator majority would yield a bad verdict that is still constrained to whitelisted pools |
| R8 | **Griefing via the public relay endpoint** (serverless mode) | Endpoint only acts on real pending intents and derives every parameter from chain state; idempotent | An attacker can cost the relayer a little gas only by creating real deposits (≈4 tPOT each, refunded) |
| R9 | **Dishonest / pruned public RPC** | Verification uses event logs (which persist) and falls back gracefully when old transactions are pruned | A single RPC provider is a trust point; multi-RPC cross-checking is a straightforward extension |
| R10 | **Storage-refund pass-through** | Relayer forwards the chain's storage-deposit refund to the depositor | The relayer is trusted to do so; it is measured and visible in the receipt, not enforced by the contract |
| R11 | **Key handling** | Relayer key lives only in server env (Vercel/host secrets), never in the browser bundle; `.env` files are git-ignored and scanned before commits | Immutable `relayer`/`owner` mean rotation = redeploy |
| R12 | **Front-end tampering / supply chain** | Wallet signs only `depositIntent` / `cancelIntent`; pinned dependency versions; security headers | Standard web risks apply |

## v2 contracts (deployed on testnet, tested, exercised live)

`docs/V2_DESIGN.md` describes the mitigations that address the "planned" items above (vault `0x786DEF20…dD46`, PoolHub `0xE987E541…97E`): **permissionless `refundExpired`** (R3),
a **settlement delay with owner veto** that bounds a compromised relayer (R2), **pause, two-step ownership and relayer
rotation** (R4, R11), an **opt-in route lock**, an immutable **fee** and **deposit cap**, and a **PoolHub** holding real,
withdrawable positions. A relayer quorum is deliberately left for when there are independent operators.

Demonstrated live: a relayer key that proposed a route the validators had not chosen (100% to a C-Tier pool) was caught by
`relayer/scripts/guardian.mts` inside the delay window and vetoed, the depositor was refunded in full, and Verify reports the
veto as justified (`relayer/scripts/test_guardian_v2.mts`). Residual risks that remain in v2: nobody watching during the delay,
a compromised owner key (it can veto and pause, and can rotate the relayer, but cannot move deposits to itself), and the
single-RPC trust point.

## Out of scope / known limitations

- Not audited. Not for mainnet funds as-is.
- Demo pools are generated addresses, not yield strategies; funds sent to them are not productively invested.
- Oracle endpoints in the solver are placeholders; on fetch failure the solver uses an embedded APY/eco table. Feeds can
  only change APY/tier of *known* pools, never addresses.
- Single relayer, single owner, no pause switch (v2).

## How to check our claims yourself

- Read `contracts/evm/KatalystVault.sol` (≈150 lines).
- `npm --prefix relayer run test:evm` and `npm --prefix relayer run fuzz:evm`.
- Open **Verify** in the app (or `katalyst verify <n>`) for any intent: it re-derives the outcome from on-chain events and
  GenLayer's own transaction records.
