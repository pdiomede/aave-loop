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
 * a dollar pegged coin is exactly 1. Nothing inverts a rate, with one named
 * exception: a gas fee is typed in dollars, and taking it off a euro result
 * divides it by the rate of the stage it was paid on (see `derive`).
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

/**
 * How long a rate published before the day it is applied to is still worth
 * asking about again.
 *
 * The ECB publishes once per business day, in the afternoon. A trade saved
 * that morning is converted at the day before's rate, and asking again later
 * replaces that stand-in with the real thing. Once the day is a few days past,
 * there is nothing left to replace: the day was a weekend or an ECB holiday,
 * and the rate carried forward from the business day before it is the rate,
 * permanently.
 *
 * This used to be tested by asking whether the day was a weekday, which left
 * every ECB holiday, Christmas and Easter among them, queued for replacement
 * forever and re-fetched on every refresh.
 */
export const FX_PROVISIONAL_DAYS = 4;

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
 * Is a stored rate a stand-in that asking again could still replace?
 *
 * True only when the rate was published before the day it is applied to AND
 * that day is recent enough for the real rate to still be on its way. Both
 * halves matter: the first alone marks every weekend forever, and the second
 * alone marks days that were converted at their own published rate.
 */
export function isProvisionalFx(stageDate, rateDate, asOf = todayISO()) {
  if (typeof stageDate !== 'string' || typeof rateDate !== 'string') return false;
  if (rateDate >= stageDate) return false;
  const age = daysBetween(stageDate, asOf);
  return age !== null && age <= FX_PROVISIONAL_DAYS;
}

/**
 * A comma grouping three digits is a thousands separator. A comma followed by
 * one or two digits is a European decimal point, and stripping it blind read
 * "32.000,00" as 32 and "32000,50" as 3200050. Convert that case instead.
 *
 * So is a comma followed by four or more: no thousands separator groups more
 * than three. ETH quantities nearly always carry four decimals, and pasting
 * "8,0773" into ETH purchased stored 80,773 ETH, with an ETH price of $0.31
 * as the only sign anything was wrong.
 *
 * And so is any comma after a whole part of nothing but zeros, however many
 * digits follow: no grouped number starts with a 0 group, so "0,125" can only
 * be a decimal. Read by the three digit rule, a gas fee of 0,125 was stored as
 * $125.
 */
const DECIMAL_COMMA = /^[+-]?0+,\d+$|,(?:\d{1,2}|\d{4,})(?!\d)/;

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

/** The column holding what a stage's transaction cost in gas, in dollars. */
export const gasKey = (stage) => `${stage}_gas_usd`;

/**
 * The Aave legs of a loop, which not every trade has: supplying the ETH once it
 * is bought, and withdrawing it before it is sold. Optional, so unlike the fee
 * above a NULL here means none was paid, and it never makes a stage "not
 * recorded".
 */
export const OPTIONAL_GAS = { buy: ['buy_lend_gas_usd'], sell: ['sell_unstake_gas_usd'] };

/** Every gas column a stage carries, the required one first. */
export const gasKeys = (stage) => [gasKey(stage), ...(OPTIONAL_GAS[stage] ?? [])];

