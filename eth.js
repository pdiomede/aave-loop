/**
 * What ETH is worth right now.
 *
 * The second module here that touches the network, and it is shaped like the
 * first one on purpose: a timeout so a stalled service cannot hold anything
 * open, a cooldown so a dead network is asked once a minute rather than on
 * every tick, a cache so a repeat question costs nothing, and a status object
 * the interface can show instead of a stack trace.
 *
 * CoinGecko, because it answers without a key or an account. The cost of that
 * is a rate limit shared with everyone else on the address, which is why 429
 * is handled apart from every other failure below.
 *
 * Where `fx.js` deals in a rate published once per day and true forever, this
 * deals in a number that is stale the moment it arrives. So the cache is a
 * single row with the time on it, and every reader decides how old is too old.
 */
import { db, prepare } from './db.js';
import { parseAmount } from './lib/calc.js';

const ETH_URL = (process.env.MYAAVE_ETH_URL || 'https://api.coingecko.com/api/v3').replace(
  /\/+$/,
  '',
);
const OFFLINE = process.env.MYAAVE_ETH_OFFLINE === '1';

/**
 * One coin, one call, and every window anything here reports.
 *
 * 1h is for the ticker in the page header and 30d is for `/price` in Telegram;
 * neither draws all four. They are asked for together because this endpoint
 * takes them in one comma list, so a window nobody happens to be looking at
 * costs nothing - where a second fetcher would have meant two cooldowns that
 * know nothing of each other pointed at one shared rate limit.
 */
const MARKETS_PATH =
  '/coins/markets?vs_currency=usd&ids=ethereum&price_change_percentage=1h%2C24h%2C7d%2C30d';

/**
 * A fixed price, for trying the alert path without waiting for the market to
 * move. Set it and nothing here reaches the network at all.
 *
 * Read like any typed amount and held to the same limits as a fetched price.
 * `Number()` alone served -3450 and Infinity as ETH's price - the very values
 * `validate` exists to keep away from the alerts - and read "3,450" as no
 * setting at all, so the app went to the live network without a word. A value
 * that does not pass is now said out loud and ignored.
 */
const FIXED = (() => {
  const raw = process.env.MYAAVE_ETH_PRICE;
  if (raw == null || raw === '') return null;
  const n = parseAmount(raw);
  const problem = n === null ? 'is not a number' : validate(n) ? 'is not a usable price' : null;
  if (problem) {
    console.warn(`MYAAVE_ETH_PRICE=${raw} ${problem}; ignoring it and using the live price.`);
    return null;
  }
  return n;
})();

// Longer than the 2.5s fx.js allows itself. That one can be asked four times
// for a single save, so its timeouts multiply; this is asked once, and the
// free tier is genuinely slower than the ECB's mirror.
const TIMEOUT_MS = 5000;

/** A price this old is still worth showing without asking again. */
const FRESH_MS = 60_000;

const COOLDOWN_MS = 60_000;

// Walking straight back into a rate limit earns a longer one, so being told
// to slow down is not treated as an ordinary failure.
const RATE_LIMIT_COOLDOWN_MS = 600_000;

/** However long we are asked to wait, an hour is long enough to stop waiting. */
const MAX_COOLDOWN_MS = 3_600_000;

// `cooldownUntil` is the wall-clock time, for showing; the test runs on the
// monotonic clock. Timed by `Date.now()`, a clock stepped back six hours kept
// lookups asleep for six hours more, against a ceiling of one.
const state = { cooldownUntil: 0, sleepUntil: 0, lastError: null, lastTriedAt: null };
const monoNow = () => performance.now();

export function ethStatus() {
  return {
    provider: FIXED ? 'fixed' : OFFLINE ? 'offline' : ETH_URL,
    offline: OFFLINE,
    sleeping: monoNow() < state.sleepUntil,
    cooldownUntil: state.cooldownUntil || null,
    lastError: state.lastError,
    lastTriedAt: state.lastTriedAt,
  };
}

function networkIsOut() {
  return OFFLINE || monoNow() < state.sleepUntil;
}

function recordFailure(message, cooldownMs = COOLDOWN_MS) {
  state.lastError = message;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = Date.now() + cooldownMs;
  state.sleepUntil = monoNow() + cooldownMs;
}

