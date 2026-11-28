/**
 * What ETH, BTC, WBTC, SOL and PSOL are worth right now.
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
 * deals in a number that is stale the moment it arrives. So the cache is a row
 * per market with the time on it, and every reader decides how old is too old.
 *
 * Five markets, `MARKETS` in lib/calc.js: ETH; BTC, which is what a cbBTC
 * trade is valued at (see `ASSET_META`); WBTC, at its own price, fetched to
 * value a WBTC trade and never shown on its own; SOL; and PSOL, Phantom's
 * staked SOL, at its own price as WBTC is. This was `eth.js` while ETH was the
 * only one. All come back from one request, so each market added cost no
 * second cooldown and no second share of the rate limit.
 */
import { db, prepare } from './db.js';
import { parseAmount, MARKETS, intervalMs } from './lib/calc.js';
import { setting, settingName } from './env.js';

// The variables keep the names they had when this priced ETH alone, so an
// existing config.env or service file goes on working; they now cover BTC too.
const PRICE_URL = (setting('ETH_URL') || 'https://api.coingecko.com/api/v3').replace(
  /\/+$/,
  '',
);
const OFFLINE = setting('ETH_OFFLINE') === '1';

/** CoinGecko's id for each market. */
// PSOL's id was read from CoinGecko's own search, and its Solana mint there
// (pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL) is the one etherscan.js matches.
const COIN_ID = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  WBTC: 'wrapped-bitcoin',
  SOL: 'solana',
  PSOL: 'phantom-staked-sol',
};

/**
 * Every coin, one call, and every window anything here reports.
 *
 * 1h is for the ticker in the page header and 30d is for `/price` in Telegram;
 * neither draws all four. They are asked for together because this endpoint
 * takes them in one comma list, so a window nobody happens to be looking at
 * costs nothing - where a second fetcher would have meant two cooldowns that
 * know nothing of each other pointed at one shared rate limit. The same goes
 * for the coins.
 */
const MARKETS_PATH =
  `/coins/markets?vs_currency=usd&ids=${MARKETS.map((m) => COIN_ID[m]).join('%2C')}` +
  '&price_change_percentage=1h%2C24h%2C7d%2C30d';

/**
 * A fixed price, for trying the alert path without waiting for the market to
 * move. `ETHROUNDTRIP_ETH_PRICE` fixes ETH, `ETHROUNDTRIP_BTC_PRICE` BTC and
 * `ETHROUNDTRIP_WBTC_PRICE` WBTC, `ETHROUNDTRIP_SOL_PRICE` SOL and
 * `ETHROUNDTRIP_PSOL_PRICE` PSOL; a fixed market is never asked for, whatever
 * the others do.
 *
 * Read like any typed amount and held to the same limits as a fetched price.
 * `Number()` alone served -3450 and Infinity as ETH's price - the very values
 * `validate` exists to keep away from the alerts - and read "3,450" as no
 * setting at all, so the app went to the live network without a word. A value
 * that does not pass is now said out loud and ignored.
 */
function fixedFrom(key) {
  const raw = setting(key);
  const name = settingName(key);
  if (raw == null || raw === '') return null;
  const n = parseAmount(raw);
  const problem = n === null ? 'is not a number' : validate(n) ? 'is not a usable price' : null;
  if (problem) {
    console.warn(`${name}=${raw} ${problem}; ignoring it and using the live price.`);
    return null;
  }
  return n;
}

const FIXED = Object.fromEntries(MARKETS.map((m) => [m, fixedFrom(`${m}_PRICE`)]));

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

// One state for both markets, because they are one request: a cooldown is a
// cooldown on the endpoint, not on a coin.
//
// `cooldownUntil` is the wall-clock time, for showing; the test runs on the
// monotonic clock. Timed by `Date.now()`, a clock stepped back six hours kept
// lookups asleep for six hours more, against a ceiling of one.
const state = { cooldownUntil: 0, sleepUntil: 0, lastError: null, lastTriedAt: null, problems: {} };