/** The stages a trade has actually reached, in order. */
export function reachedStages(st) {
  return ['borrow', st.bought && 'buy', st.sold && 'sell', st.repaid && 'repay'].filter(Boolean);
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

  // Gas, typed in dollars, one required fee per stage reached plus the
  // optional Aave ones on the purchase and the sale (see `OPTIONAL_GAS`).
  // Summed over the stages reached only, so a fee left behind on a stage that
  // was later cleared does not go on costing money.
  //
  // A trade recorded before fees were asked for has none, and an unrecorded fee
  // is not a free one: `feesUsd` stays null when nothing was recorded, and
  // `feesMissing` names the stages that have no figure, so the interface can say
  // "not recorded" instead of printing $0.00. The results below subtract what
  // was recorded, which on such a trade is nothing, so its figures read exactly
  // as they did before.
  const reached = reachedStages(st);
  //
  // Only the required fee can be missing: an optional one left blank is a leg
  // that was not taken, so it adds nothing and names no stage.
  const gasRecorded = reached.flatMap((s) => gasKeys(s).map((k) => num(t[k]))).filter((v) => v !== null);
  const feesUsd = gasRecorded.length > 0 ? gasRecorded.reduce((a, b) => a + b, 0) : null;
  const feesMissing = reached.filter((s) => num(t[gasKey(s)]) === null);
  const fees = feesUsd ?? 0;

  // The fees in the borrowed coin, for the native result. Gas is paid in
  // dollars, so for a dollar coin it comes off as it stands (the rate is
  // exactly 1, as for every other conversion of it). For any other coin each
  // fee is converted at the rate of its own stage, the day it was paid - the
  // one place in this module a rate is divided by, because a figure typed in
  // dollars has to reach a euro result somehow and inventing a rate is worse.
  // A fee on a stage whose rate is not known yet leaves the native result
  // unknown rather than short; a fee of 0 needs no rate at all.
  let feesNative = 0;
  // An optional Aave fee is paid the same day as its stage, so it converts at
  // that stage's rate too.
  for (const s of reached) {
    for (const key of gasKeys(s)) {
      const fee = num(t[key]);
      if (fee === null || fee === 0) continue;
      const rate = rateOf(s);
      if (feesNative === null || rate === null || rate === 0) {
        feesNative = null;
        continue;
      }
      feesNative += pegged ? fee : fee / rate;
    }
  }

  const netGain =
    st.sold && st.repaid && grossGain !== null && feesNative !== null
      ? grossGain - interestPaid - feesNative
      : null;

  // While a position is sold but not yet repaid, estimate the same figure from
  // the interest accrued so far.
  const openNet =
    st.sold && !st.repaid && grossGain !== null && interest !== null && feesNative !== null
      ? grossGain - interest - feesNative
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
    grossGainUsd === null || loanCostUsd === null ? null : grossGainUsd - loanCostUsd - fees;

  // The headline rate is annualized on the dollar result, so that a euro trade
  // and a dollar trade can be put side by side at all.
  const pct = annualizedPct(netGainUsd, borrowUsd, days);
  const pctNative = annualizedPct(netGain, t.borrow_amount, days);

  // Omits the currency's unrealized move on the principal, because the loan has
  // not been repaid and that move has not happened yet.
  const projectedNetGainUsd =
    grossGainUsd === null || accruedInterestUsd === null || st.repaid
      ? null
      : grossGainUsd - accruedInterestUsd - fees;

  // Which stages this trade has actually reached, and so which ones need a rate
  // at all. An open trade is not missing a sale rate; it has not sold anything.
  const fxNeeded = pegged
    ? []
    : reached;
  const fxMissing = fxNeeded.filter((s) => num(t[`${s}_fx`]) === null);

  // Stages converted at a rate published before the day of the transaction,
  // while that day is recent enough for the real rate to still arrive. The
  // figure shown is the honest best available either way; this only says which
  // ones asking again could still improve.
  const fxProvisional = fxNeeded.filter(
    (s) => num(t[`${s}_fx`]) !== null && isProvisionalFx(t[`${s}_date`], t[`${s}_fx_date`], asOf),
  );

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
    feesUsd,
    feesMissing,
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
    fxProvisional,
  };
}

/**
 * A trade counts as realized only once it has been both sold and repaid, which
 * is the point at which a net gain exists. `summarize` used to call every
 * repaid trade closed while `summaryReport` required a net gain, so the two
 * disagreed about the same row.
 *
 * This gates on the trade, not on its dollar result. A trade whose exchange rate
 * has not been fetched yet is still closed and still finished; it is only its
 * worth in dollars that is unknown. Counting it as open would be a lie about the
 * trade rather than about the money.
 *
 * It used to read `d.netGain !== null`, which meant the same thing until gas
 * fees arrived: a euro trade's native net gain now also needs the rate of every
 * stage that carried a fee (see `derive`), and gating on it would have filed a
 * closed EURC trade as open while one of those rates was still missing. A gross gain exists
 * exactly when the old native gain did - sold, with a purchase to measure it
 * against - and repaid is what CLOSED already says.
 */
