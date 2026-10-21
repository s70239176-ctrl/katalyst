// Scenario tests for KatalystVaultV2 + PoolHub on an in-process EVM (ganache), including time travel.
//   node scripts/compile_v2.mjs && node scripts/test_v2.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  BrowserProvider, Contract, ContractFactory, Interface, getCreateAddress, id, keccak256, parseEther, solidityPacked, toUtf8Bytes, zeroPadBytes,
} from 'ethers';

const ganache = createRequire(import.meta.url)('ganache');
const load = (n) => JSON.parse(readFileSync(`../contracts/evm/build/v2/${n}.json`, 'utf8'));
const vaultArt = load('KatalystVaultV2');
const hubArt = load('PoolHub');
const errors = new Interface([...vaultArt.abi, ...hubArt.abi].filter((x) => x.type === 'error'));

const provider = new BrowserProvider(ganache.provider({ wallet: { totalAccounts: 12, defaultBalance: 100000 }, logging: { quiet: true }, chain: { hardfork: 'shanghai' } }));
const S = await Promise.all(Array.from({ length: 12 }, (_, i) => provider.getSigner(i)));
const [owner, relayer, newRelayer, userA, userB, stranger, newOwner, poolA, poolB, poolC, poolX] = S;
const A = Object.fromEntries(await Promise.all(Object.entries({ owner, relayer, newRelayer, userA, userB, stranger, newOwner, poolA, poolB, poolC, poolX }).map(async ([k, s]) => [k, await s.getAddress()])));

const FEE = parseEther('0.1');
const CAP = parseEther('50');
const TTL = 3600n;
const eco = (s) => zeroPadBytes(toUtf8Bytes(s), 8);
const ZERO32 = '0x' + '00'.repeat(32);
const bal = async (a) => BigInt(await provider.send('eth_getBalance', [a, 'latest']));
const advance = async (secs) => { await provider.send('evm_increaseTime', [Number(secs)]); await provider.send('evm_mine', []); };

/** Deploy a fresh hub + vault pair. The hub needs the vault's address up front: predict it from the deployer's nonce. */
async function deployPair({ delay = 0n, fee = FEE, cap = CAP, ttl = TTL } = {}) {
  const nonce = await provider.getTransactionCount(A.owner);
  const predicted = getCreateAddress({ from: A.owner, nonce: nonce + 1 });
  const hub = await (await new ContractFactory(hubArt.abi, hubArt.bytecode, owner).deploy(predicted)).waitForDeployment();
  const vault = await (await new ContractFactory(vaultArt.abi, vaultArt.bytecode, owner).deploy(await hub.getAddress(), A.relayer, fee, cap, ttl, delay)).waitForDeployment();
  assert.equal(await vault.getAddress(), predicted, 'predicted vault address');
  for (const p of [A.poolA, A.poolB, A.poolC]) await (await hub.connect(owner).setPool(p, true, eco('A-Tier'))).wait();
  return { vault, hub, v: (s) => vault.connect(s), h: (s) => hub.connect(s) };
}

const errName = (e) => {
  try { return errors.parseError(e.data)?.name ?? e.revert?.name ?? e.shortMessage; } catch { return e.revert?.name ?? e.shortMessage; }
};
const reverts = async (p, name) => {
  try { await p; } catch (e) { assert.equal(errName(e), name, `expected ${name}, got ${errName(e)}`); return; }
  assert.fail(`expected revert ${name}`);
};

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