/**
 * When a market was last asked for and left out of, or wrong in, an otherwise
 * good answer (monotonic). A partial answer puts nothing to sleep, so ETH is
 * not held back - but with nothing remembered, every caller wanting BTC went
 * straight back to the service while it was missing: five page polls in a
 * second, five requests against a rate limit shared with the whole address.
 * Asked for within the age a caller accepts counts as asked, the way a quote
 * fetched within it does, so each caller asks at its own pace and no faster;
 * the cached price is served meanwhile.
 */
const missingAt = {};
const monoNow = () => performance.now();

export function priceStatus() {
  return {
    provider: OFFLINE ? 'offline' : PRICE_URL,
    fixed: MARKETS.filter((m) => FIXED[m] !== null),
    offline: OFFLINE,
    sleeping: monoNow() < state.sleepUntil,
    cooldownUntil: state.cooldownUntil || null,
    lastError: state.lastError,
    // Each market's own problem from the last answer, `{ WBTC: '...' }`, so a
    // message about one market quotes only its own: `lastError` joins them,
    // and /price said "The WBTC price did not come back" under a missing BTC.
    // Empty after a failure of the whole request, which `lastError` says.
    problems: { ...state.problems },
    lastTriedAt: state.lastTriedAt,
  };
}

function networkIsOut() {
  return OFFLINE || monoNow() < state.sleepUntil;
}

function recordFailure(message, cooldownMs = COOLDOWN_MS, problems = {}) {
  state.lastError = message;
  state.problems = problems;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = Date.now() + cooldownMs;
  state.sleepUntil = monoNow() + cooldownMs;
}

function recordSuccess() {
  state.lastError = null;
  state.problems = {};
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = 0;
  state.sleepUntil = 0;
}

/**
 * The last price fetched for each market, in memory. The cache rows are the
 * shared copy, but a write to them can be refused, and the price already
 * fetched was then lost to every reader of the cache: the alert window showed a
 * price from days before, or none, and previewed "hit" a goal the save then
 * filed as "fell to".
 */
const lastGood = {};

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
    'SELECT price, fetched_at, change_1h, change_24h, change_7d, change_30d FROM market_price WHERE market = ?',
  );

