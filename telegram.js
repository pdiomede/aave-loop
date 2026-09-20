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
 * Plain text by default, and every caller that carries a figure or a name from
 * outside this app leaves it that way. In HTML or Markdown a group name with an
 * underscore or a `<` in it fails the whole send, and the first anyone would
 * know is a message that never arrived.
 *
 * `parseMode` is opt-in for the one case that has earned it: a table of numbers
 * this app built itself. Telegram draws message text in a proportional font, so
 * columns only line up inside a `<pre>`, and a report nobody can read down is
 * not much of a report. Whatever asks for it escapes its own content and has a
 * plain-text fallback ready.
 *
 * `chatId` names a chat other than TELEGRAM_CHAT_ID, and only the bot replying
 * to a command passes it: an answer belongs in the chat that asked, which is
 * not the group when the question was typed in a private chat. Everything sent
 * on a timer - alerts above all - leaves it out and goes to the group.
 */
export async function sendTelegramMessage(text, { parseMode = null, chatId: to = null } = {}) {
  const { configured, token, chatId, reason } = telegramConfig();
  if (!configured) return { ok: false, retryable: false, error: reason };

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        chat_id: to ?? chatId,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok) return { ok: true, retryable: false, error: null };

    const described = redact(body?.description || `Telegram answered ${res.status}.`);
    // 5xx is Telegram having a bad minute, and 429 is it asking us to slow
    // down - both are worth trying again. Anything else it said about our
    // request will be just as true the next time we ask.
    //
    // 429 was the one this got wrong. Telegram rate limits a bot per chat, and
    // a flood controlled alert was filed under "it will never work", which left
    // the row marked fired and the message never sent. It is the one failure
    // that is certain to pass on its own.
    const retryable = res.status >= 500 || res.status === 429;
    return { ok: false, retryable, error: described };
  } catch (err) {
    const message =
      err.name === 'TimeoutError' ? 'Telegram did not answer in time.' : redact(err.message);
    return { ok: false, retryable: true, error: message };
  }
}