/** Deposit and return the Intent struct exactly as the contract committed to it. */
async function deposit(d, user, amount, { prompt = 'A-Tier only', routeLock = ZERO32 } = {}) {
  const rc = await (await d.v(user).depositIntent(prompt, routeLock, { value: amount })).wait();
  const ev = rc.logs.map((l) => { try { return d.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IntentDeposited');
  return { nonce: ev.args.nonce, user: ev.args.user, amount: ev.args.amount, promptHash: keccak256(toUtf8Bytes(prompt)), routeLock: ev.args.routeLock, expiry: ev.args.expiry };
}
const legs = (a) => a.map(([pool, pct]) => ({ pool, pct, eco: eco('A-Tier') }));
const lockOf = (a) => a.reduce((h, [pool, pct]) => keccak256(solidityPacked(['bytes32', 'address', 'uint8'], [h, pool, pct])), ZERO32);

// ------------------------------------------------------------------------------------------------ deposit
await test('deposit emits the committed intent; enforces fee floor, cap and prompt rules', async () => {
  const d = await deployPair();
  const it = await deposit(d, userA, parseEther('5'));
  assert.equal(it.nonce, 1n);
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  assert.equal(it.expiry, BigInt(block.timestamp) + TTL);
  assert.notEqual(await d.vault.pending(1n), ZERO32);
  await reverts(d.v(userA).depositIntent.staticCall('x', ZERO32, { value: FEE }), 'InsufficientPayment'); // must exceed the fee
  await reverts(d.v(userA).depositIntent.staticCall('x', ZERO32, { value: CAP + 1n }), 'DepositTooLarge');
  await reverts(d.v(userA).depositIntent.staticCall('', ZERO32, { value: parseEther('1') }), 'InvalidPrompt');
});

// ------------------------------------------------------------------------------------------------ settlement
await test('execute: relayer-only, validates the route, pays the hub exactly, fee to the relayer', async () => {
  const d = await deployPair();
  const amount = parseEther('10') + 7n; // indivisible
  const it = await deposit(d, userA, amount);
  const route = [[A.poolA, 57], [A.poolB, 43]];

  await reverts(d.v(stranger).executeAdjudicatedIntent.staticCall(it, legs(route)), 'NotRelayer');
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 60], [A.poolB, 30]])), 'InvalidAllocation'); // != 100
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 50], [A.poolA, 50]])), 'InvalidAllocation'); // duplicate
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 100], [A.poolB, 0]])), 'InvalidAllocation'); // zero leg
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([])), 'InvalidAllocation');
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolX, 100]])), 'PoolNotWhitelisted'); // hub rejects unregistered pool
  // commitment binds every field
  for (const bad of [{ ...it, user: A.userB }, { ...it, amount: it.amount + 1n }, { ...it, promptHash: id('x') }, { ...it, expiry: it.expiry + 1n }, { ...it, nonce: 2n }]) {
    await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(bad, legs(route)), 'IntentNotPending');
  }
  // a tampered route lock is caught by route validation before the commitment check; either way it reverts
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall({ ...it, routeLock: id('lock') }, legs(route)), 'RouteMismatch');

  const r0 = await bal(A.relayer);
  const rc = await (await d.v(relayer).executeAdjudicatedIntent(it, legs(route))).wait();
  const net = amount - FEE;
  const a = (net * 57n) / 100n;
  assert.equal(await d.hub.position(A.poolA, A.userA), a);
  assert.equal(await d.hub.position(A.poolB, A.userA), net - a, 'dust goes to the last leg');
  assert.equal(await d.hub.held(A.poolA) + (await d.hub.held(A.poolB)), net);
  assert.equal((await bal(A.relayer)) - r0 + rc.gasUsed * rc.gasPrice, FEE, 'the relayer receives the fee');
  assert.equal(await bal(await d.vault.getAddress()), 0n, 'the vault retains nothing');
  assert.equal(await d.vault.pending(it.nonce), ZERO32);
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs(route)), 'IntentNotPending'); // replay
});

await test('route lock: the relayer can only settle exactly the route the user previewed', async () => {
  const d = await deployPair();
  const preview = [[A.poolA, 60], [A.poolB, 40]];
  const it = await deposit(d, userA, parseEther('3'), { routeLock: lockOf(preview) });
  assert.equal(it.routeLock, lockOf(preview));
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 61], [A.poolB, 39]])), 'RouteMismatch');
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolB, 40], [A.poolA, 60]])), 'RouteMismatch'); // order matters
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 100]])), 'RouteMismatch');
  await (await d.v(relayer).executeAdjudicatedIntent(it, legs(preview))).wait();
  assert.equal(await d.hub.held(A.poolA) > 0n, true);
});

// ------------------------------------------------------------------------------------------------ fee and exits
await test('fee: taken on reject, never on cancel or expiry', async () => {
  const d = await deployPair();
  const amt = parseEther('4');
  const i1 = await deposit(d, userA, amt);
  const u0 = await bal(A.userA); const r0 = await bal(A.relayer);
  const rc = await (await d.v(relayer).rejectIntent(i1)).wait();
  assert.equal((await bal(A.userA)) - u0, amt - FEE);
  assert.equal((await bal(A.relayer)) - r0 + rc.gasUsed * rc.gasPrice, FEE);
  await reverts(d.v(relayer).rejectIntent.staticCall(i1), 'IntentNotPending');

  const i2 = await deposit(d, userA, amt);
  await reverts(d.v(stranger).cancelIntent.staticCall(i2), 'NotDepositor');
  const u1 = await bal(A.userA);
  const rc2 = await (await d.v(userA).cancelIntent(i2)).wait();
  assert.equal((await bal(A.userA)) - u1 + rc2.gasUsed * rc2.gasPrice, amt, 'cancel refunds in full');
});