const upsertPrice = () =>
  prepare(`
    INSERT INTO market_price (market, price, fetched_at, change_1h, change_24h, change_7d, change_30d)
    VALUES (@market, @price, @fetched_at, @change_1h, @change_24h, @change_7d, @change_30d)
    ON CONFLICT (market) DO UPDATE SET
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

// The shape a fixed price answers with, so a fixed market returns the same
// fields as a real quote rather than a shorter object callers have to guard.
const NO_CHANGES = { change1h: null, change24h: null, change7d: null, change30d: null };

const fixedQuote = (market) => ({
  price: FIXED[market],
  fetchedAt: new Date().toISOString(),
  ageMs: 0,
  ...NO_CHANGES,
});

/**
 * One market's cached price alone. Synchronous, and never reaches for the
 * network.
 *
 * Nor does it throw. The `db.open` check is not enough on its own: a statement
 * can be refused while the connection is perfectly open, which a second copy of
 * this app checkpointing the same file will do, and this is read from a timer
 * and from inside a request handler both. A cache that cannot be read is a
 * cache miss - the caller asks the network instead - and not a reason for
 * anything above to fail.
 */
export function cachedMarketPrice(market) {
  if (!MARKETS.includes(market)) return null;
  if (FIXED[market] !== null) return fixedQuote(market);
  if (!db.open) return null;

  let row = null;
  try {
    row = selectPrice().get(market) ?? null;
  } catch (err) {
    console.error(`Could not read the cached ${market} price:`, err.message);
  }

  // The newer of the shared row and our own last fetch: the row when another
  // copy of the app wrote a later price, ours when our write was refused.
  const mine = lastGood[market];
  const rowAt = Date.parse(row?.fetched_at ?? '');
  if (mine && (!row || !Number.isFinite(rowAt) || rowAt < Date.parse(mine.fetchedAt))) {
    return { ...mine, ageMs: ageOf(mine.fetchedAt) };
  }
  if (!row) return null;

  return {
    price: row.price,
    fetchedAt: row.fetched_at,
    ageMs: ageOf(row.fetched_at),
    ...changes(row),
  };
}

/** Every market's cached price, keyed by `MARKETS`, each a quote or null. */
export function cachedMarketPrices() {
  return Object.fromEntries(MARKETS.map((m) => [m, cachedMarketPrice(m)]));
}

/**
 * Write a price we just fetched, and carry on if that fails.
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
    console.error(`Could not cache the ${row.market} price:`, err.message);
  }
}

/* ----------------------------------------------------------------- fetching */

/**
 * How long a 429 asks us to wait. Honour what it asks for, rather than
 * guessing shorter and being refused again. `min` against our own cooldown was
 * the wrong way round: a service asking for an hour was heard as ten minutes,
 * which walks straight back into the limit it had just been told about. The
 * ceiling is there so a header of a week cannot switch prices off for a week.
 *
 * In seconds or as an HTTP date, which the standard allows equally. Read as a
 * number alone, a date asking for 55 minutes was heard as nothing, and the
 * flat ten minutes walked back into the limit.
 */
function rateLimitWait(res) {
  const header = res.headers.get('retry-after');
  const secs = Number(header);
  const asked = Number.isFinite(secs) ? secs * 1000 : Date.parse(header ?? '') - Date.now();
  return Number.isFinite(asked) && asked > 0
    ? Math.min(Math.max(asked, COOLDOWN_MS), MAX_COOLDOWN_MS)
    : RATE_LIMIT_COOLDOWN_MS;
}

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
 * drop, all at once, and those messages cannot be unsent. A million is ten
 * times BTC and hundreds of times ETH.
 */
function validate(price, market = '') {
  const what = market ? `The ${market} price` : 'The price';
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return `${what} that came back was not a usable number.`;
  }
  if (price > 1_000_000) return `${what} that came back was implausibly large.`;
  return null;
}

/**
 * The current prices, `{ ETH, BTC }`, from the cache when fresh enough and from
 * the service otherwise. A market with nothing at all to offer is null; this
 * never throws: not knowing a price is an ordinary state here, and the caller
 * carries on without one.
 *
 * `markets` are the ones the caller needs fresh. One wanting only ETH's does
 * not send a request because BTC's has aged; when a request does go, it brings
 * both back anyway.
 */
export async function marketPrices({ maxAgeMs = FRESH_MS, markets = MARKETS } = {}) {
  const hits = cachedMarketPrices();
  const due = markets.filter(
    (m) =>
      FIXED[m] === null &&
      !(hits[m] && hits[m].ageMs <= maxAgeMs) &&
      !(missingAt[m] !== undefined && monoNow() - missingAt[m] <= maxAgeMs),
  );
  if (due.length === 0 || networkIsOut()) return hits;

  // One request at a time, however many callers want an answer.
  //
  // There are four of them - the alert sweep, the watch timer, /price, and the
  // alert window asking for a fresh figure - and nothing stops two coinciding.
  // Each used to open its own request, against a service with no key and a
  // rate limit shared with every other caller on this address, to fetch a
  // number they would all have been equally happy to share. A caller who could
  // have lived with older prices has already returned above, so anyone reaching
  // here wants what this fetch is about to get.
  if (!inFlight) {
    inFlight = fetchPrices().finally(() => {
      inFlight = null;
    });
  }
  const fetched = await inFlight;
  // A market the fetch could not bring back keeps whatever the cache had.
  return Object.fromEntries(MARKETS.map((m) => [m, fetched[m] ?? hits[m]]));
}

/** One market's current price, as `marketPrices` gets it. */
export async function marketPrice(market, { maxAgeMs = FRESH_MS } = {}) {
  if (!MARKETS.includes(market)) return null;
  return (await marketPrices({ maxAgeMs, markets: [market] }))[market];
}

let inFlight = null;

/**
 * The request itself: a fresh quote per market that came back usable. Never
 * throws; `marketPrices` promises as much on its behalf.
 *
 * Each coin is read by its id and checked on its own. A BTC price that comes
 * back unusable does not throw away a good ETH one fetched with it: ETH is
 * cached, and the problem is said in `priceStatus` (see the end).
 */
async function fetchPrices() {
  try {
    const res = await fetch(`${PRICE_URL}${MARKETS_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 429) {
      recordFailure('The price service is rate limiting us. Waiting before asking again.', rateLimitWait(res));
      return {};
    }
    if (!res.ok) {
      recordFailure(`The price service answered ${res.status}.`);
      return {};
    }

    const body = await res.json();
    // The endpoint answers with an array of coins, in no promised order.
    const coins = Array.isArray(body) ? body : [];
    const fetchedAt = new Date().toISOString();
    const out = {};
    const problems = [];
    const byMarket = {};
    for (const market of MARKETS) {
      if (FIXED[market] !== null) continue;
      const coin = coins.find((c) => c?.id === COIN_ID[market]);
      const price = coin?.current_price;
      const problem = coin ? validate(price, market) : `The ${market} price did not come back.`;
      if (problem) {
        problems.push(problem);
        byMarket[market] = problem;
        missingAt[market] = monoNow();
        continue;
      }
      delete missingAt[market];
      const row = {
        market,
        price,
        fetched_at: fetchedAt,
        change_1h: pctOrNull(coin.price_change_percentage_1h_in_currency),
        change_24h: pctOrNull(coin.price_change_percentage_24h_in_currency),
        change_7d: pctOrNull(coin.price_change_percentage_7d_in_currency),
        change_30d: pctOrNull(coin.price_change_percentage_30d_in_currency),
      };
      const quote = { price, fetchedAt, ageMs: 0, ...changes(row) };
      lastGood[market] = quote;
      cachePut(row);
      out[market] = quote;
    }

    // Nothing usable at all is a failure like any other, cooldown and all. A
    // partial answer is not: the service did answer, and putting the module
    // to sleep over a missing BTC price held ETH's back with it - the alert
    // sweep and the ticker kept a minute-old ETH figure for want of a coin
    // they were not asking about. The problem is still said in the status.
    if (Object.keys(out).length === 0 && problems.length > 0) recordFailure(problems.join(' '), COOLDOWN_MS, byMarket);
    else {
      recordSuccess();
      if (problems.length > 0) {
        state.lastError = problems.join(' ');
        state.problems = byMarket;
      }
    }
    return out;
  } catch (err) {
    recordFailure(
      err.name === 'TimeoutError' ? 'The price service did not answer in time.' : err.message,
    );
    return {};
  }
}

