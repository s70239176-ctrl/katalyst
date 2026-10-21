#!/usr/bin/env -S npx tsx
/**
 * katalyst — command-line client built on the Katalyst SDK.
 *
 *   npm --prefix frontend run cli -- preview "Max yield, A-Tier only"
 *   npm --prefix frontend run cli -- verify 8 [--rerun] [--json] [--out proof.json]
 *   npm --prefix frontend run cli -- intent 8
 *   npm --prefix frontend run cli -- validators
 *
 * Configuration (flags or environment):
 *   --vault / KATALYST_VAULT                  vault address (0x…)
 *   --rpc / KATALYST_RPC                      EVM RPC (default: PortaldotV3 testnet)
 *   --deploy-block / KATALYST_DEPLOY_BLOCK    vault deployment block (bounds log scans)
 *   --genlayer / KATALYST_GENLAYER_CONTRACT   solver address (0x…)
 *   --genlayer-chain / KATALYST_GENLAYER_CHAIN   studionet (default) | testnetAsimov | …
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createKatalyst, type CheckStatus } from '../frontend/src/sdk/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: 'string' },
    rpc: { type: 'string' },
    'deploy-block': { type: 'string' },
    genlayer: { type: 'string' },
    'genlayer-chain': { type: 'string' },
    rerun: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, arg] = positionals;
const env = process.env;

function usage(): never {
  console.log(`katalyst <command>

  preview "<prompt>"          Free adjudication preview (nothing is deposited)
  verify <nonce> [--rerun]    Verify a settled intent against both chains; exit code 1 if a check fails
  intent <nonce>              Show the deposit and settlement recorded on Portaldot
  validators                  GenLayer validator participation
  simulate <contract> <method> '<json-args>'   Simulate any GenLayer contract method (free)

Options: --json  --out <file>  --vault  --rpc  --deploy-block  --genlayer  --genlayer-chain`);
  process.exit(command ? 2 : 0);
}
if (values.help || !command) usage();

const vault = values.vault ?? env['KATALYST_VAULT'] ?? env['VITE_VAULT_ADDRESS'];
if (!vault) {
  console.error('Missing vault address: pass --vault or set KATALYST_VAULT');
  process.exit(2);
}
const genlayerContract = values.genlayer ?? env['KATALYST_GENLAYER_CONTRACT'] ?? env['VITE_GENLAYER_CONTRACT'];

const k = createKatalyst({
  vault,
  rpcUrl: values.rpc ?? env['KATALYST_RPC'] ?? 'https://test-evm-rpc-v3.portaldot.dev',
  deployBlock: Number(values['deploy-block'] ?? env['KATALYST_DEPLOY_BLOCK'] ?? 0),
  ...(genlayerContract
    ? { genlayer: { contract: genlayerContract, chain: values['genlayer-chain'] ?? env['KATALYST_GENLAYER_CHAIN'] ?? 'studionet' } }
    : {}),
});

const ICON: Record<CheckStatus, string> = { pass: '✓', fail: '✗', warn: '!', skip: '–' };
const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
const nonceArg = (): number => {
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n < 1) usage();
  return n;
};

async function main(): Promise<void> {
  switch (command) {
    case 'preview': {
      if (!arg) usage();
      const v = await k.preview(arg);
      if (values.json) return console.log(JSON.stringify(v, replacer, 2));
      console.log(`${v.status}${v.reason ? ` — ${v.reason}` : ''}`);
      for (const p of v.trace?.pools ?? []) console.log(`  ${p.decision === 'selected' ? '●' : '○'} ${p.name.padEnd(11)} ${p.apy.toFixed(1)}% ${p.eco.padEnd(7)} ${p.percentage ? p.percentage + '%' : '  —'}  ${p.reason}`);
      return;
    }
    case 'verify': {
      const nonce = nonceArg();
      const proof = await k.verify(nonce, { rerun: values.rerun });
      if (values.out) writeFileSync(values.out, JSON.stringify(proof, replacer, 2));
      if (values.json) console.log(JSON.stringify(proof, replacer, 2));
      else {
        console.log(`Intent #${nonce} on vault ${proof.network.vault}`);
        for (const c of proof.checks) console.log(` ${ICON[c.status]} ${c.label}\n     ${c.detail}`);
        console.log(`\nResult: ${proof.verdict.toUpperCase()}${values.out ? `  (proof written to ${values.out})` : ''}`);
      }
      process.exit(proof.verdict === 'failed' ? 1 : 0);
      return;
    }
    case 'intent': {
      const { deposit, settlement } = await k.getIntent(nonceArg());
      return console.log(JSON.stringify({ deposit, settlement }, replacer, 2));
    }
    case 'simulate': {
      const [, address, method, rawArgs] = positionals;
      if (!address || !method) usage();
      const reader = k.genlayer;
      if (!reader) throw new Error('GenLayer is not configured: pass --genlayer or set KATALYST_GENLAYER_CONTRACT');
      const out = await reader.simulate(method, rawArgs ? (JSON.parse(rawArgs) as unknown[]) : [], address);
      try {
        return console.log(JSON.stringify(JSON.parse(String(out)), null, 2));
      } catch {
        return console.log(String(out));
      }
    }
    case 'validators': {
      const res = await k.validators();
      if (!res) return console.log('This GenLayer network does not expose a transaction listing (or GenLayer is not configured).');
      if (values.json) return console.log(JSON.stringify(res.stats, replacer, 2));
      console.log(`${res.adjudications.length} adjudications`);
      for (const s of res.stats) console.log(`  ${s.address}  ${s.agree}/${s.participations} agree  idle ${s.idle}  ${(s.reliability * 100).toFixed(0)}%`);
      return;
    }
    default:
      usage();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
