/**
 * myAave trade math.
 *
 * This module is imported by the Node server AND served directly to the
 * browser, so both sides run identical formulas. Keep it dependency free
 * and side effect free.
 */

export const CURRENCIES = ['USDC', 'USDT', 'DAI', 'GHO'];

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

/** Today as an ISO 'YYYY-MM-DD' string in UTC. */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days between two ISO dates, or null when either is unusable. */
export function daysBetween(fromISO, toISO) {
  const a = parseDate(fromISO);
  const b = parseDate(toISO);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Amounts and quantities must be positive to count as filled in. A rate of
// exactly 0 is meaningful, so it goes through `num` rather than this.
const qty = (v) => (num(v) !== null && v > 0 ? v : null);
const div = (a, b) => (num(a) !== null && num(b) !== null && b !== 0 ? a / b : null);

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
  const pct = annualizedPct(netGain, t.borrow_amount, days);

  // While a position is sold but not yet repaid, estimate the same figure from
  // the interest accrued so far.
  const openNet =
    st.sold && !st.repaid && grossGain !== null && interest !== null
      ? grossGain - interest
      : null;

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
    projectedNetGain: openNet,
    ethHeld: st.bought && !st.sold ? t.buy_eth : null,
  };
}

/**
 * A trade counts as realized only once it has been both sold and repaid, which
 * is the point at which a net gain exists. `summarize` used to call every
 * repaid trade closed while `summaryReport` required a net gain, so the two
 * disagreed about the same row.
 */
export function isRealized(d) {
  return d.status === STATUS.CLOSED && d.netGain !== null;
}

/** Aggregate figures for the header tiles. */
export function summarize(trades, asOf = todayISO()) {
  let netGain = 0;
  let closed = 0;
  let open = 0;
  let weightedPct = 0;
  let weight = 0;
  let deployed = 0;

  for (const t of trades) {
    const d = t.derived ?? derive(t, asOf);
    if (isRealized(d)) {
      closed += 1;
      netGain += d.netGain;
      if (d.pct !== null) {
        weightedPct += d.pct * t.borrow_amount;
        weight += t.borrow_amount;
      }
    } else {
      open += 1;
      // Only a loan that has not been repaid is still tying up capital.
      if (!d.stages.repaid) deployed += t.borrow_amount;
    }
  }

  return {
    netGain,
    closedCount: closed,
    openCount: open,
    avgPct: weight > 0 ? weightedPct / weight : null,
    deployed,
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
 */
export function summaryReport(trades, asOf = todayISO()) {
  const rows = trades.map((t) => ({ t, d: t.derived ?? derive(t, asOf) }));
  const closed = rows.filter(({ d }) => isRealized(d));

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
        netGain: 0,
        pctPairs: [],
      });
    }
    const bucket = byCurrencyMap.get(key);
    if (isRealized(d)) {
      bucket.closed += 1;
      bucket.borrowed += t.borrow_amount;
      bucket.netGain += d.netGain;
      bucket.pctPairs.push([d.pct, t.borrow_amount]);
    } else {
      bucket.open += 1;
    }
  }
  const byCurrency = [...byCurrencyMap.values()]
    .map((b) => ({
      currency: b.currency,
      closed: b.closed,
      open: b.open,
      borrowed: b.borrowed,
      netGain: b.closed > 0 ? b.netGain : null,
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
  for (const { t, d } of closed) {
    const month = monthOf(t.repay_date);
    if (!month) continue;
    if (!byMonthMap.has(month.key)) {
      byMonthMap.set(month.key, { ...month, trades: 0, netGain: 0, borrowed: 0 });
    }
    const bucket = byMonthMap.get(month.key);
    bucket.trades += 1;
    bucket.netGain += d.netGain;
    bucket.borrowed += t.borrow_amount;
  }
  const byMonth = [...byMonthMap.values()].sort((a, b) => (a.key < b.key ? 1 : -1));

  // --- extremes, ranked on the money made rather than the annualized rate,
  // which a very short trade can inflate out of all proportion.
  let best = null;
  let worst = null;
  for (const { t, d } of closed) {
    const entry = { id: t.id, currency: t.borrow_currency, date: t.repay_date, netGain: d.netGain, pct: d.pct };
    if (best === null || d.netGain > best.netGain) best = entry;
    if (worst === null || d.netGain < worst.netGain) worst = entry;
  }

  const wins = closed.filter(({ d }) => d.netGain > 0).length;
  const interestPaid = closed.reduce((sum, { d }) => sum + (d.interestPaid ?? 0), 0);
  const holdDays = closed.map(({ d }) => d.days).filter((v) => num(v) !== null);

  return {
    ...summarize(trades, asOf),
    tradeCount: rows.length,
    totalBorrowed: closed.reduce((sum, { t }) => sum + t.borrow_amount, 0),
    interestPaid: closed.length > 0 ? interestPaid : null,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : null,
    wins,
    losses: closed.length - wins,
    avgHoldDays: holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : null,
    byCurrency,
    byMonth,
    best,
    worst,
  };
}
