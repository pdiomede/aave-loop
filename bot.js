/**
 * The bot answering back.
 *
 * Everything else here only ever sends. This reads, which brings two problems
 * that shape the whole file.
 *
 * The first is that Telegram hands each update to exactly one caller of
 * `getUpdates`, and a second caller gets an error rather than a copy. This app
 * can legitimately be running twice against one database - `run_myAave.sh`
 * starts a second copy on the next free port when the first one is in the way -
 * so one of them has to be the one that asks. That is the lease in `bot_state`,
 * taken with the same kind of conditional UPDATE the alerts use to claim a
 * firing. An instance without it never calls Telegram at all, so the ordinary
 * two-instance case costs nothing rather than a stream of conflicts.
 *
 * The second is that a long poll is a request that deliberately does not answer
 * for the best part of a minute. There is no `unref` for a fetch, so shutting
 * down means aborting it; without that, stopping the app would take up to fifty
 * seconds and look like a hang.
 *
 * Only the chat named in `TELEGRAM_CHAT_ID` is answered, plus the private chat
 * with whoever is named in the optional `TELEGRAM_OWNER_ID`. The bot can be
 * found by anyone who knows its name, and `/holding` is the whole of a
 * position, so everyone else is ignored without a reply.
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { db, prepare } from './db.js';
import { telegramConfig } from './config.js';
import { sendTelegramMessage } from './telegram.js';
import { priceMessage, watchMessage, holdingMessage, summaryMessage, helpText } from './report.js';

const OFF = process.env.MYAAVE_BOT_OFF === '1';

/** Telegram holds a long poll open this long before answering with nothing. */
const POLL_S = Number(process.env.MYAAVE_BOT_POLL_S) || 50;

/**
 * Long enough to outlive a whole poll several times over, so a holder that is
 * simply waiting is never mistaken for one that has died.
 */
const LEASE_MS = Number(process.env.MYAAVE_BOT_LEASE_MS) || Math.max(POLL_S * 3000, 120_000);

/**
 * How long an instance without the lease waits before asking for it again.
 *
 * This is the window in which nobody is polling after a holder goes away, so
 * it is also how late a command can be answered when one of two instances is
 * restarted. Commands are not lost meanwhile - Telegram keeps them until
 * somebody asks - only delayed.
 */
const LEASE_RETRY_MS = Number(process.env.MYAAVE_BOT_LEASE_RETRY_MS) || 15_000;

/**
 * A command older than this is confirmed and not answered. Coming back from an
 * afternoon of downtime should not fire an afternoon of replies at once, and a
 * `/watch` from four hours ago is not a request for a report now.
 */
const MAX_AGE_S = Number(process.env.MYAAVE_BOT_MAX_AGE_S) || 600;

const WATCH_MS = Number(process.env.MYAAVE_WATCH_MS) || 1_200_000;

/**
 * A flood costs a bounded number of sends, however long the backlog.
 *
 * This is the only limit, deliberately. A minimum gap between replies was the
 * obvious other one, and it was wrong: the sends are sequential and take a
 * fraction of a second, so any gap worth having would silently swallow the
 * second of two commands typed one after the other - which is exactly how a
 * working bot comes to look broken.
 */
const MAX_PER_BATCH = 10;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

const API = (process.env.MYAAVE_TELEGRAM_URL || 'https://api.telegram.org').replace(/\/+$/, '');

/** A pid alone is recycled, so a restart could look like the previous holder. */
const ME = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const redact = (text) => String(text ?? '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');

const state = { lastError: null, stopped: false, seenForeign: new Set() };

let running = false;
let controller = null;
let sleepTimer = null;
let wake = null;
let backoff = BACKOFF_MIN_MS;

const nowISO = () => new Date().toISOString();

/* -------------------------------------------------------------------- state */

const seedRow = () =>
  prepare('INSERT OR IGNORE INTO bot_state (id, next_offset, watch, updated_at) VALUES (1, 0, 0, @now)');

const selectState = () => prepare('SELECT * FROM bot_state WHERE id = 1');

