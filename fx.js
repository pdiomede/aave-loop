/**
 * Historical exchange rates.
 *
 * This is the only module in the project that touches the network, and it is
 * deliberately at the root rather than in lib/, because server.js serves lib/
 * straight to the browser. lib/calc.js must stay pure and importable on both
 * sides; this file imports the database and does I/O, so it is server only.
 *
 * A rate is USD per one unit of the borrowed coin, so `usd = native * fx`, and
 * a dollar pegged coin is exactly 1. Nothing here ever inverts a rate.
 *
 * Rates come from the European Central Bank, which publishes one euro
 * reference rate per business day. They are the rates a European accountant
 * would use, they go back to 1999, and they are free to read without a key or
 * an account, which matters for something meant to run on a laptop forever.
 */
import { db, prepare, tradesMissingFx, tradesWithSubstitutedFx } from './db.js';
import { pegOf, isUsdPegged, FX_STAGES, parseDate } from './lib/calc.js';

const FX_URL = (process.env.MYAAVE_FX_URL || 'https://api.frankfurter.app').replace(/\/+$/, '');
const OFFLINE = process.env.MYAAVE_FX_OFFLINE === '1';
const QUOTE = 'USD';

// A lookup has to lose to a stalled network quickly. Four stages on one trade
// would otherwise hold the request open for four full timeouts.
const TIMEOUT_MS = 2500;

/**
 * With no network at all, every save would sit through a fresh timeout for
 * every stage. One failure puts lookups to sleep for a minute; the ledger
 * carries on with the rate column empty and the interface says so.
 */
const COOLDOWN_MS = 60_000;

const state = { cooldownUntil: 0, lastError: null, lastTriedAt: null };

export function fxStatus() {
  return {
    provider: OFFLINE ? 'offline' : FX_URL,
    offline: OFFLINE,
    sleeping: Date.now() < state.cooldownUntil,
    cooldownUntil: state.cooldownUntil || null,
    lastError: state.lastError,
    lastTriedAt: state.lastTriedAt,
  };
}

/** True when a lookup would certainly fail, so we do not bother trying. */
function networkIsOut() {
  return OFFLINE || Date.now() < state.cooldownUntil;
}

function recordFailure(message) {
  state.lastError = message;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = Date.now() + COOLDOWN_MS;
}

function recordSuccess() {
  state.lastError = null;
  state.lastTriedAt = new Date().toISOString();
  state.cooldownUntil = 0;
}

/* -------------------------------------------------------------------- cache */

const selectRate = () =>
  prepare('SELECT rate, rate_date, source FROM fx_rates WHERE base = ? AND quote = ? AND date = ?');

// Two servers can point at the same file, so a second one writing the same day
// is expected rather than exceptional.
const upsertRate = () =>
  prepare(`
    INSERT INTO fx_rates (base, quote, date, rate, rate_date, source, fetched_at)
    VALUES (@base, @quote, @date, @rate, @rate_date, @source, @fetched_at)
    ON CONFLICT (base, quote, date) DO UPDATE SET
      rate = excluded.rate, rate_date = excluded.rate_date,
      source = excluded.source, fetched_at = excluded.fetched_at
  `);

function cacheGet(base, date) {
  const row = selectRate().get(base, QUOTE, date);
  return row ? { rate: row.rate, rateDate: row.rate_date, source: row.source } : null;
}

function cachePut(base, date, { rate, rateDate, source }) {
  upsertRate().run({
    base, quote: QUOTE, date, rate,
    rate_date: rateDate, source,
    fetched_at: new Date().toISOString(),
  });
}

/**
 * A rate for a coin that is simply worth a dollar. Written as a resolution
 * rather than a special case at every call site, so switching a trade back to
 * USDC succeeds with the network unplugged.
 */
const pegRate = (isoDate) => ({ rate: 1, rateDate: isoDate, source: 'peg' });

/* ------------------------------------------------------------------ fetching */

/**
 * A published rate has to be near 1 for the currencies this tracks, and a date
 * later than the one asked for would mean the answer describes a different day.
 * Both are cheap to check and both would otherwise corrupt a stored figure
 * quietly.
 */
function validate(rate, rateDate, wanted) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return 'The rate that came back was not a usable number.';
  }
  if (typeof rateDate !== 'string' || parseDate(rateDate) === null) {
    return 'The rate came back without a date.';
  }
  if (parseDate(rateDate) > parseDate(wanted)) {
    return `The rate came back dated ${rateDate}, after the ${wanted} it was asked about.`;
  }
  return null;
}

async function getJson(path) {
  const res = await fetch(`${FX_URL}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The rate service answered ${res.status}.`);
  return res.json();
}