/* ------------------------------------------------------------ closing prices */

// A failed day is not asked for again for this long: the Trades tab asks when
// a past year is first shown, and a service that has no answer will not have
// one a second later. A definite no - a coin it does not know, a date before
// the history it will serve - is not asked again for a day.
const CLOSE_RETRY_MS = 600_000;
const CLOSE_REFUSED_MS = 86_400_000;
const closeFailedAt = {};
const closeInFlight = {};

// Between one history call and the next. Keyless CoinGecko allows a handful of
// calls a minute, and the five for a year went out within 14 ms of each other.
const CLOSE_SPACING_MS = intervalMs(setting('CLOSE_SPACING_MS'), 1500);

// The history's own rate-limit sleep, apart from the live prices': a 429 here
// parked the whole module for ten minutes, the header's ticker and the alert
// sweep with it, for want of a year-end figure nobody needed that minute.
let closeSleepUntil = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const selectClose = () => prepare('SELECT price FROM market_close WHERE market = ? AND day = ?');
const insertClose = () =>
  prepare('INSERT OR IGNORE INTO market_close (market, day, price, fetched_at) VALUES (?, ?, ?, ?)');

/** The day after `iso` as CoinGecko's history wants it, dd-mm-yyyy: its 00:00 UTC price is `iso`'s close. */
function historyDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * Every market's price at the close of a past `day` (YYYY-MM-DD), keyed by
 * `MARKETS`, null where it is not known, with what went wrong per market in
 * `problems`. From `market_close` once fetched, otherwise one CoinGecko
 * history call per market, one after another, through the same base URL, the
 * same offline switch and the same rate-limit sleep as the live prices - one
 * limit is shared by both. A fixed market (`ETHROUNDTRIP_<MARKET>_PRICE`)
 * answers its fixed price, as it does live. Never throws.
 */
