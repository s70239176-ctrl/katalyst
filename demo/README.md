# Katalyst demo video

`katalyst-demo.mp4` (2:49, 1280x720) with voice-over, burned-in captions (`katalyst-demo.srt`) and an original generated soundtrack.
The MP4 is not committed (14 MB); upload it where you need it.

## What it shows

Everything on screen is the live site, https://katalyst-ashen.vercel.app, talking to the real **Portaldot V3 testnet**.

| Time | Scene | Real? |
| --- | --- | --- |
| 0:00 | Title | |
| 0:12 | Landing page: figures read from vault events on Portaldot | live data |
| 0:30 | Compose an intent, free GenLayer preview | live validators |
| 0:50 | Route-locked deposit of 0.3 tPOT | **real transaction** |
| 1:03 | Consensus (3/5 validators), proposal, 60 s safety delay, settlement (timelapse x4 to x6) | **real, serverless relayer on Vercel** |
| 1:30 | Settlement block in the Portaldot node console | real block |
| 1:43 | Verify page: 12 of 12 independent checks | recomputed from chain events |
| 2:04 | Failure case: rogue relayer proposal vetoed, full refund | real testnet intent #4 |
| 2:24 | Vault rules, fixed at deployment | live |
| 2:33 | Close: how to try it, what is next | |

## The live run in the video (intent #7)

- Vault `0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46` on Portaldot V3 testnet (chain 420420777)
- Deposit transaction `0x1884a4aca29df239393eb7d5ea50438de5037c78d7aba3144a39a084644f81c5` (EVM block 138211)
- Settlement transaction `0xcaca1b520f7908283dd07dfb431f2a0d604c135677559f145a81ecbb597dd9c2` (EVM block 138228)
- Explorer: https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/138228
- Re-check it yourself: `npm --prefix frontend run cli -- verify 7 --vault 0x786DEF20A47b7B22c67eBaac3A9a3b3D5C0ddD46 --version 2 --deploy-block 136286 --genlayer 0x8cE92023E3052C428876139a2Ca8F666179eBf2B`

## How it was made (`tools/`)

Reproducible with Python (Playwright, numpy, scipy, imageio-ffmpeg) and the Windows speech engine; no screen recorder, stock music or paid voice.

1. `record_demo.py`, `record_tail.py`, `record_explorer.py` drive Chrome through the live site and record 720p video. The browser wallet is a local shim that signs with a **testnet-only** key through `relayer/scripts/dev_wallet.mjs`.
2. `script.json` is the narration; `tts.ps1` renders it with the built-in voice.
3. `music.py` synthesises the soundtrack.
4. `assemble.py` retimes each scene to its narration, adds labels and captions, ducks the music under the voice and encodes the MP4.

The scripts use absolute Windows paths (`kt-demo` under the temp folder); adjust them to your machine.
