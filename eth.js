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

const ETH_URL = (process.env.MYAAVE_ETH_URL || 'https://api.coingecko.com/api/v3').replace(
  /\/+$/,
  '',
);
const OFFLINE = process.env.MYAAVE_ETH_OFFLINE === '1';

/**
 * A fixed price, for trying the alert path without waiting for the market to
 * move. Set it and nothing here reaches the network at all.
 */
const FIXED = Number(process.env.MYAAVE_ETH_PRICE) || null;

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

const state = { cooldownUntil: 0, lastError: null, lastTriedAt: null };

export function ethStatus() {
  return {
    provider: OFFLINE ? 'offline' : FIXED ? 'fixed' : ETH_URL,
    offline: OFFLINE,
    sleeping: Date.now() < state.cooldownUntil,
    cooldownUntil: state.cooldownUntil || null,
    lastError: state.lastError,
    lastTriedAt: state.lastTriedAt,
  };
}

function networkIsOut() {
  return OFFLINE || Date.now() < state.cooldownUntil;
}

function recordFailure(message, cooldownMs = COOLDOWN_MS) {
  state.lastError = message;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = Date.now() + cooldownMs;
}

function recordSuccess() {
  state.lastError = null;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = 0;
}

/* -------------------------------------------------------------------- cache */

const selectPrice = () => prepare('SELECT price, fetched_at FROM eth_price WHERE id = 1');

const upsertPrice = () =>
  prepare(`
    INSERT INTO eth_price (id, price, fetched_at) VALUES (1, @price, @fetched_at)
    ON CONFLICT (id) DO UPDATE SET price = excluded.price, fetched_at = excluded.fetched_at
  `);

/** The cached price alone. Synchronous, and never reaches for the network. */
export function cachedEthPrice() {
  if (FIXED) return { price: FIXED, fetchedAt: new Date().toISOString(), ageMs: 0 };
  // A timer can outlive the connection during shutdown, and better-sqlite3
  // throws rather than returning nothing when it does.
  if (!db.open) return null;
  const row = selectPrice().get();
  if (!row) return null;
  const at = Date.parse(row.fetched_at);
  return {
    price: row.price,
    fetchedAt: row.fetched_at,
    ageMs: Number.isFinite(at) ? Math.max(0, Date.now() - at) : Infinity,
  };
}

/* ----------------------------------------------------------------- fetching */

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
  if (FIXED) return { price: FIXED, fetchedAt: new Date().toISOString(), ageMs: 0 };

  const hit = cachedEthPrice();
  if (hit && hit.ageMs <= maxAgeMs) return hit;
  if (networkIsOut()) return hit;

  try {
    const res = await fetch(`${ETH_URL}/simple/price?ids=ethereum&vs_currencies=usd`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 429) {
      // Honour what it asks for, rather than guessing shorter and being
      // refused again. `min` against our own cooldown was the wrong way round:
      // a service asking for an hour was heard as ten minutes, which walks
      // straight back into the limit it had just been told about. The ceiling
      // is there so a header of a week cannot switch prices off for a week.
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(Math.max(retryAfter * 1000, COOLDOWN_MS), MAX_COOLDOWN_MS)
          : RATE_LIMIT_COOLDOWN_MS;
      recordFailure('The price service is rate limiting us. Waiting before asking again.', wait);
      return hit;
    }
    if (!res.ok) {
      recordFailure(`The price service answered ${res.status}.`);
      return hit;
    }

    const body = await res.json();
    const price = body?.ethereum?.usd;
    const problem = validate(price);
    if (problem) {
      recordFailure(problem);
      return hit;
    }

    recordSuccess();
    const fetchedAt = new Date().toISOString();
    if (db.open) upsertPrice().run({ price, fetched_at: fetchedAt });
    return { price, fetchedAt, ageMs: 0 };
  } catch (err) {
    recordFailure(
      err.name === 'TimeoutError' ? 'The price service did not answer in time.' : err.message,
    );
    return hit;
  }
}
