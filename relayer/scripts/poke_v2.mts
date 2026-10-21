// Advance v2 intents through the serverless relay until they reach a terminal state.
//   node --env-file=.env --import tsx scripts/poke_v2.mts 1 2 4
process.env['VAULTS'] = JSON.stringify([
  {
    key: 'portaldot-v2',
    name: 'Portaldot V3 Testnet (v2)',
    chainId: 420420777,
    rpcUrl: process.env['PORTALDOT_EVM_RPC'],
    vault: process.env['VAULT_V2_ADDRESS'],
    version: 2,
    deployBlock: Number(process.env['VAULT_V2_DEPLOY_BLOCK']),
    explorerBlockUrl: 'https://node-console.portaldot.dev/#/explorer/query/{block}',
  },
]);
const { GET: relay } = await import('../../frontend/api/relay.ts');

const terminal = ['executed', 'rejected', 'cancelled', 'expired', 'vetoed', 'lock_mismatch', 'not_found'];
for (const arg of process.argv.slice(2)) {
  const nonce = Number(arg);
  let gl: string | undefined;
  for (let i = 0; i < 30; i++) {
    const q = new URLSearchParams({ nonce: String(nonce), chain: 'portaldot-v2' });
    if (gl) q.set('gl', gl);
    const body: any = await (await relay(new Request(`http://local/api/relay?${q}`))).json();
    gl = body.glTx ?? body.genlayer?.txHash ?? gl;
    console.log(`#${nonce} phase=${body.phase ?? 'error'}${body.proposal?.secondsLeft !== undefined ? ' left=' + body.proposal.secondsLeft + 's' : ''}${body.error ? ' ' + String(body.error).slice(0, 120) : ''}`);
    if (terminal.includes(body.phase) || body.error) break;
    await new Promise((r) => setTimeout(r, 6000));
  }
}
process.exit(0);