await test('C1: anyone can refund an expired intent in full; settlement closes at expiry', async () => {
  const d = await deployPair();
  const amt = parseEther('6');
  const it = await deposit(d, userA, amt);
  await reverts(d.v(stranger).refundExpired.staticCall(it), 'NotExpired');
  await advance(TTL + 5n);
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 100]])), 'Expired');
  const u0 = await bal(A.userA);
  await (await d.v(stranger).refundExpired(it)).wait(); // the stranger pays the gas, the user gets the money
  assert.equal((await bal(A.userA)) - u0, amt, 'the depositor is refunded in full without lifting a finger');
  await reverts(d.v(stranger).refundExpired.staticCall(it), 'IntentNotPending');
  assert.equal(await bal(await d.vault.getAddress()), 0n);
});

// ------------------------------------------------------------------------------------------------ admin
await test('C2: pause blocks deposits and execution but never traps funds', async () => {
  const d = await deployPair();
  const i1 = await deposit(d, userA, parseEther('2'));
  const i2 = await deposit(d, userB, parseEther('2'));
  const i3 = await deposit(d, userA, parseEther('2'));
  await reverts(d.v(stranger).setPaused.staticCall(true), 'NotOwner');
  await (await d.v(owner).setPaused(true)).wait();
  await reverts(d.v(userA).depositIntent.staticCall('x', ZERO32, { value: parseEther('1') }), 'Paused');
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(i1, legs([[A.poolA, 100]])), 'Paused');
  await (await d.v(relayer).rejectIntent(i1)).wait(); // still works
  await (await d.v(userB).cancelIntent(i2)).wait(); // still works
  await advance(TTL + 5n);
  await (await d.v(stranger).refundExpired(i3)).wait(); // still works
  await (await d.v(owner).setPaused(false)).wait();
  assert.equal(await bal(await d.vault.getAddress()), 0n);
});

await test('C2: two-step ownership, relayer rotation, authority follows the owner into the hub', async () => {
  const d = await deployPair();
  await reverts(d.v(stranger).transferOwnership.staticCall(A.newOwner), 'NotOwner');
  await (await d.v(owner).transferOwnership(A.newOwner)).wait();
  assert.equal(await d.vault.owner(), A.owner, 'ownership does not move until accepted');
  await reverts(d.v(stranger).acceptOwnership.staticCall(), 'NotPendingOwner');
  await (await d.v(newOwner).acceptOwnership()).wait();
  assert.equal(await d.vault.owner(), A.newOwner);
  assert.equal(await d.vault.pendingOwner(), '0x' + '00'.repeat(20));
  await reverts(d.v(owner).setPaused.staticCall(true), 'NotOwner');
  await reverts(d.h(owner).setPool.staticCall(A.poolX, true, eco('A-Tier')), 'NotOwner'); // the hub follows the vault's owner
  await (await d.h(newOwner).setPool(A.poolX, true, eco('B-Tier'))).wait();
  assert.equal(await d.hub.isPool(A.poolX), true);

  await (await d.v(newOwner).setRelayer(A.newRelayer)).wait();
  const it = await deposit(d, userA, parseEther('2'));
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 100]])), 'NotRelayer'); // old relayer is out
  await (await d.v(newRelayer).executeAdjudicatedIntent(it, legs([[A.poolA, 100]]))).wait();
});

// ------------------------------------------------------------------------------------------------ hub
await test('C6: hub positions — only the vault deposits, users withdraw their own funds, even while paused', async () => {
  const d = await deployPair();
  const it = await deposit(d, userA, parseEther('10'));
  await (await d.v(relayer).executeAdjudicatedIntent(it, legs([[A.poolA, 70], [A.poolB, 30]]))).wait();
  const mine = await d.hub.position(A.poolA, A.userA);

  await reverts(d.h(stranger).depositFor.staticCall(A.poolA, A.stranger, { value: 1n }), 'NotVault');
  await reverts(d.h(userB).withdraw.staticCall(A.poolA, 1n), 'InsufficientPosition'); // someone else's money
  await reverts(d.h(userA).withdraw.staticCall(A.poolA, mine + 1n), 'InsufficientPosition');
  await reverts(d.h(userA).withdraw.staticCall(A.poolA, 0n), 'InsufficientPosition');

  await (await d.v(owner).setPaused(true)).wait();
  const u0 = await bal(A.userA);
  const rc = await (await d.h(userA).withdraw(A.poolA, mine / 2n)).wait();
  assert.equal((await bal(A.userA)) - u0 + rc.gasUsed * rc.gasPrice, mine / 2n);
  await (await d.h(userA).withdraw(A.poolA, mine - mine / 2n)).wait();
  assert.equal(await d.hub.position(A.poolA, A.userA), 0n);
  assert.equal(await d.hub.held(A.poolA), 0n);

  await (await d.h(owner).setPool(A.poolB, false, eco('A-Tier'))).wait();
  const it2 = await deposit(d, userB, parseEther('2')).catch(() => null); // paused: deposit blocked
  assert.equal(it2, null);
});

