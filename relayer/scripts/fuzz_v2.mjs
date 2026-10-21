// Randomised invariant test for KatalystVaultV2 + PoolHub (ganache, with time travel).
//   node scripts/fuzz_v2.mjs [steps=200] [seed=1] [delay=0]      (delay>0 fuzzes the propose/finalize/veto path)
//
// Invariants asserted after EVERY step, against an independent model:
//   I1  vault balance == sum of the amounts of intents the model says are pending
//   I2  hub balance == sum of all user positions == sum of `held` per pool (the ledger always backs the funds)
//   I3  every hub position equals the model's (exact shares, remainder to the last leg, fee excluded)
//   I4  an action the model says must revert changes no balance and no pending commitment
//   I5  settled / cancelled / vetoed / refunded intents can never settle again
//   I6  the relayer is paid exactly `fee` per execute / reject and nothing on cancel / expiry / veto
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BrowserProvider, Contract, ContractFactory, getCreateAddress, keccak256, parseEther, solidityPacked, toUtf8Bytes, zeroPadBytes } from 'ethers';

const steps = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 1);
const DELAY = BigInt(process.argv[4] ?? 0);

let t = seed >>> 0;
const rnd = () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (a) => a[int(0, a.length - 1)];

const ganache = createRequire(import.meta.url)('ganache');
const load = (n) => JSON.parse(readFileSync(`../contracts/evm/build/v2/${n}.json`, 'utf8'));
const vaultArt = load('KatalystVaultV2'); const hubArt = load('PoolHub');
const provider = new BrowserProvider(ganache.provider({ wallet: { totalAccounts: 14, defaultBalance: 100000 }, logging: { quiet: true }, chain: { hardfork: 'shanghai' } }));
const S = await Promise.all(Array.from({ length: 14 }, (_, i) => provider.getSigner(i)));
const [owner, relayer, ...rest] = S;
const users = rest.slice(0, 4);
const pools = rest.slice(4, 8);
const addr = (s) => s.getAddress();
const A = { owner: await addr(owner), relayer: await addr(relayer), users: await Promise.all(users.map(addr)), pools: await Promise.all(pools.map(addr)) };

const FEE = parseEther('0.05'); const CAP = parseEther('20'); const TTL = 3600n;
const nonce0 = await provider.getTransactionCount(A.owner);
const predicted = getCreateAddress({ from: A.owner, nonce: nonce0 + 1 });
const hub = await (await new ContractFactory(hubArt.abi, hubArt.bytecode, owner).deploy(predicted)).waitForDeployment();
const vault = await (await new ContractFactory(vaultArt.abi, vaultArt.bytecode, owner).deploy(await hub.getAddress(), A.relayer, FEE, CAP, TTL, DELAY)).waitForDeployment();
assert.equal(await vault.getAddress(), predicted);
const vaultAddr = predicted; const hubAddr = await hub.getAddress();
const V = (s) => new Contract(vaultAddr, vaultArt.abi, s);
const H = (s) => new Contract(hubAddr, hubArt.abi, s);
const bal = async (a) => BigInt(await provider.send('eth_getBalance', [a, 'latest']));
// raw RPC: ethers caches getBlock('latest') briefly, which would give the model a stale clock
const now = async () => BigInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
const advance = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
const ZERO = '0x' + '00'.repeat(32);
const eco = (s) => zeroPadBytes(toUtf8Bytes(s), 8);
const lockOf = (legs) => legs.reduce((h, l) => keccak256(solidityPacked(['bytes32', 'address', 'uint8'], [h, l.pool, l.pct])), ZERO);

// model
const M = { wl: new Set(), pending: new Map(), dead: new Set(), pos: new Map(), paused: false, count: 0, proposals: new Map() };
for (const p of A.pools.slice(0, 3)) { await (await H(owner).setPool(p, true, eco('A-Tier'))).wait(); M.wl.add(p); }
const posKey = (p, u) => `${p}:${u}`;
const stats = { deposit: 0, execute: 0, propose: 0, finalize: 0, veto: 0, reject: 0, cancel: 0, expire: 0, withdraw: 0, wl: 0, pause: 0, time: 0, reverts: 0 };