/**
 * Take the lease, or renew our own. The WHERE clause is the whole of the
 * mutual exclusion: a row held by someone else whose time has not run out
 * matches nothing and the UPDATE changes no rows.
 */
function takeLease() {
  if (!db.open) return false;
  const now = Date.now();
  const changed = prepare(`
    UPDATE bot_state
       SET holder = @me, lease_until = @until, updated_at = @now
     WHERE id = 1
       AND (holder IS NULL OR holder = @me OR lease_until IS NULL OR lease_until <= @now)
  `).run({ me: ME, until: new Date(now + LEASE_MS).toISOString(), now: new Date(now).toISOString() });
  return changed.changes === 1;
}

/**
 * Hand the lease back on the way out, so a restart takes over at once instead
 * of waiting out the clock. On `systemctl restart` that is the difference
 * between working and two minutes of silence.
 */
function releaseLease() {
  if (!db.open) return;
  try {
    prepare(
      'UPDATE bot_state SET holder = NULL, lease_until = NULL, updated_at = @now WHERE id = 1 AND holder = @me',
    ).run({ me: ME, now: nowISO() });
  } catch (err) {
    console.error('Could not release the bot lease:', err.message);
  }
}

/**
 * Move the offset on, and renew the lease, in one statement.
 *
 * Returns false when the lease has gone while we were away, and the caller then
 * drops the batch unhandled rather than answering updates it is no longer
 * entitled to. That is also why this runs before anything is sent: a crash here
 * loses a command, which costs six keystrokes, where the other order could put
 * the same message in the group twice.
 */
function commitOffset(nextOffset) {
  if (!db.open) return false;
  const now = Date.now();
  const changed = prepare(`
    UPDATE bot_state
       SET next_offset = @next, lease_until = @until, updated_at = @now
     WHERE id = 1 AND holder = @me AND lease_until > @now
  `).run({
    next: nextOffset,
    me: ME,
    until: new Date(now + LEASE_MS).toISOString(),
    now: new Date(now).toISOString(),
  });
  return changed.changes === 1;
}

function setWatch(on) {
  if (!db.open) return;
  prepare(
    'UPDATE bot_state SET watch = @on, watch_next_at = @next, updated_at = @now WHERE id = 1',
  ).run({ on: on ? 1 : 0, next: on ? new Date(Date.now() + WATCH_MS).toISOString() : null, now: nowISO() });
}

export function botStatus() {
  const row = db.open ? selectState().get() : null;
  return {
    enabled: !OFF && telegramConfig().configured && !state.stopped,
    me: ME,
    holder: row?.holder ?? null,
    leaseUntil: row?.lease_until ?? null,
    nextOffset: row?.next_offset ?? 0,
    watching: Boolean(row?.watch),
    lastError: state.lastError,
  };
}

/* ------------------------------------------------------------------ sending */

/**
 * One reply. HTML, because the tables only line up inside a `pre`, with a
 * plain-text retry if Telegram will not parse it: a report that silently never
 * arrives is the failure nobody notices.
 */
async function reply(html) {
  const sent = await sendTelegramMessage(html, { parseMode: 'HTML' });
  if (sent.ok) return;

  if (!sent.retryable && /pars|entity|tag/i.test(sent.error || '')) {
    const plain = html.replace(/<[^>]+>/g, '');
    const second = await sendTelegramMessage(plain);
    if (second.ok) {
      console.error('A bot reply would not parse as HTML and was sent as plain text.');
      return;
    }
  }
  state.lastError = sent.error;
  console.error('Could not send a bot reply:', redact(sent.error));
}

/* ------------------------------------------------------------------ parsing */

/**
 * The command in a message, or null.
 *
 * The slash has to be the first character, so "what about /price" says nothing.
 * A `@botname` suffix is how Telegram addresses one bot among several in a
 * group and is not part of the name. Arguments are ignored rather than refused:
 * `/price now` is a request for the price.
 */
