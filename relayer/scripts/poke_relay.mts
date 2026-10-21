import { GET as relay } from '../../frontend/api/relay.ts';
const nonce = process.argv[2]; const block = process.argv[3]; const gl = process.argv[4];
const q = new URLSearchParams({ nonce, block }); if (gl) q.set('gl', gl);
const t = Date.now();
const res = await relay(new Request(`http://local/api/relay?${q}`));
const body: any = await res.json();
console.log(`HTTP ${res.status} in ${((Date.now() - t) / 1000).toFixed(1)}s`, JSON.stringify({ phase: body.phase, glTx: body.glTx, votes: body.genlayer && `${body.genlayer.validatorsAgreed}/${body.genlayer.validatorsTotal}`, portaldot: body.portaldot?.txHash, refund: body.refund?.amount, error: body.error }));
process.exit(0);