export function isRealized(d) {
  return d.status === STATUS.CLOSED && d.grossGain !== null;
}

/**
 * What an open position is up or down at a given price.
 *
 * Everything else in this file works from the trade alone, and this needs one
 * fact the trade does not carry: what ETH costs today. That is why the
 * projected gain above begins only once the ETH is sold and the proceeds are a
 * fact. Handed a price, though, the same subtraction can be done a stage
 * earlier - what the ETH would fetch, less what was spent on it, less the
 * interest the loan has run up since - and taking the price as an argument
 * keeps this module as pure as the rest of it. It fetches nothing.
 *
 * Null whenever any part of that is unknown, which on a loan in a currency
 * that is not a dollar means until its exchange rate has been looked up. A
 * gain missing a term is not a smaller gain, it is a wrong one.
 */
export function unrealisedUsd(d, price) {
  if (!Number.isFinite(d.ethHeld) || !Number.isFinite(price)) return null;
  if (!Number.isFinite(d.buyUsd) || !Number.isFinite(d.accruedInterestUsd)) return null;
  // Less the gas already paid to borrow, buy and lend, which is as spent as the
  // purchase is.
  return d.ethHeld * price - d.buyUsd - d.accruedInterestUsd - (d.feesUsd ?? 0);
}

/**
 * What an open position would come to if it were closed today: the one
 * estimate the header, the table's Net gain column and Telegram's /holding all
 * print, so the same trade never reads two ways. Null for anything else - a
 * closed trade has a real result, and a loan with nothing bought yet holds no
 * position to value, the way the table gives it a dash.
 *
 * A trade still holding its ETH is valued at `price`. One that has sold but not
 * repaid has its proceeds, so it takes the projection `derive` already makes -
 * plus, after a partial sale, the ETH still held at `price` less what that ETH
 * cost. Leaving that ETH out understated every such position by its whole
 * value. Only the estimate counts it: once the loan is repaid the result is
 * the gain on the ETH sold, because nothing records what the rest was worth on
 * that day.
 *
 * Every open position on a loan in another currency is marked at today's
 * exchange rate, `fxNow[currency]`, the way its ETH is marked at today's price:
 * closing it today means selling at this price and repaying the coin at this
 * rate. Unlike everywhere else in this module, which never marks an open
 * position to a rate nobody transacted at, because this figure is a rough
 * "where would I stand" and says so. Today's rate is the ECB's daily one, not a
 * live quote. Without it the trade's stored rates stand in.
 *
 * Held and sold alike. A sold trade once kept its stored rates while a held one
 * took today's, and selling 0.01 ETH of a euro position moved its estimate by
 * the whole currency move on the principal - $3,612 on 30,000 EURC bought at
 * 1.05 with the euro at 1.17 - for a sale worth $34.50.
 */
export function estimatedGainUsd(t, d, price, fxNow = {}) {
  if (!hasEstimate(d)) return null;
  const today = estimateRate(t, d, fxNow);
  if (Number.isFinite(d.ethHeld)) return markedUsd(t, d, price, today);

  if (today !== null) {
    const base = soldMarkedUsd(d, today);
    if (base === null || !holdsAfterSale(d)) return base;
    if (!Number.isFinite(price)) return null;
    return base + d.retainedEth * price - (t.buy_amount - d.costOfSoldEth) * today;
  }

  // No rate for today: the projection at the trade's stored rates, and the ETH
  // kept at the cost those same rates put on it.
  const stored = d.projectedNetGainUsd;
  if (stored === null || !holdsAfterSale(d)) return stored;
  if (!Number.isFinite(price)) return null;
  return stored + d.retainedEth * price - (d.buyUsd - d.costOfSoldEthUsd);
}

