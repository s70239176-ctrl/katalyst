# DoraHacks submission text

Copy these into the DoraHacks project form. Track: **Multi-Chain & Cross-Chain Infra** (with an Ecosystem-DApp angle).

## Links

- Live app: https://katalyst-intent.vercel.app/
- GitHub (public, MIT): https://github.com/s70239176-ctrl/katalyst
- Demo video (2:49): upload `demo/katalyst-demo.mp4` and paste the link here
- Testnet evidence: [docs/TESTNET_EVIDENCE.md](TESTNET_EVIDENCE.md)
- Development log: [docs/DEVLOG.md](DEVLOG.md) · Architecture: [docs/ARCHITECTURE.md](ARCHITECTURE.md)

## One-liner

Katalyst turns a plain-language intent into a verified settlement on Portaldot: GenLayer validators decide the route, a Portaldot vault re-checks and settles it, and anyone can verify the result.

## Short description

You deposit $POT with an intent such as "maximize yield, but only A-Tier carbon pools". GenLayer validators agree on a route (the model only extracts constraints; deterministic code allocates, so a prompt can never name an address). A relayer carries the verdict to a Solidity vault on the Portaldot V3 testnet, which re-validates the route on-chain, waits out a safety delay in which the owner or an automated guardian can veto, and then pays the pools. Every settlement can be re-derived independently from chain events and GenLayer's records.

## Portaldot integration (verifiable)

- **Deployed on the Portaldot V3 testnet** (chain 420420777) through the pallet-revive EVM RPC: `KatalystVaultV2` `0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46` and `PoolHub` `0xE987E541075b404c2376c9d94A517A2A9Af0997E`.
- **Seven real intents** with full transaction hashes in [TESTNET_EVIDENCE.md](TESTNET_EVIDENCE.md): executed settlements, a vetoed rogue proposal with a full refund, a depositor cancel.
- **Designed around Portaldot's economics.** Storage is charged per byte, so a pending intent is a single commitment hash and everything else lives in events; the Solidity vault cost about 315 tPOT to deploy against about 1,001 tPOT for our ink! version.
- **Portaldot-specific details handled:** EVM addresses map to native accounts, the 9 tPOT gas reservation, storage-deposit refunds, RPC pruning (verification is built on event logs), and explorer links that open the testnet node.
- **Cross-chain by design:** one GenLayer solver, several settlement vaults (`chainId:vault:nonce` refs); tested end to end on a second EVM chain.

## What works today (progress)

- v1 and v2 vaults deployed and exercised on the testnet; v2 adds refund after timeout, pause, two-step ownership, an immutable fee and cap, an opt-in route lock, withdrawable pool positions and the settlement delay with owner veto.
- GenLayer solver (Studionet) with prompt-injection defences, free previews and a decision trace.
- Serverless relayer on Vercel (no server to run), always-on relayer as an option, and a guardian that vetoes proposals that differ from the validators' verdict.
- dApp: landing page, intent flow with route lock, activity, pool positions with withdraw, network and vault rules, security lab, independent verification and shareable receipts.
- SDK, CLI (`katalyst verify`), embeddable widget, an example consumer.
- Tests: 11 scenario tests per vault generation, randomised invariant fuzzing, 31 solver tests; operations: `/api/status`, Prometheus metrics, alerts.

## Remaining tasks

See the [roadmap](../README.md#roadmap-the-next-23-months-to-mainnet). In short: multisig owner and timelock, an always-on keeper, multi-RPC cross-checking, an indexer, an external audit, a relayer quorum, real pool strategies and live data feeds, then a mainnet launch with conservative limits.

## Honest limitations

Unaudited testnet software. The vault cannot verify GenLayer's result on-chain, so it trusts the relayer to relay it faithfully; v2 bounds that with the delay, veto, guardian and route lock, but a single relayer key and a single owner key remain. Demo pools are generated addresses, not yield strategies. Settlement advances only while a page is polling, until the keeper lands.
