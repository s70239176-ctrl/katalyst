# Portaldot V3 testnet evidence

Everything below happened on the **Portaldot V3 testnet** (EVM chain id `420420777`, EVM RPC `https://test-evm-rpc-v3.portaldot.dev`,
Substrate `wss://test-node-v3.portaldot.dev`) and is checkable by anyone. Nothing here is a mock: the contracts are deployed, the
transactions are real, and every settlement below has been re-verified independently from chain events and GenLayer's records.

## Contracts

| Contract | Address | Notes |
| --- | --- | --- |
| **KatalystVaultV2** (current) | `0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46` | deployed at block 136286; fee 0.05 tPOT, cap 50 tPOT, timeout 3600 s, settlement delay 60 s (all immutable) |
| **PoolHub** (v2 pool positions) | `0xE987E541075b404c2376c9d94A517A2A9Af0997E` | three pools registered in blocks 136288 to 136291 |
| KatalystVault v1 (kept for history) | `0x74fcFD25f70fcB562e09930D92d39d6B4cCFCc71` | first deployment, deploy block 124470 |
| Solver (GenLayer Studionet) | `0x8cE92023E3052C428876139a2Ca8F666179eBf2B` | the intent adjudicator: validators agree on the route |
| Relayer / vault owner | `0xECD09F7c57ee84ca90b70baA1b469589BEB5bfDE` / `0x693CE510c9420bF08B24dFF9C44A25b6f77C3717` | the owner can veto and pause but cannot move deposits |

Check a contract is really there: `eth_getCode` for the vault address on the EVM RPC returns its bytecode (about 6 KB).

## Transactions: the v2 vault

Block numbers are EVM RPC blocks, which equal native Portaldot block numbers on this testnet, so they open directly in the node console:
`https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/<block>`.

| Intent | Step | Block | Transaction hash |
| --- | --- | --- | --- |
| #1 | deposit | 136393 | `0xb2cd071bcff5954a3d2098d2521a6e9f3ea63397d246386af578c1252ee856bf` |
| #1 | proposal | 136400 | `0xa76265e86b389e271be074ffa3aaa8466a236261a1451f6fbefd8a766ec9f879` |
| #1 | **executed** | 136572 | `0x1fc91afca3b3445ee569ed8bf1ddb90de52ab37198c63d8744e889c717624409` |
| #2 | deposit | 136462 | `0x852857ca5331da652c7bf14a30574f55ff7af0be38ee5c92375e7af8c7fb7ba9` |
| #2 | proposal | 136576 | `0xd4f2adb7b085f870ca3921b6e86f5a1bad6bec304aa41b3d2cd930bdc160efdd` |
| #2 | **executed** | 136589 | `0xf75b741439d1fb3951cc809f5f580001f075ff6f4e39790a90ab3c36b2e607a7` |
| #3 | deposit | 136488 | `0xbd8387a2f3ecf82434c4d52b460cb6196ba98282a12772e5b1d6b244b60243a3` |
| #3 | proposal | 136495 | `0x4a0cc208fe21887f9cdcb2989e72d5d8228dd653eff4bedad8b21d9ad9dbe6cf` |
| #3 | **executed** | 136508 | `0xdd689677bf4dddb82cf361e95ad71d3c86ba2c8935e29734c316f98cbb5d70c4` |
| #4 | deposit | 136540 | `0x6594667f7042ba5b4602f87b6575bc188523563eedcbbadaec4701c84eb3b400` |
| #4 | rogue proposal (a route the validators never chose) | 136551 | `0xe9a5bb513c24cb3a63b1870ecc67e760bb8761bd9a06a75d629b8860c18fc45c` |
| #4 | **vetoed by the owner, depositor refunded in full** | 136564 | `0x71498cf022ae9efff35fe2f4a0e7843c021f42a707e1795c77d6e6cb0d0c00fd` |
| #5 | deposit (route locked) | 136724 | `0x90634730480c243b1fe23d6594fbc3097dd19568d060b9d5e1a054fa16857adb` |
| #5 | proposal | 136731 | `0xa8fa7e7d5d35122b4ad2908d4facd6723b5b23900c821ac63e414e79c6970a72` |
| #5 | **executed** | 136744 | `0xc37c69466cdf7e67422820883debefce1447b4886dca079d1cecff1bd2e7cd2e` |
| #6 | deposit | 136758 | `0xff01566a9e245637c769138d4f81dc2fed5e5090abc07565471f95500862a219` |
| #6 | **cancelled by the depositor, refunded** | 136760 | `0xce32b53c77997bd76ee578e94c0fb82898d3101f808bb231a389c3aaed09e06a` |
| #7 | deposit (route locked, the demo video) | 138211 | `0x1884a4aca29df239393eb7d5ea50438de5037c78d7aba3144a39a084644f81c5` |
| #7 | proposal | 138218 | `0xff2239672d075f2bb30c1b355860293d364d3eef748c68bfcbdbdc405536aae1` |
| #7 | **executed** | 138228 | `0xcaca1b520f7908283dd07dfb431f2a0d604c135677559f145a81ecbb597dd9c2` |

Intent #7's GenLayer consensus transaction: `0xb7ca0f569ef71cbe72b401493c78b57b95a6929ecb72e3a3fbabea05521f7064` (Studionet, 3 of 5 validators agreed).

Pool registration in the hub: `0x244e6f94…8f953` (Alpha, block 136288), `0xa2a50894…d8d15` (Beta, 136290), `0xafe88e5f…c092d` (Gamma, 136291); full hashes are in the
hub's `PoolSet` events.

## What these transactions demonstrate

- **Deposit and commitment.** The vault stores one hash per pending intent (who, how much, which prompt, which route lock, deadline).
- **GenLayer decides, the vault re-checks.** The route comes from validator consensus; the vault independently enforces totals, registered pools and the route lock before paying.
- **Safety delay and veto.** Intents #1 to #5 and #7 settled only after the 60 s delay. Intent #4 is the failure case: a relayer proposed a route the validators did not pick, the guardian caught it, the owner vetoed, and the depositor got every token back.
- **User exits.** Intent #6 shows the depositor's own cancel; permissionless refund-after-timeout is covered by the contract tests and fuzzing.
- **Real Portaldot behaviour.** Settlement pays into `PoolHub`, so a user's funds sit in withdrawable per-pool positions (withdrawal tested from the app).

## Verify it yourself

```bash
# an independent re-derivation from chain events and GenLayer's own records (exit code 1 if any check fails)
npm --prefix frontend run cli -- verify 7 \
  --vault 0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46 --version 2 --deploy-block 136286 \
  --genlayer 0x8cE92023E3052C428876139a2Ca8F666179eBf2B
```

Intent #7 reports 12 of 12 checks passed (deposit, settlement, who submitted it, commitment binding, validator consensus, same prompt, verdict equals what was paid, exact split, registered pools, fixed fee, route lock, safety delay). Intent #4 reports "the safety delay caught a bad route".
The same check runs in the browser at `https://katalyst-intent.vercel.app/#/verify/7`.

Regenerate the table above from the chain with `node --env-file=.env scripts/evidence.mjs` (in `relayer/`).

## Honest notes

- Old transactions are pruned by the public RPC after a short while (under an hour in our tests), but event logs are kept; that is why the table is built from events and why Verify falls back to events.
- Testnet only, unaudited. Pools are demo addresses, not yield strategies.
