# 90-second demo script

Pitch in one line: **"GenLayer decides, Portaldot settles — and you can verify every decision yourself."**

## Before you record (5 minutes)

- [ ] Wallet connected and on Portaldot V3 Testnet, with **≥ 12 tPOT** (a deposit reserves ≈9 tPOT for gas; most is refunded)
- [ ] Relayer healthy: the Network page shows **All systems operational** (or `/api/status` returns 200)
- [ ] Tab open on the **Intent** page; a second tab on **Security lab**
- [ ] One **already-settled** intent number noted for the Verify step (e.g. `#/verify/8`)
- [ ] Settlement takes ≈60–90 s live. **Pre-submit one intent and let it run while you talk**, or cut that wait in the edit.

## Script

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Intent page | "You describe what you want in plain language. Katalyst turns it into an on-chain route, and no single party decides." |
| 0:10 | Type *"Maximize yield but only A-Tier carbon pools, minimum 12% APY"*, click **Preview verdict (free)** | "Before depositing anything I can preview the verdict. Validators parsed my constraints, excluded the C-Tier pool for its eco score, and picked the highest-yield A-Tier pool." |
| 0:25 | Point at the per-pool decision table | "Every pool shows why it was kept or excluded, so the AI isn't a black box." |
| 0:30 | Click **Deposit & submit**, confirm in the wallet | "Now I lock real $POT in the vault. It's bound to a commitment, so nobody can change who is paid, how much, or the prompt." |
| 0:40 | Stepper: deposit ✓ → consensus → settlement | "GenLayer validators agree on the verdict — you can see the real vote count and the transaction. Then the vault re-checks the route on-chain before paying." |
| 0:55 | Receipt: validators, route, links | "Here's the receipt: 3 of 5 validators agreed, funds routed, and every transaction is linked." |
| 1:05 | **Verify** page for a settled intent | "Don't trust us. This page rebuilds the story from on-chain events and GenLayer's own records and checks they agree: the prompt GenLayer judged is the one deposited, the verdict matches what was paid, the split is exact." |
| 1:20 | **Security lab** → Run all probes | "And here I attack it live: redirect funds, override the rules, extract the prompt. All contained; the legitimate request still passes." |
| 1:30 | Network page | "It runs entirely on Vercel, with live validator reliability and system status." |

## If something goes wrong on camera

- **Wallet pending too long:** cancel and retry; the intent can also be cancelled for a full refund.
- **Settlement slow:** the stepper stays on "consensus" while validators vote. Switch to the pre-submitted intent's receipt.
- **RPC hiccup:** refresh; all state is on-chain, nothing is lost.

## Questions judges ask (honest answers)

- *"Where does the money go?"* To whitelisted pool addresses. In this build they are demo addresses, not yield
  strategies; real pool contracts are the first v2 item.
- *"What if the relayer lies?"* It can't change payer, amount, prompt, or pay a non-whitelisted address. It *could* settle a
  valid-but-different route; that's detectable on the Verify page, and a relayer quorum is planned. See `docs/THREAT_MODEL.md`.
- *"What if the relayer is down?"* The depositor can cancel for a full refund.
- *"Why GenLayer?"* The decision needs reading language and reaching agreement among independent validators; a normal contract
  can't do that, and a centralised AI would be exactly the trusted party we're avoiding.
- *"Why is it cheap to deploy?"* Portaldot charges per byte of contract storage, so the vault keeps one hash per pending
  intent and puts everything else in events.
