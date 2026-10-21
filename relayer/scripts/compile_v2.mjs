// Compile contracts/evm/v2/*.sol -> contracts/evm/build/v2/<Contract>.json
//   node scripts/compile_v2.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const solc = require('solc');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/evm/v2');
const outDir = path.resolve(root, '../build/v2');

const sources = Object.fromEntries(
  readdirSync(root).filter((f) => f.endsWith('.sol')).map((f) => [f, { content: readFileSync(path.join(root, f), 'utf8') }]),
);

const runs = Number(process.env.OPT_RUNS ?? 1);
const input = {
  language: 'Solidity',
  sources,
  settings: {
    // Size matters: PortaldotV3 charges ~0.06 tPOT per byte of contract code.
    optimizer: { enabled: true, runs },
    evmVersion: 'paris',
    viaIR: process.env.VIA_IR !== '0', // the IR pipeline cuts bytecode ~25%; set VIA_IR=0 to compare
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) console.log(e.formattedMessage);
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);

mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces
    const artifact = { contractName: name, solc: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object };
    writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifact, null, 2));
    const init = c.evm.bytecode.object.length / 2;
    const runtime = c.evm.deployedBytecode.object.length / 2;
    total += runtime;
    console.log(`${name.padEnd(18)} init ${String(init).padStart(5)} B   runtime ${String(runtime).padStart(5)} B   (~${(init * 0.0695).toFixed(0)} tPOT to deploy)`);
  }
}
console.log(`total runtime ${total} B`);
