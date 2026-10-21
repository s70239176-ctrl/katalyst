/**
 * Optional operator notifications. Configure any of:
 *   NOTIFY_WEBHOOK_URL               generic JSON webhook (Slack, Discord and most chat tools accept {text|content})
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 * Never throws and never blocks settlement for long: failures are logged and ignored.
 */
import { optionalEnv } from './config.js';

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
  const hook = optionalEnv('NOTIFY_WEBHOOK_URL');
  if (hook) jobs.push(post(hook, { text, content: text }));
  const token = optionalEnv('TELEGRAM_BOT_TOKEN');
  const chat = optionalEnv('TELEGRAM_CHAT_ID');
  if (token && chat) jobs.push(post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true }));
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.error('[notify] delivery failed:', r.reason instanceof Error ? r.reason.message : r.reason);
  }
}

export const notifyEnabled = (): boolean => Boolean(optionalEnv('NOTIFY_WEBHOOK_URL') || (optionalEnv('TELEGRAM_BOT_TOKEN') && optionalEnv('TELEGRAM_CHAT_ID')));