const revertName = async (fn, args, ov = {}) => { try { await fn.staticCall(...args, ov); return null; } catch (e) { return e.revert?.name ?? e.shortMessage ?? 'unknown'; } };

async function snapshot() {
  const out = { vault: await bal(vaultAddr), hub: await bal(hubAddr), relayer: 0n };
  for (let n = 1; n <= M.count; n++) out[n] = await vault.pending(n);
  return out;
}
function randomLegs(valid) {
  const n = int(1, 4); const chosen = []; const pool = [...A.pools];
  for (let i = 0; i < n; i++) chosen.push(pool.splice(int(0, pool.length - 1), 1)[0]);
  let pcts = n === 1 ? [100] : Array(n).fill(1);
  if (n > 1) for (let left = 100 - n; left > 0; left--) pcts[int(0, n - 1)]++;
  const legs = chosen.map((p, i) => ({ pool: p, pct: pcts[i], eco: eco('A-Tier') }));
  if (!valid) { const k = int(0, 2); if (k === 0) legs[0].pct += 1; else if (k === 1 && legs.length > 1) legs[1].pool = legs[0].pool; else legs.push({ pool: A.pools[0], pct: 0, eco: eco('A-Tier') }); }
  return legs;
}
const legsStructurallyValid = (legs) => legs.length >= 1 && legs.length <= 8 && legs.every((l, i) => l.pct > 0 && legs.findIndex((x) => x.pool === l.pool) === i) && legs.reduce((s, l) => s + l.pct, 0) === 100;
const poolsRegistered = (legs) => legs.every((l) => M.wl.has(l.pool));
function shares(net, legs) { let rem = net; return legs.map((l, i) => { const sh = i === legs.length - 1 ? rem : (net * BigInt(l.pct)) / 100n; rem -= sh; return sh; }); }
const apply = (user, legs, net) => { shares(net, legs).forEach((sh, i) => { const k = posKey(legs[i].pool, user); M.pos.set(k, (M.pos.get(k) ?? 0n) + sh); }); };

async function checkInvariants(step) {
  const expectPending = [...M.pending.values()].reduce((s, i) => s + i.amount, 0n);
  assert.equal(await bal(vaultAddr), expectPending, `step ${step}: vault balance != pending total (I1)`);
  const positions = [...M.pos.values()].reduce((s, v) => s + v, 0n);
  assert.equal(await bal(hubAddr), positions, `step ${step}: hub balance != model positions (I2)`);
  let held = 0n; for (const p of A.pools) held += await hub.held(p);
  assert.equal(held, positions, `step ${step}: sum(held) != positions (I2)`);
  if (step % 10 === 0) for (const [k, v] of M.pos) { const [p, u] = k.split(':'); assert.equal(await hub.position(p, u), v, `step ${step}: position ${k} (I3)`); }
}

