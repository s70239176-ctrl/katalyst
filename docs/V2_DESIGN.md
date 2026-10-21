# Katalyst v2 — contract design

Status: **deployed on Portaldot V3 testnet and exercised end to end.** v1 (`contracts/evm/KatalystVault.sol`) stays live for
history. v2 is `contracts/evm/v2/KatalystVaultV2.sol` + `PoolHub.sol`.

## Deployment record

| | |
| --- | --- |
| Vault v2 | `0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46` |
| PoolHub | `0xE987E541075b404c2376c9d94A517A2A9Af0997E` |
| Deploy block | 136286 |
| Policy (immutable) | fee 0.05 tPOT · cap 50 tPOT · refund timeout 3600 s · settlement delay 60 s |
| Pools registered | Alpha, Beta (A-Tier), Gamma (C-Tier) |
| Deploy cost | ≈ 626 tPOT (hub ≈ 150, vault ≈ 460, pools ≈ 16) |

Live checks (all independently verified with `katalyst verify`): unlocked and route-locked intents settled through the serverless
relayer and the delay; a rogue proposal vetoed by the guardian with a full refund; a depositor cancel; a pool withdrawal from the app.

### Operational notes from the live run

- **Gas reservation.** A settlement transaction reserves about 9 tPOT of the relayer's balance up front. With less than that
  the RPC rejects it as `Invalid Transaction` (code 1010). Keep the relayer funded well above that.
- **Where the storage deposits go.** Settling frees the intent's slots, but it also creates the user's hub-position slots, and
  the chain charges that to the transaction origin (the relayer). The two roughly cancel, so the relayer nets about its fee
  minus gas, and the user recovers the storage deposit when they withdraw their position. The relayer therefore no longer
  forwards a storage refund in v2 (v1 still does); the code forwards only a surplus, and never the relayer's own proposal deposit.
- **Guardian.** `npm --prefix relayer run guardian -- --veto --loop 20` re-derives the verdict from GenLayer and vetoes any
  proposal whose route hash differs, a missing verdict, or a route proposed for a rejected intent. A veto works any time before
  someone finalises, so it also catches a proposal whose delay has passed.


## What changed, and why

| # | Feature | How it works | Closes |
| --- | --- | --- | --- |
| **C1** | **`refundExpired`** | Every intent carries an `expiry` (deposit time + `ttl`). After it, **anyone** can refund the depositor in full. The relayer cannot settle an expired intent. | Relayer offline ⇒ funds stranded (R3). The depositor needs no gas: a stranger or a bot can trigger it. |
| **C2** | **Pause · two-step ownership · relayer rotation · deposit cap** | `setPaused` blocks new deposits and relayer *execution* only; reject, cancel, expiry, veto and hub withdrawals always work, so a pause can never trap funds. `transferOwnership` + `acceptOwnership`. Owner can `setRelayer`. `maxDeposit` bounds exposure. | Key mistakes and incident response (R4, R11). |
| **C3** | **Protocol fee** | A fixed `feeWei`, **immutable**, is taken from the deposit when the relayer *executes or rejects*, and paid to the relayer. Never taken on cancel or expiry. The deposit must exceed the fee. | Relayer gas cost and spam: depositing garbage to force rejections now costs the spammer. |
| **C4** | **Gasless deposits → replaced** | See below. | — |
| **C5** | **Route lock** | Opt-in: `depositIntent(prompt, routeLock)`. The lock is a chained hash of the route the user previewed; the relayer can then only settle *exactly* that route (`RouteMismatch` otherwise). `0` = no lock. | "What you preview is what you get." |
| **C6** | **Real pools (`PoolHub`)** | Routes pay the hub, which keeps a per-user position for each pool and lets users `withdraw` their own funds at any time. Pool keys are the same addresses the solver already routes to, so no off-chain change. The hub has no yield logic; the key can later point at a real strategy. | "Where does the money go?" |
| **C7** | **Optimistic settlement delay + owner veto** | With `delay > 0`, `executeAdjudicatedIntent` only records a *proposal*; **anyone** can `finalizeSettlement` after the delay; the **owner can `vetoSettlement`** in between (full refund). `delay = 0` settles immediately. | A compromised or buggy relayer (R2): it can no longer move money instantly, and a watcher has time to stop a bad route. |

### Why C4 (gasless deposits) is not built as written

