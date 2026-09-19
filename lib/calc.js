/**
 * myAave trade math.
 *
 * This module is imported by the Node server AND served directly to the
 * browser, so both sides run identical formulas. Keep it dependency free
 * and side effect free. Nothing here may import anything, ever: the moment it
 * reaches for the database or the network it stops working in the browser.
 */

/**
 * A rate is USD per one unit of the borrowed coin, so `usd = native * fx`, and
 * a dollar pegged coin is exactly 1. Nothing anywhere inverts a rate.
 *
 * EURC is a euro stablecoin, so it is converted with the euro's rate. There is
 * no free keyless feed for EURC itself, and the coin tracks the euro closely
 * enough that the ECB reference rate is the honest approximation. It is an
 * approximation all the same, which is why the rate that was used and the day
 * it was published are both recorded on the trade rather than assumed.
 *
 * Pegging on the currency rather than on the ticker also means a second euro
 * coin would reuse the same rates without another line of lookup code.
 */
export const CURRENCY_META = {
  USDC: { peg: 'USD', label: 'USD Coin' },
  USDT: { peg: 'USD', label: 'Tether' },
  DAI: { peg: 'USD', label: 'Dai' },
  GHO: { peg: 'USD', label: 'GHO' },
  EURC: { peg: 'EUR', label: 'Euro Coin' },
};

// An explicit array rather than Object.keys, so the order of the dropdown is a
// decision rather than a consequence of how the object above was typed.
export const CURRENCIES = ['USDC', 'USDT', 'DAI', 'GHO', 'EURC'];

export const PEGGED_CURRENCIES = CURRENCIES.filter((c) => CURRENCY_META[c].peg === 'USD');

export const FX_STAGES = ['borrow', 'buy', 'sell', 'repay'];

/** The currency a coin is worth one of. Anything unknown is assumed a dollar. */
export function pegOf(currency) {
  return CURRENCY_META[currency]?.peg ?? 'USD';
}

export function isUsdPegged(currency) {
  return pegOf(currency) === 'USD';
}

export const STATUS = {
  OPEN: 'OPEN',
  HOLDING: 'HOLDING',
  SOLD: 'SOLD',
  CLOSED: 'CLOSED',
};

const DAY_MS = 86400000;

/** Parse an ISO 'YYYY-MM-DD' string into a UTC timestamp, or null. */
export function parseDate(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = Date.UTC(+y, +mo - 1, +d);
  const back = new Date(ts);
  // Reject impossible dates such as 2026-02-31.
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) {
    return null;
  }
  return ts;
}

/**
 * Today as an ISO 'YYYY-MM-DD' string on the local calendar.
 *
 * This used to slice a UTC timestamp, which anywhere east of UTC is yesterday
 * for part of the day: in Tokyo the forms prefilled yesterday from 09:00 local
 * onwards and then refused the user's own today as "in the future". The server
 * and the browser are always the same machine here, so the local calendar is
 * the one both sides should agree on. Spans are unaffected, because
 * `parseDate` still builds UTC midnights.
 */
