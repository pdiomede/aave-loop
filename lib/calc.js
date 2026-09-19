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
const div = (a, b) => (num(a) !== null && num(b) !== null && b !== 0 ? a / b : null);

/**
 * Simple interest accrued on a loan.
 * amount * apr% * days / 365
 */
export function accruedInterest(amount, aprPercent, days) {
  if (num(amount) === null || num(aprPercent) === null || num(days) === null) return null;
  return amount * (aprPercent / 100) * (days / 365);
}

/**
 * Annualized simple return on the borrowed capital.
 * This is the '%' column of the source spreadsheet: a 3 day trade that nets
 * 7.2% reads as 877%, because the figure is scaled to a full year.
 */
export function annualizedPct(netGain, loan, days) {
  if (num(netGain) === null || num(loan) === null || num(days) === null || loan === 0) return null;
  // A same day open and close still represents a day of capital at work.
  const span = Math.max(days, 1);
  return (netGain / loan) * (365 / span) * 100;
}

/** Stage completion flags for a raw trade row. */
export function stages(t) {
  const bought = t.buy_date != null && num(t.buy_amount) !== null && num(t.buy_eth) !== null;
  const sold = t.sell_date != null && num(t.sell_amount) !== null && num(t.sell_eth) !== null;
  const repaid = t.repay_date != null && num(t.repay_amount) !== null;
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
  const grossGain = st.sold && st.bought ? t.sell_amount - t.buy_amount : null;

  // Days of the loan: to the repayment when closed, otherwise running to today.
  const endDate = st.repaid ? t.repay_date : asOf;
  const days = daysBetween(t.borrow_date, endDate);
  const elapsedDays = daysBetween(t.borrow_date, asOf);

  const interest = accruedInterest(t.borrow_amount, t.borrow_apr, days);
  const suggestedRepay = interest === null ? null : t.borrow_amount + interest;

  const netGain = st.sold && st.repaid ? t.sell_amount - t.repay_amount : null;
  const pct = annualizedPct(netGain, t.borrow_amount, days);

  // While a position is still open, show what it would net if closed today.
  const openNet =
    st.sold && !st.repaid && suggestedRepay !== null ? t.sell_amount - suggestedRepay : null;

  return {
    status,
    stages: st,
    days,
    elapsedDays,
    buyPrice,
    sellPrice,
    grossGain,
    accruedInterest: interest,
    suggestedRepay,
    netGain,
    pct,
    projectedNetGain: openNet,
    ethHeld: st.bought && !st.sold ? t.buy_eth : null,
  };
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
    if (d.status === STATUS.CLOSED) {
      closed += 1;
      if (d.netGain !== null) netGain += d.netGain;
      if (d.pct !== null) {
        weightedPct += d.pct * t.borrow_amount;
        weight += t.borrow_amount;
      }
    } else {
      open += 1;
      deployed += t.borrow_amount;
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