$POT is a *native* currency: a deposit is funds leaving the user's own account in the user's own transaction, and native
currency has no `permit`. A relayer could submit the transaction but the value would have to come from the relayer. What
C4 was meant to fix was **users stranded without gas**. C1 solves that: after the timeout anyone, including a bot, can
refund them with no gas from the user. (A signed-cancel scheme would add ~100 tPOT of code for the same outcome.)

### Why C7 is the veto window, not a relayer quorum or standing orders

- A **quorum** (k-of-n signed attestations) only removes the single-relayer assumption if the signers are independent
  operators, and it would break the single-relayer serverless flow. It is the right next step once there are several operators.
- **Standing orders** need a scheduler and an authorisation model that deserve their own design.
- The **veto window** bounds the largest remaining risk with one small mechanism, and a guardian can be automated: re-derive
  the verdict from GenLayer and veto any proposal that does not match (this is the same check the Verify page performs).

## State and immutables (storage deposit is the budget)

PortaldotV3 charges **0.06 tPOT/byte and 0.15/item**, so the design minimises storage:

- **Immutable** (no storage): `hub`, `feeWei`, `maxDeposit`, `ttl`, `delay`.
- **Storage:** one packed slot `owner + paused + intentCount`, `relayer`, `pendingOwner`, and one hash per pending intent
  (`pending`) plus one per proposal (`proposed`, deleted on settlement).
- A pending intent commits to `keccak256(abi.encode(Intent{nonce,user,amount,promptHash,routeLock,expiry}))`, so the relayer
  cannot change payer, amount, prompt, lock or deadline.

Consequences to be aware of: **fee, cap, ttl and delay cannot be changed after deployment** (that also means the owner cannot
raise the fee). Changing them means a new vault.

## Authority map

| Action | Who |
| --- | --- |
| Deposit | anyone (not while paused) |
| Settle (execute/propose), reject | relayer |
| Finalise a proposal | anyone, after `delay` |
| Veto a proposal, pause, rotate relayer, start ownership transfer, register pools | owner |
| Accept ownership | pending owner |
| Cancel | the depositor |
| Refund after expiry | anyone |
| Withdraw a pool position | the position's owner, always |

## Measured cost (real PortaldotV3 estimate)

| | Compiled size | Estimated deploy cost |
| --- | --- | --- |
| `PoolHub` | 1,873 B | **≈ 150.6 tPOT** |
| `KatalystVaultV2` (incl. veto window) | 6,051 B | **≈ 473.6 tPOT** |
| Register 3 pools | — | ≈ 16.5 tPOT |
| **Total** | | **≈ 641 tPOT** |

Sizes use the compiler's IR pipeline (`viaIR`, ≈25% smaller). The veto window (C7) accounts for ≈ 1.4 KB of the vault
(≈ 110 tPOT). Dropping it would bring the total to ≈ 530 tPOT.

## Verification performed

- `npm run test:v2` — 11 scenario tests, including time travel (expiry, delay) and every revert path above.
- `npm run fuzz:v2` — randomised invariants against an independent model, in both modes (`delay = 0` and `> 0`):
  vault balance equals pending deposits; hub balance equals the sum of positions equals the sum of `held`; shares are exact
  with the remainder on the last leg; reverted actions change no state; dead intents never resettle; refunds are exact
  and the fee is charged only where specified. ≈ 1,500 random steps across seeds, no violation.
- v1's 11 scenario tests and fuzz test still pass (v1 is unchanged).

## Deployment plan

1. `node scripts/compile_v2.mjs && node scripts/deploy_v2.mjs` (dry run, prints the estimate above).
2. `node scripts/deploy_v2.mjs --send [--fee … --cap … --ttl … --delay …]`: deploys the hub (bound to the *predicted* vault
   address), then the vault, registers the pools, and records the addresses in `relayer/.env`. The script refuses to send if
   the balance is below the estimate or the vault lands at an unexpected address.
3. Off-chain wiring (done): serverless relay (`api/_lib/vault_v2.ts`), SDK verification, UI (route lock, policy, positions page,
   delay countdown), chain entry with `"version": 2` in `VITE_CHAINS` / `VAULTS`.
4. Run the guardian (`relayer/scripts/guardian.mts`) while `delay > 0`.

## Not in v2 (and why)

Relayer quorum, standing orders, gasless deposits (impossible for native currency), yield strategies behind the hub, upgradeability
(deliberately omitted: immutable code is easier to reason about), and a protocol-fee *setter* (the fee is immutable by design).
