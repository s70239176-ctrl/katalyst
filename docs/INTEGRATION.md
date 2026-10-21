# Integrating Katalyst

Four ways in, from lightest to deepest. All of them work against a live deployment; none needs a wallet for read-only use.

## 1. The preview widget (zero code)

A web component that shows a free, GenLayer-simulated verdict inside any page.

```html
<script type="module" src="https://<your-app>/widget/katalyst-widget.js"></script>
<katalyst-preview contract="0x…solver…" prompt="Max yield, A-Tier only"></katalyst-preview>
```

- Attributes: `contract` (solver address, required), `prompt`, `chain` (default `studionet`), `theme` (`dark` | `light`).
- Event: `katalyst:verdict`, with the verdict as `event.detail`, bubbling out of the shadow root.
- Nothing is deposited or stored. Try it at `/widget-demo.html?contract=0x…` after `npm run build`.

## 2. The SDK (TypeScript, browser or Node)

Lives in `frontend/src/sdk/`. It reads the vault's events and GenLayer's own transaction records directly, with no
Katalyst server involved.

```ts
import { createKatalyst } from './sdk';

const k = createKatalyst({
  vault: '0x…',                       // KatalystVault on your settlement chain
  rpcUrl: 'https://…',                // that chain's EVM RPC
  chainId: 420420777,
  deployBlock: 124470,                // bounds log scans
  genlayer: { contract: '0x…' },      // the solver
});

const verdict = await k.preview('Max yield, A-Tier only'); // free; route + why each pool was kept/excluded
const proof   = await k.verify(8);                          // evidence-based checklist + proof bundle
const stats   = await k.validators();                       // validator participation from solver transactions
```

`verify()` returns a `ProofBundle` (`schema: "katalyst.proof/v1"`) with a `verdict` of `verified | failed | pending |
not_found` and one entry per check (deposit exists; settled; sender authorised; settlement bound to the deposit; GenLayer
judged the same prompt; validators agreed; verdict matches what was paid; the split is exact; pools whitelisted; optionally
that a fresh run reproduces the verdict).

> The public Portaldot RPC prunes old *transactions* but keeps event *logs*, so verification prefers transaction data when it
> is still served and otherwise falls back to the vault's events, saying which it used.

## 3. The CLI

```bash
npm --prefix frontend run cli -- preview "Max yield, A-Tier only"
npm --prefix frontend run cli -- verify 8 --rerun --out proof.json   # exit code 1 if any check fails
npm --prefix frontend run cli -- intent 8
npm --prefix frontend run cli -- validators
npm --prefix frontend run cli -- simulate 0x<any-genlayer-contract> <method> '<json-args>'
```

Configure with flags or `KATALYST_VAULT`, `KATALYST_RPC`, `KATALYST_DEPLOY_BLOCK`, `KATALYST_GENLAYER_CONTRACT`,
`KATALYST_GENLAYER_CHAIN`.

## 4. Build your own consumer of the pattern

Katalyst is a pattern, not just an app: **a settlement contract that escrows value, a GenLayer contract that decides, and a
relayer that carries the verdict across, with the settlement contract re-validating it.**

`genlayer/examples/milestone_verifier.py` is a second, unrelated consumer: validators decide whether delivered work meets
agreed acceptance criteria. It follows the same rules as the Katalyst solver:

1. a **static screen** rejects evidence that tries to instruct the reviewer;
2. the model answers a **tiny boolean question** about data it must not obey, so validators converge under `strict_eq`;
3. results are **idempotent per `ref`** and a `preview_*` method simulates without storing.

```bash
node relayer/scripts/deploy_genlayer.mjs --file ../genlayer/examples/milestone_verifier.py --args '[]'
npm --prefix frontend run cli -- simulate 0x<deployed> preview_milestone \
  '["Landing page live, under 2s, shows pricing","Deployed; Lighthouse 1.2s; pricing table visible"]'
```

To close the loop you would add an escrow on the settlement chain that releases funds only for an approved verdict and
re-checks it on-chain, exactly as `KatalystVault` does for routes (commitment-bound settlement, access control, atomic
transfers). The relayer logic (`frontend/api/relay.ts`) is the reference for the off-chain half.

## Multiple settlement chains

One solver can serve several vaults on different EVM chains. Intents are keyed by `ref = chainId:vault:nonce`, so the same
nonce on two chains never collides (this is tested: the same vault address and nonce on Portaldot and a second chain are
separate intents).

- **Server (`VAULTS`, JSON array):** `[{"key":"portaldot","name":"Portaldot V3 Testnet","chainId":420420777,"rpcUrl":"…","vault":"0x…","deployBlock":124470,"explorerBlockUrl":"https://…/{block}"}, {…}]`
- **Browser (`VITE_CHAINS`, JSON array):** the same entries plus `symbol`, `portaldotNative`, `legacyNonceRefs`, optional `poolLabels`.
  A chain picker appears in the header when there is more than one.
- Both must describe the same chains. One relayer key is used per chain (`relayerKeyEnv` selects it), so the same EVM key
  can relay everywhere.
- Deploy the unchanged vault to another chain: `node relayer/scripts/deploy_evm.mjs --rpc <url> --chain-id <id> --send`.

The always-on daemon serves one chain per process; run one per chain, or use the serverless relayer for several.
