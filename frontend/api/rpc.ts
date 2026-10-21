/**
 * Read-only JSON-RPC proxy for the browser:  POST /api/rpc?chain=<key>
 *
 * The public Portaldot RPC sometimes answers throttled or failed requests without CORS headers, which the browser
 * reports as an opaque "blocked by CORS" error. Going through this same-origin endpoint removes CORS from the picture
 * and lets the server retry transient failures. Only read methods are forwarded: transactions are signed and sent by
 * the user's own wallet, never through here.
 */
import { chainByKey, handleError, json, retry } from './_lib/config.js';

const ALLOWED = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBalance',
  'eth_getLogs',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);

interface RpcRequest {
  id?: unknown;
  jsonrpc?: string;
  method?: unknown;
  params?: unknown;
}

const MAX_BODY = 20_000;

async function forward(rpcUrl: string, req: RpcRequest): Promise<unknown> {
  const method = typeof req.method === 'string' ? req.method : '';
  if (!ALLOWED.has(method)) {
    return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `Method ${method || '(none)'} is not available through this proxy` } };
  }
  return retry(async () => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: req.id ?? 1, method, params: req.params ?? [] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    return (await res.json()) as unknown;
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const chain = chainByKey(new URL(request.url).searchParams.get('chain'));
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'request too large' }, 413);
    const body = JSON.parse(text) as RpcRequest | RpcRequest[];
    if (Array.isArray(body)) {
      if (body.length > 20) return json({ error: 'too many requests in a batch' }, 400);
      return json(await Promise.all(body.map((r) => forward(chain.rpcUrl, r))));
    }
    return json(await forward(chain.rpcUrl, body));
  } catch (err) {
    return handleError(err);
  }
}