export function commandOf(text) {
  if (typeof text !== 'string' || text[0] !== '/') return null;
  const first = text.trim().split(/\s+/)[0];
  const name = first.slice(1).split('@')[0].toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(name) ? name : null;
}

async function textFor(command) {
  switch (command) {
    case 'price':
      return priceMessage();
    case 'holding':
      return holdingMessage();
    case 'summary':
      return summaryMessage();
    case 'watch':
      setWatch(true);
      return `${await watchMessage()}\n\n<i>Watching. The price every ${Math.round(WATCH_MS / 60000)} minutes until /unwatch.</i>`;
    case 'unwatch':
      setWatch(false);
      return 'Stopped. No more price updates.';
    default:
      // Including /help and /start. Telegram sends /start by itself when a chat
      // with a bot is first opened, and an unknown command in your own group
      // reads as a broken bot, so both get the list.
      return helpText();
  }
}

/* --------------------------------------------------------------- the polling */

async function getUpdates(offset) {
  controller = new AbortController();
  // A hard stop a little past Telegram's own, for a connection that dies
  // without saying so. Unreferenced, so it cannot hold the process open.
  const guard = setTimeout(() => controller?.abort(), POLL_S * 1000 + 10_000);
  guard.unref?.();

  try {
    const { token } = telegramConfig();
    const url =
      `${API}/bot${token}/getUpdates?timeout=${POLL_S}&offset=${offset}` +
      // Server-side filtering. Without it, editing an old message arrives as an
      // update of its own and would run the command a second time.
      `&allowed_updates=${encodeURIComponent('["message"]')}`;

    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.ok) {
      const described = redact(body?.description || `Telegram answered ${res.status}.`);
      return { ok: false, status: res.status, error: described };
    }
    return { ok: true, updates: Array.isArray(body.result) ? body.result : [] };
  } finally {
    clearTimeout(guard);
    controller = null;
  }
}

/** Interruptible, so shutting down does not wait out a backoff. */
const sleep = (ms) =>
  new Promise((resolve) => {
    wake = resolve;
    sleepTimer = setTimeout(resolve, ms);
    sleepTimer.unref?.();
  });

/**
 * A failure that will still be a failure next time is not worth repeating.
 * A wrong token answered every second forever is noise nobody will read.
 */
function handleFailure({ status, error }) {
  state.lastError = error;

  if (status === 401 || status === 404) {
    console.error(`Bot commands stopped: Telegram rejected the token (${status}). ${error}`);
    state.stopped = true;
    running = false;
    return;
  }

  if (status === 409) {
    const webhook = /webhook/i.test(error);
    console.error(
      webhook
        ? `Bot commands cannot run while a webhook is set: ${error} Remove it with ` +
            'curl "https://api.telegram.org/bot<token>/deleteWebhook" and restart.'
        : `Another getUpdates caller is active: ${error}`,
    );
    backoff = BACKOFF_MAX_MS;
    return;
  }

  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  console.error('Bot poll failed:', error);
}

/** The price report on its timer, checked while the lease is still ours. */
async function tickWatch(row) {
  if (!row?.watch) return;
  if (row.watch_next_at && row.watch_next_at > nowISO()) return;
  // Written before the send, so a failure cannot turn into a message per tick.
  if (!db.open) return;
  prepare('UPDATE bot_state SET watch_next_at = @next, updated_at = @now WHERE id = 1 AND holder = @me').run(
    { next: new Date(Date.now() + WATCH_MS).toISOString(), now: nowISO(), me: ME },
  );
  await reply(await watchMessage());
}

/**
 * One pass: take the lease, ask, confirm, answer. Exported so it can be driven
 * a step at a time in testing, the way the alert sweep is.
 */