/**
 * One day. Returns null when the rate is genuinely unknown, which is a result
 * the rest of the app is built to carry: the trade saves, the column stays
 * empty, and the interface says a rate is still needed.
 */
export async function resolveRate(currency, isoDate) {
  if (!isoDate) return null;
  if (isUsdPegged(currency)) return pegRate(isoDate);

  const base = pegOf(currency);
  const hit = cacheGet(base, isoDate);
  if (hit) return hit;

  if (networkIsOut()) return null;

  try {
    const body = await getJson(`/${isoDate}?from=${base}&to=${QUOTE}`);
    const rate = body?.rates?.[QUOTE];
    const rateDate = body?.date;
    const problem = validate(rate, rateDate, isoDate);
    if (problem) {
      recordFailure(problem);
      return null;
    }
    recordSuccess();
    const resolved = { rate, rateDate, source: 'ecb' };
    cachePut(base, isoDate, resolved);
    return resolved;
  } catch (err) {
    recordFailure(err.name === 'TimeoutError' ? 'The rate service did not answer in time.' : err.message);
    return null;
  }
}

/** The cache alone. Synchronous, and never reaches for the network. */
export function cachedRate(currency, isoDate) {
  if (!isoDate) return null;
  if (isUsdPegged(currency)) return pegRate(isoDate);
  return cacheGet(pegOf(currency), isoDate);
}

/**
 * Every day in a span, in one request. Filling twenty missing dates one at a
 * time is twenty round trips for data the service will hand over at once.
 *
 * The service only returns business days, so each requested day is answered
 * with the last rate published on or before it. That is exactly the ECB's own
 * convention for a weekend, and it is why the day the rate was published is
 * stored next to the day it was applied to.
 */
export async function resolveRange(currency, fromISO, toISO) {
  const out = new Map();
  if (isUsdPegged(currency)) return out;
  if (networkIsOut()) return out;

  const base = pegOf(currency);
  let published;
  try {
    const body = await getJson(`/${fromISO}..${toISO}?from=${base}&to=${QUOTE}`);
    published = body?.rates;
    if (!published || typeof published !== 'object') throw new Error('The rate service returned no rates.');
    recordSuccess();
  } catch (err) {
    recordFailure(err.name === 'TimeoutError' ? 'The rate service did not answer in time.' : err.message);
    return out;
  }

  // The single day path runs every answer through `validate`; this one did not,
  // so whatever the service sent was stored as fact. A rate of -999999 was
  // accepted, and the day key is written into the trade and rendered in the
  // interface, so it has to be a real date and nothing else.
  const days = Object.keys(published).filter((d) => parseDate(d) !== null).sort();
  if (days.length === 0) return out;

  // Walk the span day by day, carrying the last published rate forward.
  let cursor = 0;
  let carried = null;
  for (let ts = parseDate(fromISO); ts <= parseDate(toISO); ts += 86400000) {
    const iso = new Date(ts).toISOString().slice(0, 10);
    while (cursor < days.length && days[cursor] <= iso) {
      const rate = published[days[cursor]]?.[QUOTE];
      if (validate(rate, days[cursor], days[cursor]) === null) {
        carried = { rate, rateDate: days[cursor], source: 'ecb' };
      }
      cursor += 1;
    }
    if (carried) out.set(iso, carried);
  }

  // One transaction for the whole span. A wide span is thousands of days, and
  // writing each one on its own made that thousands of separate commits.
  db.transaction(() => {
    for (const [iso, record] of out) cachePut(base, iso, record);
  })();
  return out;
}

/* ------------------------------------------------------- filling in a trade */

/** The rate columns a row still needs, given the stages it has reached. */
function stagesNeedingRate(row) {
  if (isUsdPegged(row.borrow_currency)) return [];
  return FX_STAGES.filter((s) => row[`${s}_date`] != null && row[`${s}_fx`] == null);
}

/**
 * Fill in whatever rates a row is missing.
 *
 * A lookup that fails must never fail the save. The ledger is meant to work
 * with the network unplugged, so the row is written with the rate column empty,
 * the interface marks it, and the rate is fetched later or the whole thing is
 * refreshed in one go.
 */
export async function fillFxColumns(row) {
  const patch = {};

  // A rate with no date under it belongs to a stage that has been undone, and
  // would otherwise sit there attached to nothing.
  for (const s of FX_STAGES) {
    if (row[`${s}_date`] == null && row[`${s}_fx`] != null) {
      patch[`${s}_fx`] = null;
      patch[`${s}_fx_date`] = null;
    }
  }

  const needed = stagesNeedingRate(row);
  if (needed.length === 0) {
    if (isUsdPegged(row.borrow_currency) && row.fx_source != null) patch.fx_source = null;
    return patch;
  }

  let source = null;
  for (const stage of needed) {
    const resolved = await resolveRate(row.borrow_currency, row[`${stage}_date`]);
    if (!resolved) continue;
    patch[`${stage}_fx`] = resolved.rate;
    patch[`${stage}_fx_date`] = resolved.rateDate;
    source = resolved.source;
  }
  if (source) patch.fx_source = source;
  return patch;
}

