// Randomised invariant test for KatalystVault on an in-process EVM (ganache).
//   node scripts/fuzz_evm.mjs [steps=200] [seed=1]
//
// Random sequences of deposit / execute / reject / cancel / whitelist actions, valid and invalid, checked against
// a model. Invariants asserted after EVERY step:
//   I1  vault balance == sum of the amounts of intents the model says are pending (no funds lost or created)
//   I2  a call expected to revert changes nothing (balances and pending commitments identical)
//   I3  executed intents pay each pool exactly floor(amount*pct/100), last leg takes the remainder
//   I4  a settled (or cancelled) intent can never be settled again
//   I5  only the relayer settles, only the owner edits the whitelist, only the depositor cancels
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BrowserProvider, Contract, ContractFactory, keccak256, toUtf8Bytes, zeroPadBytes, parseEther } from 'ethers';

const steps = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 1);

// small deterministic PRNG (mulberry32)
let t = seed >>> 0;
const rnd = () => {
  t = (t + 0x6d2b79f5) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), 1 | t);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];

const ganache = createRequire(import.meta.url)('ganache');
const art = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8'));
const provider = new BrowserProvider(ganache.provider({ wallet: { totalAccounts: 12, defaultBalance: 100000 }, logging: { quiet: true }, chain: { hardfork: 'shanghai' } }));
const signers = await Promise.all(Array.from({ length: 12 }, (_, i) => provider.getSigner(i)));
const [owner, relayer, ...rest] = signers;
const users = rest.slice(0, 4);
const pools = rest.slice(4, 8);
const addr = async (s) => s.getAddress();
const A = { owner: await addr(owner), relayer: await addr(relayer), users: await Promise.all(users.map(addr)), pools: await Promise.all(pools.map(addr)) };

const factory = new ContractFactory(art.abi, art.bytecode, owner);
const vault = await (await factory.deploy(A.relayer, [A.pools[0], A.pools[1], A.pools[2]])).waitForDeployment();
const vaultAddr = await vault.getAddress();
const as = (s) => new Contract(vaultAddr, art.abi, s);
const bal = async (a) => BigInt(await provider.send('eth_getBalance', [a, 'latest']));
const ZERO = '0x' + '00'.repeat(32);
const eco = (s) => zeroPadBytes(toUtf8Bytes(s), 8);

// ---- model
const model = { wl: new Set([A.pools[0], A.pools[1], A.pools[2]]), pending: new Map(), settled: new Set(), count: 0 };
const stats = { deposit: 0, execute: 0, reject: 0, cancel: 0, wl: 0, revertsChecked: 0 };

const revertName = async (fn, args, overrides = {}) => {
  try { await fn.staticCall(...args, overrides); return null; } catch (e) { return e.revert?.name ?? e.shortMessage ?? 'unknown'; }
};

async function snapshot() {
  const b = { vault: await bal(vaultAddr) };
  for (const p of A.pools) b[p] = await bal(p);
  for (const u of A.users) b[u] = await bal(u);
  const commitments = {};
  for (let n = 1; n <= model.count; n++) commitments[n] = await vault.pending(n);
  return { b, commitments };
}

function randomLegs(valid) {
  const n = int(1, 4);
  const chosen = [];
  const pool = [...A.pools];
  for (let i = 0; i < n; i++) chosen.push(pool.splice(int(0, pool.length - 1), 1)[0]);
  let pcts;
  if (n === 1) pcts = [100];
  else {
    pcts = Array(n).fill(1);
    for (let left = 100 - n; left > 0; left--) pcts[int(0, n - 1)]++;
  }
  const legs = chosen.map((p, i) => ({ pool: p, pct: pcts[i], eco: eco('A-Tier') }));
  if (!valid) {
    const kind = int(0, 3);
    if (kind === 0) legs[0].pct += 1;                         // total != 100
    else if (kind === 1) legs[0].pool = A.pools[3];             // not whitelisted (index 3 never whitelisted unless fuzzed in)
    else if (kind === 2 && legs.length > 1) legs[1].pool = legs[0].pool; // duplicate
    else legs.push({ pool: A.pools[0], pct: 0, eco: eco('A-Tier') });    // zero leg
  }
  return legs;
}

const legsAreValid = (legs) =>
  legs.length >= 1 && legs.length <= 8 &&
  legs.every((l, i) => l.pct > 0 && model.wl.has(l.pool) && legs.findIndex((x) => x.pool === l.pool) === i) &&
  legs.reduce((s, l) => s + l.pct, 0) === 100;