export async function runBotTick() {
  if (!db.open) return { polled: false };

  seedRow().run({ now: nowISO() });
  if (!takeLease()) return { polled: false, reason: 'lease held elsewhere' };

  const row = selectState().get();
  const answer = await getUpdates(row.next_offset);

  if (!answer.ok) {
    handleFailure(answer);
    return { polled: false, error: answer.error };
  }

  backoff = BACKOFF_MIN_MS;
  state.lastError = null;

  const updates = answer.updates;
  if (updates.length) {
    const next = Math.max(...updates.map((u) => u.update_id)) + 1;
    // The lease may have gone while we were waiting. Dropping the batch is the
    // safe half of that: they are still Telegram's to hand to whoever holds it.
    if (!commitOffset(next)) return { polled: true, handled: 0, reason: 'lease lost mid-poll' };
    await handle(updates);
  }

  await tickWatch(selectState().get());
  return { polled: true, handled: updates.length };
}

/**
 * The chats whose commands are answered: the group, and optionally your own
 * private chat with the bot. Nothing else, ever - the bot can be found by
 * anyone who knows its name, and `/holding` is the whole of a position.
 */
function allowedChats() {
  const { chatId, ownerId } = telegramConfig();
  return new Set([chatId, ownerId].filter(Boolean).map(String));
}

async function handle(updates) {
  const allowed = allowedChats();
  let stale = 0;
  let handled = 0;

  for (const update of updates) {
    const msg = update.message;
    if (!msg) continue;

    // Not ours. Confirmed already, so the queue is not blocked by it, and never
    // answered. One line per stranger per run, which is what makes two
    // otherwise baffling cases legible: messaging the bot privately, and a
    // group being upgraded to a supergroup, which changes its id.
    const from = String(msg.chat?.id);
    if (!allowed.has(from)) {
      if (!state.seenForeign.has(from)) {
        state.seenForeign.add(from);
        console.log(
          `A bot command arrived from chat ${from}, which is neither TELEGRAM_CHAT_ID nor ` +
            'TELEGRAM_OWNER_ID. Ignored.',
        );
      }
      continue;
    }

    if (Number.isFinite(msg.date) && Date.now() / 1000 - msg.date > MAX_AGE_S) {
      stale += 1;
      continue;
    }

    const command = commandOf(msg.text);
    if (!command) continue;

    if (handled >= MAX_PER_BATCH) continue;

    handled += 1;
    try {
      await reply(await textFor(command));
    } catch (err) {
      console.error(`Could not answer /${command}:`, redact(err.message));
    }
  }

  if (stale) {
    console.log(`Skipped ${stale} bot command${stale === 1 ? '' : 's'} older than ${MAX_AGE_S} seconds.`);
  }
}

/* ------------------------------------------------------------------- the loop */

async function loop() {
  while (running) {
    try {
      const out = await runBotTick();
      if (!running) break;
      // Without the lease there is nothing to do and nothing to ask, so this
      // instance costs one local UPDATE every half minute and no network at all.
      if (out.polled === false && out.reason === 'lease held elsewhere') await sleep(LEASE_RETRY_MS);
      else if (out.error) await sleep(backoff);
    } catch (err) {
      // An aborted poll on the way out is not a fault.
      if (running && err.name !== 'AbortError') {
        state.lastError = redact(err.message);
        console.error('Bot loop error:', state.lastError);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        await sleep(backoff);
      }
    }
  }
}

export function startBotPoller() {
  if (running) return;

  if (OFF) {
    console.log('Bot commands are off: MYAAVE_BOT_OFF is set.');
    return;
  }
  const { configured, groupName, reason } = telegramConfig();
  if (!configured) {
    console.log(`Bot commands are off: ${reason}`);
    return;
  }

  running = true;
  state.stopped = false;
  const alsoDm = telegramConfig().ownerId ? ' and in your private chat' : '';
  console.log(`Bot commands are listening in ${groupName}${alsoDm}.`);
  loop();
}

/**
 * Synchronous, because the shutdown path in server.js is, and the abort is what
 * makes it immediate: a fetch waiting on a fifty second long poll would
 * otherwise hold the process open for the rest of it.
 */
export function stopBotPoller() {
  if (!running) return;
  running = false;
  controller?.abort();
  clearTimeout(sleepTimer);
  wake?.();
  releaseLease();
}