function recordSuccess() {
  state.lastError = null;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = 0;
  state.sleepUntil = 0;
}

/**
 * The last price fetched, in memory. The cache row is the shared copy, but a
 * write to it can be refused, and the price already fetched was then lost to
 * every reader of the cache: the alert window showed a price from days before,
 * or none, and previewed "hit" a goal the save then filed as "fell to".
 */
let lastGood = null;

/** How old a quote is. A time ahead of the clock is not fresh, it is unknown. */
function ageOf(fetchedAt) {
  const at = Date.parse(fetchedAt ?? '');
  const now = Date.now();
  // A minute of slack for clocks that disagree a little. Beyond it the time is
  // wrong - the clock stepped back, or a database copied from a machine ahead
  // - and reading it as age 0 froze the price until the clock caught up.
  if (!Number.isFinite(at) || at > now + 60_000) return Infinity;
  return Math.max(0, now - at);
}

/* -------------------------------------------------------------------- cache */

const selectPrice = () =>
  prepare(
    'SELECT price, fetched_at, change_1h, change_24h, change_7d, change_30d FROM eth_price WHERE id = 1',
  );

const upsertPrice = () =>
  prepare(`
    INSERT INTO eth_price (id, price, fetched_at, change_1h, change_24h, change_7d, change_30d)
    VALUES (1, @price, @fetched_at, @change_1h, @change_24h, @change_7d, @change_30d)
    ON CONFLICT (id) DO UPDATE SET
      price = excluded.price, fetched_at = excluded.fetched_at,
      change_1h = excluded.change_1h, change_24h = excluded.change_24h,
      change_7d = excluded.change_7d, change_30d = excluded.change_30d
  `);

/** The four change windows, as fetched or as cached. Any of them may be null. */
const changes = (row) => ({
  change1h: pctOrNull(row?.change_1h),
  change24h: pctOrNull(row?.change_24h),
  change7d: pctOrNull(row?.change_7d),
  change30d: pctOrNull(row?.change_30d),
});

// The shape a fixed price answers with, so `MYAAVE_ETH_PRICE` returns the same
// fields as a real quote rather than a shorter object callers have to guard.
const NO_CHANGES = { change1h: null, change24h: null, change7d: null, change30d: null };

/**
 * The cached price alone. Synchronous, and never reaches for the network.
 *
 * Nor does it throw. The `db.open` check is not enough on its own: a statement
 * can be refused while the connection is perfectly open, which a second copy of
 * this app checkpointing the same file will do, and this is read from a timer
 * and from inside a request handler both. A cache that cannot be read is a
 * cache miss - the caller asks the network instead - and not a reason for
 * anything above to fail.
 */
export function cachedEthPrice() {
  if (FIXED) return { price: FIXED, fetchedAt: new Date().toISOString(), ageMs: 0, ...NO_CHANGES };
  if (!db.open) return null;

  let row = null;
  try {
    row = selectPrice().get() ?? null;
  } catch (err) {
    console.error('Could not read the cached ETH price:', err.message);
  }

  // The newer of the shared row and our own last fetch: the row when another
  // copy of the app wrote a later price, ours when our write was refused.
  const rowAt = Date.parse(row?.fetched_at ?? '');
  if (lastGood && (!row || !Number.isFinite(rowAt) || rowAt < Date.parse(lastGood.fetchedAt))) {
    return { ...lastGood, ageMs: ageOf(lastGood.fetchedAt) };
  }
  if (!row) return null;

  return {
    price: row.price,
    fetchedAt: row.fetched_at,
    ageMs: ageOf(row.fetched_at),
    ...changes(row),
  };
}

/**
 * Write the price we just fetched, and carry on if that fails.
 *
 * Best effort on purpose. The price is already in hand and already correct;
 * losing the ability to remember it for next time is not a reason to throw it
 * away, which is what happened when this sat in the same try as the fetch: a
 * refused write discarded a good price, reported the whole attempt as a
 * failure, and put lookups to sleep for a minute over a busy database.
 */
function cachePut(row) {
  if (!db.open) return;
  try {
    upsertPrice().run(row);
  } catch (err) {
    console.error('Could not cache the ETH price:', err.message);
  }
}

/* ----------------------------------------------------------------- fetching */

