/**
 * Optional operator notifications (NOTIFY_WEBHOOK_URL, or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
 * Never throws; a failed delivery is logged and ignored.
 */
const TIMEOUT_MS = 3_000;

async function post(url: string, body: unknown): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function notify(text: string): Promise<void> {
  const jobs: Promise<void>[] = [];
  const hook = process.env['NOTIFY_WEBHOOK_URL']?.trim();
  if (hook) jobs.push(post(hook, { text, content: text }));
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim();
  const chat = process.env['TELEGRAM_CHAT_ID']?.trim();
  if (token && chat) jobs.push(post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true }));
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.error('[NOTIFY] delivery failed:', r.reason instanceof Error ? r.reason.message : r.reason);
  }
}