/**
 * Decide which stored rates an edit invalidates.
 *
 * A rate belongs to a date. Move the purchase from the 12th to the 14th, or
 * switch the loan from dollars to euros, and the rate sitting on the row is no
 * longer the rate for that transaction. Leaving it would quietly make the
 * dollar figures wrong, which is worse than showing nothing at all, so it is
 * cleared and looked up again.
 */
export function staleFxColumns(current, patch) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

  const currencyChanged = has('borrow_currency') && patch.borrow_currency !== current.borrow_currency;

  for (const s of FX_STAGES) {
    const dateChanged = has(`${s}_date`) && patch[`${s}_date`] !== current[`${s}_date`];
    if (currencyChanged || dateChanged) {
      out[`${s}_fx`] = null;
      out[`${s}_fx_date`] = null;
    }
  }
  if (currencyChanged) out.fx_source = null;
  return out;
}

/* ---------------------------------------------------------------- backfill */

const writeFx = (columns) =>
  prepare(`UPDATE trades SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`);

/**
 * Fill in every rate the ledger is still missing, in as few requests as the
 * service allows. This is the other half of "save now, look it up later": a
 * trade entered on a train gets its dollar figures the next time the app can
 * reach the network.
 *
 * With `refresh`, also ask again about any stage whose rate came from a
 * different day than the transaction. Those are the trades entered before the
 * ECB had published, where a stand-in was used and the real rate exists now.
 */
export async function backfillRates({ refresh = false } = {}) {
  const rows = refresh
    ? [...tradesMissingFx(), ...tradesWithSubstitutedFx()]
    : tradesMissingFx();

  // The same row can appear in both lists.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const scanned = byId.size;

  // Work out every day that has to be looked up, so the whole span can be
  // fetched at once rather than a request per stage.
  const wanted = new Map(); // currency -> Set of ISO dates
  const targets = [];
  for (const row of byId.values()) {
    const stages = refresh
      ? FX_STAGES.filter((s) => row[`${s}_date`] != null &&
          (row[`${s}_fx`] == null || row[`${s}_fx_date`] !== row[`${s}_date`]))
      : stagesNeedingRate(row);
    if (stages.length === 0) continue;
    targets.push({ row, stages });
    if (!wanted.has(row.borrow_currency)) wanted.set(row.borrow_currency, new Set());
    for (const s of stages) wanted.get(row.borrow_currency).add(row[`${s}_date`]);
  }

  const resolved = new Map(); // `${currency}|${date}` -> rate record
  for (const [currency, dates] of wanted) {
    const sorted = [...dates].sort();
    if (sorted.length === 0) continue;
    // One request for the whole span. On a refresh the cache would answer with
    // the stand-in we are trying to replace, so go past it.
    const span = await resolveRange(currency, sorted[0], sorted[sorted.length - 1]);
    for (const date of sorted) {
      const hit = span.get(date) ?? (refresh ? null : await resolveRate(currency, date));
      if (hit) resolved.set(`${currency}|${date}`, hit);
    }
  }

  let filled = 0;
  let stillMissing = 0;
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    for (const { row, stages } of targets) {
      // Re-read inside the transaction. The rates above were fetched over the
      // network, and an edit landing in the meantime can have moved a stage to
      // another day or changed the currency, which would pin the rate we just
      // looked up to a transaction it does not belong to.
      const live = prepare('SELECT * FROM trades WHERE id = ?').get(row.id);
      if (!live || live.borrow_currency !== row.borrow_currency) continue;
      const patch = {};
      let source = null;
      for (const s of stages) {
        if (live[`${s}_date`] !== row[`${s}_date`]) continue;
        const hit = resolved.get(`${row.borrow_currency}|${row[`${s}_date`]}`);
        if (!hit) {
          stillMissing += 1;
          continue;
        }
        patch[`${s}_fx`] = hit.rate;
        patch[`${s}_fx_date`] = hit.rateDate;
        source = hit.source;
        filled += 1;
      }
      const columns = Object.keys(patch);
      if (columns.length === 0) continue;
      if (source) {
        patch.fx_source = source;
        columns.push('fx_source');
      }
      writeFx(columns).run({ ...patch, updated_at: now, id: row.id });
    }
  });
  apply();

  return { scanned, filled, stillMissing, ...fxStatus() };
}