for (let step = 1; step <= steps; step++) {
  const action = pick(['deposit', 'deposit', 'execute', 'execute', 'reject', 'cancel', 'wl', 'badcaller']);
  const open = [...model.pending.keys()];

  if (action === 'deposit') {
    const ui = int(0, users.length - 1);
    const amount = parseEther(String(int(1, 50) / 10)) + BigInt(int(0, 999));
    const prompt = `intent ${step} ${'x'.repeat(int(0, 40))}`;
    const tx = await as(users[ui]).depositIntent(prompt, { value: amount });
    await tx.wait();
    model.count++;
    model.pending.set(model.count, { user: A.users[ui], ui, amount, promptHash: keccak256(toUtf8Bytes(prompt)) });
    stats.deposit++;
  } else if (action === 'execute' && open.length) {
    const nonce = pick(open);
    const it = model.pending.get(nonce);
    const valid = rnd() < 0.6;
    const legs = randomLegs(valid);
    const expectOk = legsAreValid(legs);
    const args = [nonce, it.user, it.amount, it.promptHash, legs];
    const name = await revertName(as(relayer).executeAdjudicatedIntent, args);
    if (expectOk) {
      assert.equal(name, null, `step ${step}: valid execute reverted with ${name}`);
      const poolsBefore = Object.fromEntries(await Promise.all(A.pools.map(async (p) => [p, await bal(p)])));
      await (await as(relayer).executeAdjudicatedIntent(...args)).wait();
      // I3: exact shares, remainder to last leg
      let remaining = it.amount;
      for (let i = 0; i < legs.length; i++) {
        const share = i === legs.length - 1 ? remaining : (it.amount * BigInt(legs[i].pct)) / 100n;
        remaining -= share;
        assert.equal((await bal(legs[i].pool)) - poolsBefore[legs[i].pool], share, `step ${step}: leg ${i} share`);
      }
      model.pending.delete(nonce);
      model.settled.add(nonce);
      stats.execute++;
    } else {
      assert.notEqual(name, null, `step ${step}: invalid legs were accepted`);
      stats.revertsChecked++;
      // I2: actually mine the reverting transaction (explicit gas limit skips estimation) and compare state.
      const before = await snapshot();
      let mined = false;
      try { await (await as(relayer).executeAdjudicatedIntent(...args, { gasLimit: 3_000_000 })).wait(); mined = true; } catch { /* expected revert */ }
      assert.equal(mined, false, `step ${step}: invalid execute succeeded`);
      assert.deepEqual(await snapshot(), before, `step ${step}: reverted execute changed state (I2)`);
    }
  } else if (action === 'reject' && open.length) {
    const nonce = pick(open);
    const it = model.pending.get(nonce);
    const u0 = await bal(it.user);
    await (await as(relayer).rejectIntent(nonce, it.user, it.amount, it.promptHash)).wait();
    assert.equal((await bal(it.user)) - u0, it.amount, `step ${step}: reject refund`);
    model.pending.delete(nonce);
    model.settled.add(nonce);
    stats.reject++;
  } else if (action === 'cancel' && open.length) {
    const nonce = pick(open);
    const it = model.pending.get(nonce);
    const wrongUser = rnd() < 0.4;
    const caller = wrongUser ? users[(it.ui + 1) % users.length] : users[it.ui];
    const name = await revertName(as(caller).cancelIntent, [nonce, it.amount, it.promptHash]);
    if (wrongUser) {
      assert.equal(name, 'IntentNotPending', `step ${step}: stranger cancelled (I5)`);
      stats.revertsChecked++;
    } else {
      assert.equal(name, null);
      const u0 = await bal(it.user);
      const rc = await (await as(caller).cancelIntent(nonce, it.amount, it.promptHash)).wait();
      assert.equal((await bal(it.user)) - u0 + rc.gasUsed * rc.gasPrice, it.amount, `step ${step}: cancel refund`);
      model.pending.delete(nonce);
      model.settled.add(nonce);
      stats.cancel++;
    }
  } else if (action === 'wl') {
    const p = pick(A.pools);
    const on = rnd() < 0.5;
    await (await as(owner).setPoolWhitelisted(p, on)).wait();
    on ? model.wl.add(p) : model.wl.delete(p);
    assert.equal(await vault.whitelisted(p), on);
    stats.wl++;
  } else if (action === 'badcaller') {
    // I5: non-relayer settle, non-owner whitelist
    const stranger = pick([users[0], users[1], owner]);
    if (open.length) {
      const nonce = pick(open);
      const it = model.pending.get(nonce);
      assert.equal(await revertName(as(stranger).executeAdjudicatedIntent, [nonce, it.user, it.amount, it.promptHash, randomLegs(true)]), 'NotRelayer');
      assert.equal(await revertName(as(stranger).rejectIntent, [nonce, it.user, it.amount, it.promptHash]), 'NotRelayer');
      stats.revertsChecked += 2;
    }
    assert.equal(await revertName(as(users[0]).setPoolWhitelisted, [A.pools[3], true]), 'NotOwner');
    stats.revertsChecked++;
  }

  // I4: settled intents can never settle again
  if (model.settled.size && rnd() < 0.3) {
    const nonce = pick([...model.settled]);
    assert.equal(await revertName(as(relayer).rejectIntent, [nonce, A.users[0], 1n, ZERO]), 'IntentNotPending', `step ${step}: replay (I4)`);
    stats.revertsChecked++;
  }

  // I1: conservation
  const expected = [...model.pending.values()].reduce((s, i) => s + i.amount, 0n);
  assert.equal(await bal(vaultAddr), expected, `step ${step}: vault balance != pending total (I1)`);
}

console.log(`fuzz ok: ${steps} steps, seed ${seed}`, JSON.stringify(stats));
process.exit(0);