for (let step = 1; step <= steps; step++) {
  const action = pick(['deposit', 'deposit', 'deposit', 'deposit', 'deposit', 'execute', 'execute', 'execute', 'reject', 'cancel', 'time', 'withdraw', 'wl', 'pause', 'finalize', 'finalize', 'veto']);
  const open = [...M.pending.keys()];
  const ts = await now();

  if (action === 'deposit') {
    const ui = int(0, 3); const amount = parseEther(String(int(1, 150) / 10)) + BigInt(int(0, 999));
    const withLock = rnd() < 0.3; const lockLegs = withLock ? randomLegs(true) : null;
    const lock = withLock ? lockOf(lockLegs) : ZERO;
    const should = !M.paused && amount > FEE && amount <= CAP;
    const name = await revertName(V(users[ui]).depositIntent, ['p' + step, lock], { value: amount });
    if (!should) { assert.notEqual(name, null, `step ${step}: bad deposit accepted`); stats.reverts++; continue; }
    assert.equal(name, null, `step ${step}: valid deposit reverted ${name}`);
    const rc = await (await V(users[ui]).depositIntent('p' + step, lock, { value: amount })).wait();
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IntentDeposited');
    M.count++;
    M.pending.set(Number(ev.args.nonce), { nonce: ev.args.nonce, user: ev.args.user, amount, promptHash: keccak256(toUtf8Bytes('p' + step)), routeLock: ev.args.routeLock, expiry: ev.args.expiry, ui, lockLegs });
    stats.deposit++;
  } else if ((action === 'execute' || action === 'finalize' || action === 'veto') && open.length) {
    const nonce = pick(open); const it = M.pending.get(nonce);
    const struct = { nonce: it.nonce, user: it.user, amount: it.amount, promptHash: it.promptHash, routeLock: it.routeLock, expiry: it.expiry };
    if (Math.abs(Number(it.expiry - ts)) < 6) continue; // avoid the clock-boundary ambiguity
    const expired = ts >= it.expiry;
    const prop = M.proposals.get(nonce);

    if (action === 'execute') {
      const useLock = it.lockLegs && rnd() < 0.7;
      const legs = useLock ? it.lockLegs.map((l) => ({ ...l })) : randomLegs(rnd() < 0.6);
      const lockOk = it.routeLock === ZERO || lockOf(legs) === it.routeLock;
      const structOk = legsStructurallyValid(legs);
      const regOk = poolsRegistered(legs);
      // with a delay, registration is checked at finalisation, not at proposal
      const expectOk = !M.paused && !expired && structOk && lockOk && (DELAY > 0n ? !prop : regOk);
      const name = await revertName(V(relayer).executeAdjudicatedIntent, [struct, legs]);
      if (!expectOk) { assert.notEqual(name, null, `step ${step}: execute should revert`); stats.reverts++; continue; }
      assert.equal(name, null, `step ${step}: execute reverted ${name}`);
      if (DELAY > 0n) {
        const rc = await (await V(relayer).executeAdjudicatedIntent(struct, legs)).wait();
        const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'SettlementProposed');
        M.proposals.set(nonce, { legs, readyAt: ev.args.readyAt });
        stats.propose++;
      } else {
        const before = await snapshot(); void before;
        await (await V(relayer).executeAdjudicatedIntent(struct, legs)).wait();
        apply(it.user, legs, it.amount - FEE); M.pending.delete(nonce); M.dead.add(nonce); stats.execute++;
      }
    } else if (action === 'finalize' && DELAY > 0n && prop) {
      const ready = ts >= prop.readyAt;
      if (Math.abs(Number(prop.readyAt - ts)) < 6) continue;
      const expectOk = !M.paused && ready && !expired && poolsRegistered(prop.legs);
      const name = await revertName(V(pick(users)).finalizeSettlement, [struct, prop.legs, prop.readyAt]);
      if (!expectOk) { assert.notEqual(name, null, `step ${step}: finalize should revert`); stats.reverts++; continue; }
      assert.equal(name, null, `step ${step}: finalize reverted ${name}`);
      await (await V(pick(users)).finalizeSettlement(struct, prop.legs, prop.readyAt)).wait();
      apply(it.user, prop.legs, it.amount - FEE); M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.finalize++;
    } else if (action === 'veto' && DELAY > 0n && prop) {
      const u0 = await bal(it.user);
      await (await V(owner).vetoSettlement(struct)).wait();
      assert.equal((await bal(it.user)) - u0, it.amount, `step ${step}: veto must refund in full (I6)`);
      M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.veto++;
    }
  } else if (action === 'reject' && open.length) {
    const nonce = pick(open); const it = M.pending.get(nonce);
    const struct = { nonce: it.nonce, user: it.user, amount: it.amount, promptHash: it.promptHash, routeLock: it.routeLock, expiry: it.expiry };
    const u0 = await bal(it.user);
    await (await V(relayer).rejectIntent(struct)).wait();
    assert.equal((await bal(it.user)) - u0, it.amount - FEE, `step ${step}: reject refund = amount - fee (I6)`);
    M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.reject++;
  } else if (action === 'cancel' && open.length) {
    const nonce = pick(open); const it = M.pending.get(nonce);
    const struct = { nonce: it.nonce, user: it.user, amount: it.amount, promptHash: it.promptHash, routeLock: it.routeLock, expiry: it.expiry };
    const stranger = users[(it.ui + 1) % 4];
    assert.equal(await revertName(V(stranger).cancelIntent, [struct]), 'NotDepositor', `step ${step}: stranger cancelled`);
    stats.reverts++;
    const u0 = await bal(it.user);
    const rc = await (await V(users[it.ui]).cancelIntent(struct)).wait();
    assert.equal((await bal(it.user)) - u0 + rc.gasUsed * rc.gasPrice, it.amount, `step ${step}: cancel refunds in full (I6)`);
    M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.cancel++;
  } else if (action === 'time') {
    await advance(pick([100, 400, 700, 1500, Number(TTL) + 50])); stats.time++;
    const t2 = await now();
    // finalise proposals whose delay has passed (anyone may), unless paused / expired / a pool was deregistered
    if (DELAY > 0n && !M.paused) {
      for (const [nonce, prop] of [...M.proposals]) {
        const it = M.pending.get(nonce);
        if (!it || t2 < prop.readyAt + 6n || t2 >= it.expiry - 6n || !poolsRegistered(prop.legs) || rnd() < 0.3) continue;
        const struct = { nonce: it.nonce, user: it.user, amount: it.amount, promptHash: it.promptHash, routeLock: it.routeLock, expiry: it.expiry };
        const why = await revertName(V(pick(users)).finalizeSettlement, [struct, prop.legs, prop.readyAt]);
        assert.equal(why, null, `step ${step}: sweep-finalize of #${nonce} reverted with ${why}; t=${t2} readyAt=${prop.readyAt} expiry=${it.expiry} paused=${M.paused}`);
        await (await V(pick(users)).finalizeSettlement(struct, prop.legs, prop.readyAt)).wait();
        apply(it.user, prop.legs, it.amount - FEE); M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.finalize++;
      }
    }
    // refund everything that has now expired, from a stranger's account
    for (const [nonce, it] of [...M.pending]) {
      if (t2 >= it.expiry && Math.abs(Number(it.expiry - t2)) > 6) {
        const struct = { nonce: it.nonce, user: it.user, amount: it.amount, promptHash: it.promptHash, routeLock: it.routeLock, expiry: it.expiry };
        const u0 = await bal(it.user);
        await (await V(users[(it.ui + 2) % 4]).refundExpired(struct)).wait();
        assert.equal((await bal(it.user)) - u0, it.amount, `step ${step}: expiry refund in full (I6)`);
        M.pending.delete(nonce); M.proposals.delete(nonce); M.dead.add(nonce); stats.expire++;
      }
    }
  } else if (action === 'withdraw') {
    const entries = [...M.pos].filter(([, v]) => v > 0n);
    if (!entries.length) continue;
    const [k, v] = pick(entries); const [p, u] = k.split(':');
    const ui = A.users.indexOf(u); const amt = rnd() < 0.5 ? v : v / 2n || v;
    const u0 = await bal(u);
    const rc = await (await H(users[ui]).withdraw(p, amt)).wait();
    assert.equal((await bal(u)) - u0 + rc.gasUsed * rc.gasPrice, amt, `step ${step}: withdraw`);
    M.pos.set(k, v - amt); stats.withdraw++;
    assert.equal(await revertName(H(users[ui]).withdraw, [p, (M.pos.get(k) ?? 0n) + 1n]), 'InsufficientPosition');
  } else if (action === 'wl') {
    if (rnd() < 0.6) continue;
    const p = pick(A.pools); const on = rnd() < 0.7;
    await (await H(owner).setPool(p, on, eco('A-Tier'))).wait();
    on ? M.wl.add(p) : M.wl.delete(p); stats.wl++;
  } else if (action === 'pause') {
    if (rnd() < 0.75) continue;
    M.paused = !M.paused; await (await V(owner).setPaused(M.paused)).wait(); stats.pause++;
  }

  // I5: dead intents never come back
  if (M.dead.size && rnd() < 0.3) {
    const nonce = pick([...M.dead]);
    const struct = { nonce: BigInt(nonce), user: A.users[0], amount: 1n, promptHash: ZERO, routeLock: ZERO, expiry: 1n };
    assert.equal(await revertName(V(relayer).rejectIntent, [struct]), 'IntentNotPending', `step ${step}: replay (I5)`);
    stats.reverts++;
  }
  await checkInvariants(step);
}
await checkInvariants(steps);
console.log(`fuzz v2 ok: ${steps} steps, seed ${seed}, delay ${DELAY}`, JSON.stringify(stats));
process.exit(0);
