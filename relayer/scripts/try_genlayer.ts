import 'dotenv/config';
import { triggerGenLayerAdjudication } from '../src/genlayer_client.js';
const [nonce, prompt] = [Number(process.argv[2] ?? 9001), process.argv[3] ?? 'Maximize yield but only A-Tier Carbon pools, minimum 12% APY.'];
const r = await triggerGenLayerAdjudication(`0:debug:${nonce}`, nonce, prompt, '10000000000000000000');
console.log(JSON.stringify(r, null, 1));
process.exit(0);
