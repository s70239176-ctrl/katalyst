# Architecture

Katalyst is a **cross-chain decision layer**: GenLayer (where contracts can read language and reason about it) decides;
Portaldot (where the money is) settles. The two chains never talk directly, so a thin relayer carries the verdict across and
the vault re-validates it.

## Components

```mermaid
flowchart LR
  subgraph Portaldot["Portaldot V3 (EVM / pallet-revive)"]
    V["KatalystVault.sol<br/>escrow + commitments + whitelist"]
    P["Whitelisted pools"]
  end
  subgraph GenLayer["GenLayer Studionet"]
    S["IntelligentVaultSolver.py<br/>guardrails → LLM constraints → deterministic split"]
    VAL["Validators<br/>(optimistic democracy)"]
  end
  R["Relayer<br/>Vercel Functions or always-on daemon"]
  U["User + dApp"]

  U -- "depositIntent(prompt) + $POT" --> V
  V -- "IntentDeposited" --> R
  R -- "adjudicate_intent" --> S
  S <--> VAL
  S -- "verdict + decision trace" --> R
  R -- "executeAdjudicatedIntent / rejectIntent" --> V
  V -- "split by %" --> P
  U -. "preview_intent (free, simulated)" .-> S
  U -. "Verify: events + GenLayer records" .-> V
```

## One intent, end to end

```mermaid
sequenceDiagram
  actor User
  participant Vault as Vault (Portaldot)
  participant Relayer
  participant Solver as Solver (GenLayer)
  User->>Solver: preview_intent(prompt) — free, nothing stored
  Solver-->>User: route + why each pool was kept/excluded
  User->>Vault: depositIntent(prompt) + value
  Vault-->>Vault: store ONE slot: keccak(nonce,user,amount,promptHash)
  Vault-->>Relayer: IntentDeposited(nonce,user,amount,prompt)
  Relayer->>Solver: adjudicate_intent(nonce,prompt,amount)
  Solver->>Solver: static screen → LLM extracts constraints → deterministic split
  Note over Solver: validators run the same code and must agree (strict_eq)
  Solver-->>Relayer: verdict JSON (+ validator votes via the tx)
  Relayer->>Relayer: validate shape, nonce, Σ = 100
  Relayer->>Vault: executeAdjudicatedIntent(nonce,user,amount,promptHash,legs)
  Vault->>Vault: match commitment, whitelist, Σ=100, delete commitment, pay pools
  Vault-->>User: events: IntentExecuted + RouteLeg(s)
  Relayer->>User: forward the storage-deposit refund
```

## Design decisions (and why)

**The model never chooses addresses or percentages.** It only extracts constraints (tier, minimum APY, max-yield,
"is this malicious?"). Allocation is plain Python over an embedded whitelist, which also makes validators' outputs
identical so `gl.eq_principle.strict_eq` converges. The constraints are merged with an independent regex parse and the
**stricter** wins.

**One storage slot per pending intent.** Portaldot charges a storage deposit (0.06 tPOT/byte, 0.15/item). The prompt, the
route and the status therefore live in **events**, and a pending intent is a single commitment hash that is deleted on
settlement. Measured deployment cost: ≈315 tPOT (vs ≈1,001 for the ink! variant).

**The relayer is stateless where possible.** Everything needed to resume is on-chain (vault commitment) or idempotent
(`adjudicate_intent` returns the stored verdict for a nonce already seen). That is what lets the relayer run as Vercel
Functions driven by the dApp's polling, or as an always-on daemon, with the same logic.

**Verification is evidence-based.** `katalyst verify <n>` and the Verify page rebuild the story from persistent event logs
and GenLayer's transaction records, because the public RPC prunes old transactions but keeps logs.

**Storage-refund pass-through.** The chain refunds a freed storage slot's deposit to whoever freed it (the relayer). The
relayer forwards it to the depositor, cutting a user's overhead from ≈7.7 to ≈0.3 tPOT per intent.

## Repository map

| Path | What |
| --- | --- |
| `contracts/evm/` | `KatalystVault.sol` — the deployed vault |
| `contracts/vault/` | ink! 4.3 variant (reference; costlier to deploy) |
| `genlayer/` | Intelligent contract + unit tests |
| `relayer/` | Always-on relayer, deploy/test/fuzz scripts |
| `frontend/` | dApp (`src/`), SDK (`src/sdk/`), serverless relayer (`api/`) |
| `cli/` | `katalyst` command line |
| `docs/` | This folder |