export async function closingPrices(day) {
  if (!closeInFlight[day]) {
    closeInFlight[day] = fetchClosing(day).finally(() => {
      delete closeInFlight[day];
    });
  }
  return closeInFlight[day];
}

async function fetchClosing(day) {
  const prices = {};
  const problems = {};
  let asked = 0;
  for (const market of MARKETS) {
    if (FIXED[market] !== null) {
      prices[market] = FIXED[market];
      continue;
    }
    let cached = null;
    try {
      if (db.open) cached = selectClose().get(market, day)?.price ?? null;
    } catch (err) {
      console.error(`Could not read the ${market} close of ${day}:`, err.message);
    }
    if (cached !== null) {
      prices[market] = cached;
      continue;
    }
    prices[market] = null;
    const key = `${market} ${day}`;
    if (OFFLINE) {
      problems[market] = 'Price lookups are switched off.';
      continue;
    }
    const failed = closeFailedAt[key];
    const limited = monoNow() < closeSleepUntil;
    if (networkIsOut() || limited || (failed && monoNow() < failed.until)) {
      problems[market] = limited
        ? 'The price service is rate limiting us. Waiting before asking again.'
        : failed?.reason || state.lastError || `The ${market} price for ${day} could not be fetched; it is asked for again later.`;
      continue;
    }
    if (asked > 0) await pause(CLOSE_SPACING_MS);
    asked += 1;
    try {
      const res = await fetch(
        `${PRICE_URL}/coins/${COIN_ID[market]}/history?date=${historyDate(day)}&localization=false`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (res.status === 429) {
        closeSleepUntil = monoNow() + rateLimitWait(res);
        problems[market] = 'The price service is rate limiting us. Waiting before asking again.';
        continue;
      }
      if (!res.ok) {
        const reason = `The price service answered ${res.status}.`;
        // A 4xx is the service's answer about this coin or day, not a hiccup.
        if (res.status >= 400 && res.status < 500) {
          closeFailedAt[key] = { until: monoNow() + CLOSE_REFUSED_MS, reason };
          problems[market] = reason;
          continue;
        }
        throw new Error(reason);
      }
      const body = await res.json();
      const price = body?.market_data?.current_price?.usd;
      const problem = validate(price, market);
      if (problem) throw new Error(problem);
      prices[market] = price;
      delete closeFailedAt[key];
      closeSleepUntil = 0;
      try {
        if (db.open) insertClose().run(market, day, price, new Date().toISOString());
      } catch (err) {
        console.error(`Could not cache the ${market} close of ${day}:`, err.message);
      }
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'The price service did not answer in time.' : err.message;
      closeFailedAt[key] = { until: monoNow() + CLOSE_RETRY_MS, reason };
      problems[market] = reason;
    }
  }
  return { prices, problems };
}