/**
 * The rate `estimatedGainUsd` marks a trade at: 1 for a dollar coin, today's
 * for any other when it is known, null when the stored rates stand in. Exported
 * so a message can say which rate a figure was converted at.
 */
export function estimateRate(t, d, fxNow = {}) {
  if (d.isUsdPegged) return 1;
  const rate = fxNow?.[t.borrow_currency];
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Whether `estimatedGainUsd` has a position to value at all. */
export function hasEstimate(d) {
  if (isRealized(d)) return false;
  return Number.isFinite(d.ethHeld) || (d.stages.sold && !d.stages.repaid);
}

/** Whether the estimate moves with the ETH price, so is unknown without one. */
export function estimateNeedsPrice(d) {
  return hasEstimate(d) && (Number.isFinite(d.ethHeld) || holdsAfterSale(d));
}

/** Sold, not repaid, and some of the ETH bought is still held - "Still held" on the card. */
function holdsAfterSale(d) {
  return d.stages.sold && !d.stages.repaid && d.isPartialSale && d.retainedEth > 0;
}

/**
 * Every open position's estimate and their sum, for the header's Open
 * positions tile.
 *
 * `total` is over the known figures only and null when there are none: a
 * position with no figure is counted in `missing`, never added as a zero.
 * With no ETH price the total is null outright whenever a position depends on
 * it, since a sum of the others alone would be printed as the whole.
 */
export function openGainsUsd(trades, price, fxNow = {}, asOf = todayISO()) {
  const rows = [];
  let total = 0;
  let known = 0;
  let missing = 0;
  let unpriced = 0;
  for (const t of trades) {
    const d = t.derived ?? derive(t, asOf);
    if (!hasEstimate(d)) continue;
    if (!Number.isFinite(price) && estimateNeedsPrice(d)) unpriced += 1;
    const gain = estimatedGainUsd(t, d, price, fxNow);
    rows.push({ id: t.id, gain });
    if (gain === null) missing += 1;
    else {
      total += gain;
      known += 1;
    }
  }
  // In trade order, so the line under the total reads the way the ids count.
  rows.sort((a, b) => a.id - b.id);
  return { rows, total: known > 0 && unpriced === 0 ? total : null, missing };
}

/**
 * A held position closed today: the ETH at `price`, less what it cost and the
 * interest run up, both in the borrowed coin at today's `rate`, less the gas
 * already paid. On a dollar coin the rate is 1 and this is `unrealisedUsd`.
 */
function markedUsd(t, d, price, r) {
  if (r === null) return unrealisedUsd(d, price);
  if (!Number.isFinite(price) || !Number.isFinite(d.accruedInterest)) return null;
  return d.ethHeld * price - (t.buy_amount + d.accruedInterest) * r - (d.feesUsd ?? 0);
}

/** A sale not yet repaid, its coin result converted at `rate`. */
function soldMarkedUsd(d, rate) {
  if (rate === null) return null;
  if (!Number.isFinite(d.grossGain) || !Number.isFinite(d.accruedInterest)) return null;
  return (d.grossGain - d.accruedInterest) * rate - (d.feesUsd ?? 0);
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
  let deployedValued = 0;
  let deployedMissingFx = 0;
  let missingFx = 0;
  let provisionalFx = 0;
  const missingFxIds = [];

  for (const t of trades) {
    const d = t.derived ?? derive(t, asOf);
    if (!d.fxComplete) {
      missingFx += 1;
      missingFxIds.push(t.id);
    }
    if (d.fxProvisional?.length) provisionalFx += 1;
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
      if (!d.stages.repaid) {
        // An open loan with no rate yet is real capital of an unknown dollar
        // size. It cannot be added, but the count beside the total includes it,
        // so the two disagree unless the total says it is incomplete.
        if (d.borrowUsd !== null) {
          deployed += d.borrowUsd;
          deployedValued += 1;
        } else deployedMissingFx += 1;
      }
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
    // Null when no open loan has a rate, for the same reason as `netGain`:
    // capital of an unknown dollar size printed as "1 ($0.00)", a figure
    // nobody measured, with the chip beside it contradicting it.
    deployed: deployedValued > 0 ? deployed : null,
    deployedMissingFx,
    missingFx,
    missingFxIds,
    // Rows carrying a stand-in rate. Not missing, but still replaceable, which
    // is why the interface offers to ask again even when nothing is missing.
    provisionalFx,
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

/**
 * The year a trade is reported under on the Stats view.
 *
 * The year it was repaid, because that is when the loan was closed and the
 * result became a fact - the same rule "By month closed" has always used, so a
 * trade opened in December and repaid in January lands in the same year as its
 * month row does. Repaid, not realized: a loan settled without the ETH being
 * sold still has a closure date, and filing it anywhere else would split one
 * trade's figures between two years.
 *
 * A trade not repaid yet has no closure date, so it counts in the year it is
 * still running in, which is always the current one. That keeps capital still
 * out visible on this year's tab rather than on the year it happened to start.
 *
 * Asks `derive` rather than testing `repay_date`, because a date without an
 * amount is not a repayment and the two tests have drifted before.
 */
export function statsYear(t, asOf = todayISO()) {
  const d = t.derived ?? derive(t, asOf);
  const iso = d.stages.repaid ? t.repay_date : asOf;
  return typeof iso === 'string' && iso.length >= 4 ? iso.slice(0, 4) : null;
}

/** Every year some trade is reported under, newest first. */
export function statsYears(trades, asOf = todayISO()) {
  const years = new Set();
  for (const t of trades) {
    const y = statsYear(t, asOf);
    if (y) years.add(y);
  }
  return [...years].sort((a, b) => (a < b ? 1 : -1));
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
 * Everything the Stats view shows, derived from the same rows the table
 * renders, and called once per year tab over that year's trades. Only closed
 * trades contribute to realized figures; open ones are counted separately so
 * capital still at work is never mistaken for a result.
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
        nativeCount: 0,
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
    // Both lines of the Borrowed cell have to cover the same trades. The
    // dollar total can only include a trade whose rate is known, so the native
    // total beneath it must be gated the same way: summing every trade there
    // while the dollars omitted some read as a rate of 0.74 on a column of
    // euros converted at 1.06 to 1.13, and the two lines are shown precisely so
    // one can be checked against the other. The `no rate` chip on the row is
    // what says some trades are missing from both.
    if (d.borrowUsd !== null) {
      bucket.borrowed += d.borrowUsd;
      bucket.borrowedNative += t.borrow_amount;
      bucket.borrowedValued += 1;
    }
    if (isRealized(d)) {
      bucket.closed += 1;
      // A euro trade has no native result while a stage carrying a fee has no
      // rate yet (see `derive`). Added unguarded, its null counted as 0 and the
      // total quietly understated the bucket that held it.
      if (d.netGain !== null) {
        bucket.netGainNative += d.netGain;
        bucket.nativeCount += 1;
      }
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
      netGainNative: b.closed > 0 && b.nativeCount === b.closed ? b.netGainNative : null,
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

  // --- extremes, ranked twice over the same trades.
  //
  // In dollars, because a euro gain and a dollar gain are not comparable as
  // typed; and in the annualized rate, because the two orders disagree and the
  // disagreement is the interesting part. A trade held four days that made $75
  // can be the best return on this ledger and the smallest cheque on it at the
  // same time, and a card that only ever ranked one way could not say so.
  //
  // The rate ranking skips a trade whose `pct` is null, which `hasUsdResult`
  // says nothing about: `annualizedPct` answers null on a zero loan, on a date
  // it cannot read and on a span that runs backwards. Compared unguarded, null
  // sits below every positive rate and would take "smallest" on a ledger where
  // nothing had gone wrong at all.
  let best = null;
  let worst = null;
  let bestPct = null;
  let worstPct = null;
  for (const { t, d } of valued) {
    const entry = { id: t.id, currency: t.borrow_currency, date: t.repay_date, netGain: d.netGainUsd, pct: d.pct };
    if (best === null || d.netGainUsd > best.netGain) best = entry;
    if (worst === null || d.netGainUsd < worst.netGain) worst = entry;
    if (!Number.isFinite(d.pct)) continue;
    if (bestPct === null || d.pct > bestPct.pct) bestPct = entry;
    if (worstPct === null || d.pct < worstPct.pct) worstPct = entry;
  }

  // Scored over the trades whose dollar result is known. A trade waiting on a
  // rate is neither a win nor a loss, and counting it as either would be made up.
  // A trade that came out exactly flat is neither a win nor a loss. Counting it
  // as a loss reported a break-even ledger as 0% won.
  //
  // Judged in whole cents, the figure as printed. Flat to the cent is not flat
  // in floating point once fees come off: 12.30 - 10.10 - 2.20 left
  // -1.09e-12, printed $0.00 on the card and scored a loss here.
  const cents = (v) => Math.round(v * 100);
  const wins = valued.filter(({ d }) => cents(d.netGainUsd) > 0).length;
  const losses = valued.filter(({ d }) => cents(d.netGainUsd) < 0).length;
  const decided = wins + losses;
  const interestPaid = valued.reduce((sum, { d }) => sum + (d.interestPaidUsd ?? 0), 0);
  const currencyEffect = valued.reduce((sum, { d }) => sum + (d.principalFxUsd ?? 0), 0);
  // Every fee paid by the trades on this tab, open ones included, the way Total
  // borrowed counts them. Gas is spent the moment the transaction lands - an
  // open trade has already paid to borrow and to buy - and it is typed in
  // dollars, so a closed euro trade still waiting on a rate has a known fee all
  // the same. Gated like interest, the total read only the closed and valued
  // trades and understated what the year actually paid. Null until some trade
  // has a fee on it, and the trades with a stage still unrecorded are counted
  // rather than folded in as free, so the tile can say its total is short.
  const withFees = rows.filter(({ d }) => d.feesUsd !== null);
  const feesPaid = withFees.reduce((sum, { d }) => sum + d.feesUsd, 0);
  const feesUnrecorded = rows.filter(({ d }) => d.feesMissing.length > 0).length;
  // Measured over the same trades the money figures use. Taken over all closed
  // trades it described a different population from every other row in the
  // card, which is a quiet way to make two correct numbers look inconsistent.
  const holdDays = valued.map(({ d }) => d.days).filter((v) => num(v) !== null);

  return {
    ...summarize(trades, asOf),
    tradeCount: rows.length,
    valuedCount: valued.length,
    // Everything borrowed, open or closed, to agree with the by currency table
    // on the same page. It used to count only closed trades, so a ledger with
    // capital still out reported a total smaller than the column beneath it.
    totalBorrowed: rows.reduce((sum, { d }) => sum + (d.borrowUsd ?? 0), 0),
    // The trades that total cannot include, because their borrow rate is not
    // known yet. Without it the tile read $10,000.00 over a tab that had also
    // borrowed EUR 15,000, with nothing to say the total was short; the Open
    // positions tile has carried a chip for exactly this case all along.
    totalBorrowedMissingFx: rows.filter(({ d }) => d.borrowUsd === null).length,
    interestPaid: valued.length > 0 ? interestPaid : null,
    currencyEffect: valued.length > 0 ? currencyEffect : null,
    feesPaid: withFees.length > 0 ? feesPaid : null,
    feesUnrecorded,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    wins,
    losses,
    avgHoldDays: holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : null,
    byCurrency,
    byMonth,
    best,
    worst,
    bestPct,
    worstPct,
  };
}