/**
 * A change window that is not a number is simply not known.
 *
 * Deliberately not run through `validate` below. CoinGecko does return null for
 * one of these now and then, and a price is not made wrong by a missing
 * seven-day figure. Rejecting the whole answer over it would take the alert
 * sweep off the air for the sake of a line in a chat message.
 */
const pctOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A price that is not a positive, finite, plausibly sized number is not a
 * price. The ceiling matters more than it looks: a zero or a NaN slipping
 * through would read as "ETH has fallen" and fire every alert waiting for a
 * drop, all at once, and those messages cannot be unsent.
 */
function validate(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return 'The price that came back was not a usable number.';
  }
  if (price > 1_000_000) return 'The price that came back was implausibly large.';
  return null;
}

/**
 * The current price, from the cache when it is fresh enough and from the
 * service otherwise. Returns null only when there is nothing at all to offer,
 * never throws: not knowing the price is an ordinary state here, and the
 * caller carries on without one.
 */
export async function ethPrice({ maxAgeMs = FRESH_MS } = {}) {
  if (FIXED) return { price: FIXED, fetchedAt: new Date().toISOString(), ageMs: 0, ...NO_CHANGES };

  const hit = cachedEthPrice();
  if (hit && hit.ageMs <= maxAgeMs) return hit;
  if (networkIsOut()) return hit;

  // One request at a time, however many callers want an answer.
  //
  // There are four of them now - the alert sweep, the watch timer, /price, and
  // the alert window asking for a fresh figure - and nothing stops two
  // coinciding. Each used to open its own request, against a service with no
  // key and a rate limit shared with every other caller on this address, to
  // fetch a number they would all have been equally happy to share. A caller
  // who could have lived with an older price has already returned above, so
  // anyone reaching here wants what this fetch is about to get.
  if (inFlight) return inFlight;
  inFlight = fetchPrice(hit).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight = null;

/** The request itself. Never throws; `ethPrice` promises as much on its behalf. */
async function fetchPrice(hit) {
  try {
    const res = await fetch(`${ETH_URL}${MARKETS_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 429) {
      // Honour what it asks for, rather than guessing shorter and being
      // refused again. `min` against our own cooldown was the wrong way round:
      // a service asking for an hour was heard as ten minutes, which walks
      // straight back into the limit it had just been told about. The ceiling
      // is there so a header of a week cannot switch prices off for a week.
      //
      // In seconds or as an HTTP date, which the standard allows equally. Read
      // as a number alone, a date asking for 55 minutes was heard as nothing,
      // and the flat ten minutes walked back into the limit.
      const header = res.headers.get('retry-after');
      const secs = Number(header);
      const asked = Number.isFinite(secs) ? secs * 1000 : Date.parse(header ?? '') - Date.now();
      const wait =
        Number.isFinite(asked) && asked > 0
          ? Math.min(Math.max(asked, COOLDOWN_MS), MAX_COOLDOWN_MS)
          : RATE_LIMIT_COOLDOWN_MS;
      recordFailure('The price service is rate limiting us. Waiting before asking again.', wait);
      return hit;
    }
    if (!res.ok) {
      recordFailure(`The price service answered ${res.status}.`);
      return hit;
    }

    const body = await res.json();
    // The endpoint answers with an array of coins, one here because one was asked for.
    const coin = Array.isArray(body) ? body[0] : null;
    const price = coin?.current_price;
    const problem = validate(price);
    if (problem) {
      recordFailure(problem);
      return hit;
    }

    recordSuccess();
    const fetchedAt = new Date().toISOString();
    const row = {
      price,
      fetched_at: fetchedAt,
      change_1h: pctOrNull(coin.price_change_percentage_1h_in_currency),
      change_24h: pctOrNull(coin.price_change_percentage_24h_in_currency),
      change_7d: pctOrNull(coin.price_change_percentage_7d_in_currency),
      change_30d: pctOrNull(coin.price_change_percentage_30d_in_currency),
    };
    const quote = { price, fetchedAt, ageMs: 0, ...changes(row) };
    lastGood = quote;
    cachePut(row);
    return quote;
  } catch (err) {
    recordFailure(
      err.name === 'TimeoutError' ? 'The price service did not answer in time.' : err.message,
    );
    return hit;
  }
}
