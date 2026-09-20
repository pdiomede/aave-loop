/**
 * Sending a message to a Telegram group.
 *
 * One call, one message, and a result that says which of the two kinds of
 * failure happened. That distinction is the only interesting thing in here:
 * a timeout leaves us genuinely unsure whether the message arrived, so it is
 * worth trying again, while Telegram answering "no such chat" will say the
 * same thing forever and retrying it is just noise in the group's stead.
 */
import { telegramConfig } from './config.js';

const API = (process.env.MYAAVE_TELEGRAM_URL || 'https://api.telegram.org').replace(/\/+$/, '');

// Longer than a price lookup. This runs on a timer nobody is waiting on, and
// a message worth sending is worth waiting a moment for.
const TIMEOUT_MS = 10_000;

/**
 * The token appears in the URL, and Node puts the URL in some of its network
 * errors. Every string leaving this module goes through here first, so a token
 * cannot reach a log file or a browser by accident.
 */
const redact = (text) => String(text ?? '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');

/**
 * Send one message. Never throws.
 *
 * Deliberately no `parse_mode`. Plain text has nothing to escape; in HTML or
 * Markdown a group name with an underscore or a `<` in it fails the whole
 * send, and the first anyone would know is a message that never arrived.
 */
export async function sendTelegramMessage(text) {
  const { configured, token, chatId, reason } = telegramConfig();
  if (!configured) return { ok: false, retryable: false, error: reason };

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok) return { ok: true, retryable: false, error: null };

    const described = redact(body?.description || `Telegram answered ${res.status}.`);
    // 5xx is Telegram having a bad minute; anything else it said about our
    // request will be just as true the next time we ask.
    return { ok: false, retryable: res.status >= 500, error: described };
  } catch (err) {
    const message =
      err.name === 'TimeoutError' ? 'Telegram did not answer in time.' : redact(err.message);
    return { ok: false, retryable: true, error: message };
  }
}