// ------------------------------------------------------------------------------------------------ C7
await test('C7: with a delay the relayer only proposes; anyone finalises; the owner can veto', async () => {
  const DELAY = 600n;
  const d = await deployPair({ delay: DELAY });
  const route = [[A.poolA, 50], [A.poolB, 50]];
  const amt = parseEther('8');

  // proposal does not move funds
  const it = await deposit(d, userA, amt);
  const rc = await (await d.v(relayer).executeAdjudicatedIntent(it, legs(route))).wait();
  const ev = rc.logs.map((l) => { try { return d.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'SettlementProposed');
  const readyAt = ev.args.readyAt;
  assert.equal(await d.hub.held(A.poolA), 0n, 'nothing is paid at proposal time');
  assert.equal(await bal(await d.vault.getAddress()), amt);
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs(route)), 'AlreadyProposed');
  await reverts(d.v(stranger).finalizeSettlement.staticCall(it, legs(route), readyAt), 'NotReady');
  await advance(DELAY + 5n);
  await reverts(d.v(stranger).finalizeSettlement.staticCall(it, legs([[A.poolA, 70], [A.poolB, 30]]), readyAt), 'NoProposal'); // different route
  await reverts(d.v(stranger).finalizeSettlement.staticCall(it, legs(route), readyAt + 1n), 'NoProposal');
  await (await d.v(stranger).finalizeSettlement(it, legs(route), readyAt)).wait(); // a stranger can finalise
  assert.equal(await d.hub.held(A.poolA) + (await d.hub.held(A.poolB)), amt - FEE);

  // veto: refunds the depositor in full, fee-free
  const i2 = await deposit(d, userB, amt);
  const rc2 = await (await d.v(relayer).executeAdjudicatedIntent(i2, legs(route))).wait();
  const r2 = rc2.logs.map((l) => { try { return d.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'SettlementProposed').args.readyAt;
  await reverts(d.v(stranger).vetoSettlement.staticCall(i2), 'NotOwner');
  const u0 = await bal(A.userB);
  await (await d.v(owner).vetoSettlement(i2)).wait();
  assert.equal((await bal(A.userB)) - u0, amt, 'the veto refunds in full');
  await advance(DELAY + 5n);
  await reverts(d.v(stranger).finalizeSettlement.staticCall(i2, legs(route), r2), 'NoProposal'); // gone
  await reverts(d.v(owner).vetoSettlement.staticCall(i2), 'NoProposal');

  // the depositor can still cancel during the delay, which clears the proposal
  const i3 = await deposit(d, userA, amt);
  const rc3 = await (await d.v(relayer).executeAdjudicatedIntent(i3, legs(route))).wait();
  const r3 = rc3.logs.map((l) => { try { return d.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'SettlementProposed').args.readyAt;
  await (await d.v(userA).cancelIntent(i3)).wait();
  await advance(DELAY + 5n);
  await reverts(d.v(stranger).finalizeSettlement.staticCall(i3, legs(route), r3), 'NoProposal');
  assert.equal(await bal(await d.vault.getAddress()), 0n);
});

await test('C7: a pause blocks finalisation, and an intent that expires mid-delay is refundable, not payable', async () => {
  const d = await deployPair({ delay: 600n, ttl: 700n });
  const route = [[A.poolA, 100]];
  const it = await deposit(d, userA, parseEther('2'));
  const rc = await (await d.v(relayer).executeAdjudicatedIntent(it, legs(route))).wait();
  const readyAt = rc.logs.map((l) => { try { return d.vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'SettlementProposed').args.readyAt;
  await advance(610n);
  await (await d.v(owner).setPaused(true)).wait();
  await reverts(d.v(stranger).finalizeSettlement.staticCall(it, legs(route), readyAt), 'Paused');
  await (await d.v(owner).setPaused(false)).wait();
  await advance(200n); // past expiry (700s)
  await reverts(d.v(stranger).finalizeSettlement.staticCall(it, legs(route), readyAt), 'Expired');
  const u0 = await bal(A.userA);
  await (await d.v(stranger).refundExpired(it)).wait();
  assert.equal((await bal(A.userA)) - u0, parseEther('2'));
});

await test('a failed hub payment reverts the whole settlement and leaves the intent pending', async () => {
  const d = await deployPair();
  const it = await deposit(d, userA, parseEther('2'));
  await (await d.h(owner).setPool(A.poolC, false, eco('A-Tier'))).wait(); // deregistered between propose and pay
  await reverts(d.v(relayer).executeAdjudicatedIntent.staticCall(it, legs([[A.poolA, 50], [A.poolC, 50]])), 'PoolNotWhitelisted');
  assert.notEqual(await d.vault.pending(it.nonce), ZERO32, 'still pending after the revert');
});

console.log(`\n${passed} v2 tests passed`);
process.exit(0);