export function todayISO() {
  const now = new Date();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mo}-${d}`;
}

/** Whole days between two ISO dates, or null when either is unusable. */
export function daysBetween(fromISO, toISO) {
  const a = parseDate(fromISO);
  const b = parseDate(toISO);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * A comma grouping three digits is a thousands separator. A comma followed by
 * one or two digits is a European decimal point, and stripping it blind read
 * "32.000,00" as 32 and "32000,50" as 3200050. Convert that case instead.
 */
const DECIMAL_COMMA = /,\d{1,2}(?!\d)/;

export function normaliseAmountText(text) {
  const s = String(text ?? '');
  return DECIMAL_COMMA.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
}

/**
 * Read a typed or pasted amount, the same way on both sides of the wire.
 *
 * Accepts what people actually paste: thousands separators in either
 * convention, a currency symbol, a trailing percent, surrounding spaces, and
 * the trailing dot of a half typed "1500." on its way to "1500.75". Rejects
 * anything else rather than deleting characters until it parses, which used to
 * turn "1e5" into 15 in the browser while the server read 100000.
 * Returns null when the text is not a single finite number.
 */
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const cleaned = normaliseAmountText(text.replace(/[\s\u00a0\u202f$%]/g, ''));
  if (cleaned === '') return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Amounts and quantities must be positive to count as filled in. A rate of
// exactly 0 is meaningful, so it goes through `num` rather than this.
const qty = (v) => (num(v) !== null && v > 0 ? v : null);
const div = (a, b) => (num(a) !== null && num(b) !== null && b !== 0 ? a / b : null);
// Convert a native amount to dollars. Either side missing means the answer is
// unknown, which is not the same as zero and must never be rendered as one.
const toUsd = (v, rate) => (num(v) !== null && num(rate) !== null ? v * rate : null);

/**
 * Simple interest accrued on a loan.
 * amount * apr% * days / 365
 */
export function accruedInterest(amount, aprPercent, days) {
  if (num(amount) === null || num(aprPercent) === null || num(days) === null) return null;
  if (days < 0) return null;
  return amount * (aprPercent / 100) * (days / 365);
}

/**
 * Annualized simple return on the borrowed capital.
 * This is the '%' column of the source spreadsheet: a 3 day trade that nets
 * 7.2% reads as 877%, because the figure is scaled to a full year.
 */
export function annualizedPct(netGain, loan, days) {
  if (num(netGain) === null || num(loan) === null || num(days) === null || loan === 0) return null;
  // A backwards span means the dates are inconsistent. Math.max would have
  // turned that into a confident looking rate, so report nothing instead.
  if (days < 0) return null;
  // A same day open and close still represents a day of capital at work.
  const span = Math.max(days, 1);
  return (netGain / loan) * (365 / span) * 100;
}

/** Stage completion flags for a raw trade row. */
export function stages(t) {
  const bought = t.buy_date != null && qty(t.buy_amount) !== null && qty(t.buy_eth) !== null;
  const sold = t.sell_date != null && qty(t.sell_amount) !== null && qty(t.sell_eth) !== null;
  const repaid = t.repay_date != null && qty(t.repay_amount) !== null;
  return { borrowed: true, bought, sold, repaid };
}

/**
 * Derive every computed value for one trade row.
 * Fields stay null until their inputs exist, so a borrow only trade is valid.
 *
 * Every figure comes in two currencies. The native one is what was actually
 * borrowed, spent and repaid, and is what the four stage cards show. The `Usd`
 * one is what it was worth in dollars on the day it happened, and is the only
 * figure the totals are allowed to add up, because adding euros to dollars
 * gives a number that means nothing.
 */
export function derive(t, asOf = todayISO()) {
  const st = stages(t);

  const status = st.repaid
    ? STATUS.CLOSED
    : st.sold
      ? STATUS.SOLD
      : st.bought
        ? STATUS.HOLDING
        : STATUS.OPEN;

  // A dollar coin is one to one whether or not a rate was ever written to the
  // row. That keeps every ledger made before exchange rates existed computing
  // exactly as it did, and it lets the browser derive a half typed form that
  // has no rates on it yet.
  const pegged = isUsdPegged(t.borrow_currency);
  const rateOf = (stage) => (pegged ? 1 : num(t[`${stage}_fx`]));

  const bFx = rateOf('borrow');
  const uFx = rateOf('buy');
  const sFx = rateOf('sell');
  const rFx = rateOf('repay');

  const buyPrice = st.bought ? div(t.buy_amount, t.buy_eth) : null;
  const sellPrice = st.sold ? div(t.sell_amount, t.sell_eth) : null;

  // Gross gain is the proceeds less what the ETH actually sold cost to buy.
  // Subtracting the whole purchase from a partial sale reads as a huge loss
  // even when the sale was profitable, so scale the basis to the ETH sold.
  // When the position is closed out in full this is simply buy_amount.
  const soldFraction = st.sold && st.bought ? Math.min(t.sell_eth / t.buy_eth, 1) : null;
  const costOfSoldEth = soldFraction === null ? null : t.buy_amount * soldFraction;
  const grossGain = costOfSoldEth === null ? null : t.sell_amount - costOfSoldEth;
  const retainedEth = st.bought ? Math.max(t.buy_eth - (st.sold ? t.sell_eth : 0), 0) : null;
  const isPartialSale = st.sold && st.bought && t.sell_eth < t.buy_eth * 0.9999;

  // Days of the loan: to the repayment when closed, otherwise running to today.
  const endDate = st.repaid ? t.repay_date : asOf;
  const days = daysBetween(t.borrow_date, endDate);
  const elapsedDays = daysBetween(t.borrow_date, asOf);

  const interest = accruedInterest(t.borrow_amount, t.borrow_apr, days);
  const suggestedRepay = interest === null ? null : t.borrow_amount + interest;

  // Net gain is the gain on the ETH actually sold, less the financing cost of
  // the loan. When the whole position was bought with the loan and sold in one
  // go this is exactly `proceeds - repaid`, which is how the source
  // spreadsheet states it. Written this way it stays correct for a partial
  // sale too, where `proceeds - repaid` would charge the entire loan against
  // only part of the position and report a profitable trade as a large loss.
  const interestPaid = st.repaid ? t.repay_amount - t.borrow_amount : null;
  const netGain =
    st.sold && st.repaid && grossGain !== null ? grossGain - interestPaid : null;

  // While a position is sold but not yet repaid, estimate the same figure from
  // the interest accrued so far.
  const openNet =
    st.sold && !st.repaid && grossGain !== null && interest !== null
      ? grossGain - interest
      : null;

  /* ------------------------------------------------------------ in dollars */

  const borrowUsd = toUsd(t.borrow_amount, bFx);
  const buyUsd = st.bought ? toUsd(t.buy_amount, uFx) : null;
  const sellUsd = st.sold ? toUsd(t.sell_amount, sFx) : null;
  const repayUsd = st.repaid ? toUsd(t.repay_amount, rFx) : null;

  // The cost basis is marked at the day of the purchase, never the day of the
  // sale. Converting it at the sale's rate would fold the currency's own move
  // into the trading gain and count it twice, since the loan already carries
  // that move below.
  const costOfSoldEthUsd =
    soldFraction === null || buyUsd === null ? null : buyUsd * soldFraction;
  const grossGainUsd =
    sellUsd === null || costOfSoldEthUsd === null ? null : sellUsd - costOfSoldEthUsd;

  // The ETH price has to be converted too. Dividing a euro amount by a quantity
  // of ETH gives euros per ETH, and the interface labels that column dollars.
  const buyPriceUsd = div(buyUsd, t.buy_eth);
  const sellPriceUsd = div(sellUsd, t.sell_eth);

  // A forecast on a loan still running, so it is converted at the borrow rate:
  // no later rate exists yet, and inventing one would dress a guess up as a
  // measurement.
  const accruedInterestUsd = toUsd(interest, bFx);
  const suggestedRepayUsd =
    borrowUsd === null || accruedInterestUsd === null ? null : borrowUsd + accruedInterestUsd;

  // What the loan really cost in dollars, which for a euro loan is the interest
  // plus whatever the euro did to the principal in the meantime. It can be
  // negative: if the euro fell between borrowing and repaying, the loan was
  // cheaper in dollars than the interest alone. That is a real result, not a
  // bug, so it is shown split into its two parts rather than hidden.
  const interestPaidUsd = toUsd(interestPaid, rFx);
  const principalFxUsd =
    st.repaid && bFx !== null && rFx !== null ? t.borrow_amount * (rFx - bFx) : null;
  const loanCostUsd =
    repayUsd === null || borrowUsd === null ? null : repayUsd - borrowUsd;

  const netGainUsd =
    grossGainUsd === null || loanCostUsd === null ? null : grossGainUsd - loanCostUsd;

  // The headline rate is annualized on the dollar result, so that a euro trade
  // and a dollar trade can be put side by side at all.
  const pct = annualizedPct(netGainUsd, borrowUsd, days);
  const pctNative = annualizedPct(netGain, t.borrow_amount, days);

  // Omits the currency's unrealized move on the principal, because the loan has
  // not been repaid and that move has not happened yet.
  const projectedNetGainUsd =
    grossGainUsd === null || accruedInterestUsd === null || st.repaid
      ? null
      : grossGainUsd - accruedInterestUsd;

  // Which stages this trade has actually reached, and so which ones need a rate
  // at all. An open trade is not missing a sale rate; it has not sold anything.
  const fxNeeded = pegged
    ? []
    : ['borrow', st.bought && 'buy', st.sold && 'sell', st.repaid && 'repay'].filter(Boolean);
  const fxMissing = fxNeeded.filter((s) => num(t[`${s}_fx`]) === null);

  const fx = {};
  for (const s of FX_STAGES) {
    fx[s] = {
      rate: rateOf(s),
      // For a dollar coin the rate was not looked up anywhere, so the date of
      // the transaction is the honest answer.
      date: pegged ? t[`${s}_date`] ?? null : t[`${s}_fx_date`] ?? null,
    };
  }

  return {
    status,
    stages: st,
    days,
    elapsedDays,
    buyPrice,
    sellPrice,
    grossGain,
    costOfSoldEth,
    retainedEth,
    isPartialSale,
    accruedInterest: interest,
    interestPaid,
    suggestedRepay,
    netGain,
    pct,
    pctNative,
    projectedNetGain: openNet,
    ethHeld: st.bought && !st.sold ? t.buy_eth : null,

    borrowUsd,
    buyUsd,
    sellUsd,
    repayUsd,
    costOfSoldEthUsd,
    grossGainUsd,
    buyPriceUsd,
    sellPriceUsd,
    accruedInterestUsd,
    suggestedRepayUsd,
    interestPaidUsd,
    principalFxUsd,
    loanCostUsd,
    netGainUsd,
    projectedNetGainUsd,

    isUsdPegged: pegged,
    fx,
    // Where the rates came from. One value for the row, because that is what
    // the row stores: repeating it inside each stage claimed a provenance per
    // transaction that a single `fx_source` column cannot support.
    fxSource: pegged ? 'peg' : t.fx_source ?? null,
    fxMissing,
    fxComplete: fxMissing.length === 0,
  };
}

/**
 * A trade counts as realized only once it has been both sold and repaid, which
 * is the point at which a net gain exists. `summarize` used to call every
 * repaid trade closed while `summaryReport` required a net gain, so the two
 * disagreed about the same row.
 *
 * This gates on the native gain on purpose. A trade whose exchange rate has not
 * been fetched yet is still closed and still finished; it is only its worth in
 * dollars that is unknown. Counting it as open would be a lie about the trade
 * rather than about the money.
 */
export function isRealized(d) {
  return d.status === STATUS.CLOSED && d.netGain !== null;
}

/**
 * Realized and convertible: the trade has a dollar result that can be added to
 * other dollar results. Every money total is gated on this, every count on
 * `isRealized`, which is what lets a trade with no rate be honestly reported as
 * closed without its unknown value leaking into a total as a zero.
 */
export function hasUsdResult(d) {
  return isRealized(d) && d.netGainUsd !== null;
}

/** Aggregate figures for the header tiles. */
export function summarize(trades, asOf = todayISO()) {
  let netGain = 0;
  let closed = 0;
  let valued = 0;
  let open = 0;
  let weightedPct = 0;
  let weight = 0;
  let deployed = 0;
  let missingFx = 0;
  const missingFxIds = [];

  for (const t of trades) {
    const d = t.derived ?? derive(t, asOf);
    if (!d.fxComplete) {
      missingFx += 1;
      missingFxIds.push(t.id);
    }
    if (isRealized(d)) {
      closed += 1;
      if (hasUsdResult(d)) {
        valued += 1;
        netGain += d.netGainUsd;
        if (d.pct !== null) {
          // Weighted on the dollar size of the loan, not the native one. Thirty
          // thousand euros and thirty thousand dollars are not the same amount
          // of capital and must not carry the same weight.
          //
          // And on time as well as capital: weighting on size alone let a one
          // day flip that made $50 count as heavily as a ninety day trade that
          // made $900, which dragged the headline rate from 38% to 110%.
          const w = d.borrowUsd * Math.max(d.days ?? 1, 1);
          weightedPct += d.pct * w;
          weight += w;
        }
      }
    } else {
      open += 1;
      // Only a loan that has not been repaid is still tying up capital.
      if (!d.stages.repaid && d.borrowUsd !== null) deployed += d.borrowUsd;
    }
  }

  return {
    // Null, not zero, when nothing has a dollar result yet. A closed trade
    // whose rate has not been fetched made a real gain that simply is not
    // known in dollars, and printing that as $0.00 states a figure nobody
    // measured.
    netGain: valued > 0 ? netGain : null,
    closedCount: closed,
    valuedCount: valued,
    openCount: open,
    avgPct: weight > 0 ? weightedPct / weight : null,
    deployed,
    missingFx,
    missingFxIds,
  };
}

/* ------------------------------------------------------------------ report */

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '2026-01-13' becomes { key: '2026-01', label: 'Jan 2026' }. */
export function monthOf(iso) {
  if (typeof iso !== 'string' || iso.length < 7) return null;
  const [y, m] = iso.split('-');
  const idx = Number(m) - 1;
  if (!MONTH_NAMES[idx]) return null;
  return { key: `${y}-${m}`, label: `${MONTH_NAMES[idx]} ${y}` };
}

/** Weighted mean, ignoring entries with no value or no weight. */
function weightedMean(pairs) {
  let total = 0;
  let weight = 0;
  for (const [value, w] of pairs) {
    if (num(value) === null || num(w) === null || w <= 0) continue;
    total += value * w;
    weight += w;
  }
  return weight > 0 ? total / weight : null;
}

/**
 * Everything the Summary view shows, derived from the same rows the table
 * renders. Only closed trades contribute to realized figures; open ones are
 * counted separately so capital still at work is never mistaken for a result.
 *
 * Every figure here is in dollars, converted at the rate published for the day
 * of each transaction. The one exception is the by currency table, where a
 * native total is meaningful precisely because the rows are grouped by currency.
 */
export function summaryReport(trades, asOf = todayISO()) {
  const rows = trades.map((t) => ({ t, d: t.derived ?? derive(t, asOf) }));
  const closed = rows.filter(({ d }) => isRealized(d));
  // Closed and convertible. Money comes from here; counts come from `closed`.
  const valued = rows.filter(({ d }) => hasUsdResult(d));

  // --- by stablecoin
  const byCurrencyMap = new Map();
  for (const { t, d } of rows) {
    const key = t.borrow_currency;
    if (!byCurrencyMap.has(key)) {
      byCurrencyMap.set(key, {
        currency: key,
        closed: 0,
        open: 0,
        borrowed: 0,
        borrowedValued: 0,
        borrowedNative: 0,
        netGain: 0,
        netGainNative: 0,
        valued: 0,
        missingFx: 0,
        pctPairs: [],
      });
    }
    const bucket = byCurrencyMap.get(key);
    if (!d.fxComplete) bucket.missingFx += 1;
    // Borrowed is what was borrowed, realized or not. Counting only closed
    // trades showed a dash against a currency with $50,000 still outstanding,
    // which contradicted the Open positions tile on the same page.
    bucket.borrowedNative += t.borrow_amount;
    if (d.borrowUsd !== null) {
      bucket.borrowed += d.borrowUsd;
      bucket.borrowedValued += 1;
    }
    if (isRealized(d)) {
      bucket.closed += 1;
      bucket.netGainNative += d.netGain;
      if (hasUsdResult(d)) {
        bucket.valued += 1;
        bucket.netGain += d.netGainUsd;
        bucket.pctPairs.push([d.pct, d.borrowUsd * Math.max(d.days ?? 1, 1)]);
      }
    } else {
      bucket.open += 1;
    }
  }
  const byCurrency = [...byCurrencyMap.values()]
    .map((b) => ({
      currency: b.currency,
      closed: b.closed,
      open: b.open,
      borrowed: b.borrowedValued > 0 ? b.borrowed : null,
      borrowedNative: b.borrowedNative,
      netGain: b.valued > 0 ? b.netGain : null,
      netGainNative: b.closed > 0 ? b.netGainNative : null,
      missingFx: b.missingFx,
      avgPct: weightedMean(b.pctPairs),
    }))
    // Comparing two nulls as -Infinity minus -Infinity yields NaN, which makes
    // the sort order undefined. Rank the unrealized rows last explicitly.
    .sort((a, b) => {
      if (a.netGain === null && b.netGain === null) return a.currency < b.currency ? -1 : 1;
      if (a.netGain === null) return 1;
      if (b.netGain === null) return -1;
      return b.netGain - a.netGain;
    });

  // --- by month of realization
  const byMonthMap = new Map();
  for (const { t, d } of valued) {
    const month = monthOf(t.repay_date);
    if (!month) continue;
    if (!byMonthMap.has(month.key)) {
      byMonthMap.set(month.key, { ...month, trades: 0, netGain: 0, borrowed: 0 });
    }
    const bucket = byMonthMap.get(month.key);
    bucket.trades += 1;
    bucket.netGain += d.netGainUsd;
    bucket.borrowed += d.borrowUsd;
  }
  const byMonth = [...byMonthMap.values()].sort((a, b) => (a.key < b.key ? 1 : -1));

  // --- extremes, ranked on the money made rather than the annualized rate,
  // which a very short trade can inflate out of all proportion. Ranked in
  // dollars, since a euro gain and a dollar gain are not comparable as typed.
  let best = null;
  let worst = null;
  for (const { t, d } of valued) {
    const entry = { id: t.id, currency: t.borrow_currency, date: t.repay_date, netGain: d.netGainUsd, pct: d.pct };
    if (best === null || d.netGainUsd > best.netGain) best = entry;
    if (worst === null || d.netGainUsd < worst.netGain) worst = entry;
  }

  // Scored over the trades whose dollar result is known. A trade waiting on a
  // rate is neither a win nor a loss, and counting it as either would be made up.
  // A trade that came out exactly flat is neither a win nor a loss. Counting it
  // as a loss reported a break-even ledger as 0% won.
  const wins = valued.filter(({ d }) => d.netGainUsd > 0).length;
  const losses = valued.filter(({ d }) => d.netGainUsd < 0).length;
  const decided = wins + losses;
  const interestPaid = valued.reduce((sum, { d }) => sum + (d.interestPaidUsd ?? 0), 0);
  const currencyEffect = valued.reduce((sum, { d }) => sum + (d.principalFxUsd ?? 0), 0);
  const holdDays = closed.map(({ d }) => d.days).filter((v) => num(v) !== null);

  return {
    ...summarize(trades, asOf),
    tradeCount: rows.length,
    valuedCount: valued.length,
    totalBorrowed: valued.reduce((sum, { d }) => sum + d.borrowUsd, 0),
    interestPaid: valued.length > 0 ? interestPaid : null,
    currencyEffect: valued.length > 0 ? currencyEffect : null,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    wins,
    losses,
    avgHoldDays: holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : null,
    byCurrency,
    byMonth,
    best,
    worst,
  };
}
