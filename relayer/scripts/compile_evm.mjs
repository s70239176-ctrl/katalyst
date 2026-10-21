// Compile contracts/evm/KatalystVault.sol with solc-js -> contracts/evm/build/KatalystVault.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const solc = require('solc');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/evm');
const source = readFileSync(path.join(root, 'KatalystVault.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'KatalystVault.sol': { content: source } },
  settings: {
    // Size matters: PortaldotV3 charges ~0.06 tPOT per byte of contract code.
    optimizer: { enabled: true, runs: 1 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
for (const e of out.errors ?? []) console.log(e.formattedMessage);
if (errors.length) process.exit(1);

const c = out.contracts['KatalystVault.sol'].KatalystVault;
const artifact = {
  contractName: 'KatalystVault',
  solc: solc.version(),
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
};
mkdirSync(path.join(root, 'build'), { recursive: true });
writeFileSync(path.join(root, 'build', 'KatalystVault.json'), JSON.stringify(artifact, null, 2));
console.log(`solc ${artifact.solc}`);
console.log(`init code: ${(artifact.bytecode.length - 2) / 2} bytes, runtime: ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
