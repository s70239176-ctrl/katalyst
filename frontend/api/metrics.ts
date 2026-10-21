import { handleError } from './_lib/config.js';
import { computeStatus, toPrometheus } from './_lib/status.js';

/** Prometheus-format metrics, computed from chain state at scrape time. */
export async function GET(): Promise<Response> {
  try {
    return new Response(toPrometheus(await computeStatus()), { headers: { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' } });
  } catch (err) {
    return handleError(err);
  }
}
