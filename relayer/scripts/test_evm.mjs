// Local logic tests for KatalystVault on an in-process EVM (ganache). Run: node scripts/test_evm.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BrowserProvider, ContractFactory, Contract, keccak256, toUtf8Bytes, parseEther, encodeBytes32String, zeroPadBytes, toUtf8Bytes as u8 } from 'ethers';

const ganache = createRequire(import.meta.url)('ganache');
const art = JSON.parse(readFileSync('../contracts/evm/build/KatalystVault.json', 'utf8'));
const provider = new BrowserProvider(
  ganache.provider({ wallet: { totalAccounts: 10, defaultBalance: 1000 }, logging: { quiet: true }, chain: { hardfork: 'shanghai' } }),
);
const [owner, relayer, user, other, poolA, poolB, poolC, rogue] = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => provider.getSigner(i)));
const addr = async (s) => s.getAddress();
const eco = (s) => zeroPadBytes(u8(s), 8); // bytes8, right-padded

const factory = new ContractFactory(art.abi, art.bytecode, owner);
const vault = await (await factory.deploy(await addr(relayer), [await addr(poolA), await addr(poolB)])).waitForDeployment();
const V = (s) => new Contract(await_addr, art.abi, s);
const await_addr = await vault.getAddress();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const reverts = async (p, name) => {
  try { await p; } catch (e) {
    const n = e.revert?.name ?? e.shortMessage;
    assert.equal(n, name, `expected ${name}, got ${n}`); return;
  }
  assert.fail(`expected revert ${name}`);
};

const prompt = 'A-Tier only, max yield';
const pHash = keccak256(toUtf8Bytes(prompt));
const deposit = async (s, v) => {
  const tx = await V(s).depositIntent(prompt, { value: v });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IntentDeposited');
  return { nonce: ev.args.nonce, user: ev.args.user, amount: ev.args.amount, prompt: ev.args.prompt };
};
const legs = (a) => a.map(([s, pct]) => ({ pool: s, pct, eco: eco('A-Tier') }));
const bal = async (a) => BigInt(await provider.send('eth_getBalance', [a, 'latest'])); // bypass ethers' short-lived cache

await test('deposit emits event, stores one commitment', async () => {
  const d = await deposit(user, parseEther('10'));
  assert.equal(d.nonce, 1n); assert.equal(d.amount, parseEther('10')); assert.equal(d.prompt, prompt);
  assert.notEqual(await vault.pending(1n), '0x' + '00'.repeat(32));
});
await test('deposit rejects zero value and empty prompt', async () => {
  await reverts(V(user).depositIntent.staticCall(prompt, { value: 0 }), 'InsufficientPayment');
  await reverts(V(user).depositIntent.staticCall('', { value: 1 }), 'InvalidPrompt');
});
const A = await addr(poolA), B = await addr(poolB), R = await addr(rogue), U = await addr(user), O = await addr(other);
const amt = parseEther('10');
await test('only relayer may execute', async () => {
  await reverts(V(other).executeAdjudicatedIntent.staticCall(1n, U, amt, pHash, legs([[A, 60], [B, 40]])), 'NotRelayer');
});
await test('rejects bad totals, rogue pool, duplicate, empty, zero pct', async () => {
  const x = (l) => V(relayer).executeAdjudicatedIntent.staticCall(1n, U, amt, pHash, l);
  await reverts(x(legs([[A, 60], [B, 30]])), 'InvalidAllocation');
  await reverts(x(legs([[A, 50], [R, 50]])), 'PoolNotWhitelisted');
  await reverts(x(legs([[A, 50], [A, 50]])), 'InvalidAllocation');
  await reverts(x([]), 'InvalidAllocation');
  await reverts(x(legs([[A, 100], [B, 0]])), 'InvalidAllocation');
});
await test('commitment binds user, amount and prompt', async () => {
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(1n, O, amt, pHash, legs([[A, 100]])), 'IntentNotPending');
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(1n, U, amt + 1n, pHash, legs([[A, 100]])), 'IntentNotPending');
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(1n, U, amt, keccak256(toUtf8Bytes('evil')), legs([[A, 100]])), 'IntentNotPending');
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(99n, U, amt, pHash, legs([[A, 100]])), 'IntentNotPending');
});
await test('valid execute splits funds exactly (dust to last leg) and blocks replay', async () => {
  const d = await deposit(user, parseEther('10') + 1n); // 2nd intent with indivisible amount
  const a0 = await bal(A), b0 = await bal(B);
  await (await V(relayer).executeAdjudicatedIntent(d.nonce, U, d.amount, pHash, legs([[A, 57], [B, 43]]))).wait();
  const da = (await bal(A)) - a0, db = (await bal(B)) - b0;
  assert.equal(da, (d.amount * 57n) / 100n);
  assert.equal(da + db, d.amount);
  assert.equal(await vault.pending(d.nonce), '0x' + '00'.repeat(32));
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(d.nonce, U, d.amount, pHash, legs([[A, 100]])), 'IntentNotPending');
});
await test('first intent still settles after the others', async () => {
  const a0 = await bal(A);
  await (await V(relayer).executeAdjudicatedIntent(1n, U, amt, pHash, legs([[A, 100]]))).wait();
  assert.equal((await bal(A)) - a0, amt);
});
await test('reject refunds depositor; cancel only by depositor', async () => {
  const d1 = await deposit(user, parseEther('3'));
  const u0 = await bal(U);
  await (await V(relayer).rejectIntent(d1.nonce, U, d1.amount, pHash)).wait();
  assert.equal((await bal(U)) - u0, d1.amount);
  await reverts(V(relayer).rejectIntent.staticCall(d1.nonce, U, d1.amount, pHash), 'IntentNotPending');

  const d2 = await deposit(user, parseEther('2'));
  await reverts(V(other).cancelIntent.staticCall(d2.nonce, d2.amount, pHash), 'IntentNotPending');
  const u1 = await bal(U);
  const rc = await (await V(user).cancelIntent(d2.nonce, d2.amount, pHash)).wait();
  assert.equal((await bal(U)) - u1 + rc.gasUsed * rc.gasPrice, d2.amount);
});
await test('vault never retains funds after all intents settle', async () => {
  assert.equal(await bal(await_addr), 0n);
});
await test('whitelist is owner-only', async () => {
  await reverts(V(other).setPoolWhitelisted.staticCall(R, true), 'NotOwner');
  await (await V(owner).setPoolWhitelisted(R, true)).wait();
  assert.equal(await vault.whitelisted(R), true);
});
await test('failed transfer reverts the whole settlement', async () => {
  // A contract that rejects value: the vault's own address has no receive(), so whitelist it as a pool.
  await (await V(owner).setPoolWhitelisted(await_addr, true)).wait();
  const d = await deposit(user, parseEther('1'));
  await reverts(V(relayer).executeAdjudicatedIntent.staticCall(d.nonce, U, d.amount, pHash, legs([[await_addr, 100]])), 'TransferFailed');
  assert.notEqual(await vault.pending(d.nonce), '0x' + '00'.repeat(32)); // still pending after revert
});
console.log(`\n${passed} tests passed`);
process.exit(0);
