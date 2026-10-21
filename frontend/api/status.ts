import { handleError, json } from './_lib/config.js';
import { computeStatus } from './_lib/status.js';

/**
 * Operational status for uptime monitors. HTTP 200 when healthy, 503 when any check fails, so
 * `curl -f` (or a GitHub Actions cron) can alert on it. Includes stuck-intent detection.
 */
export async function GET(): Promise<Response> {
  try {
    const status = await computeStatus();
    return json(status, status.ok ? 200 : 503);
  } catch (err) {
    return handleError(err);
  }
}
