/**
 * The trades as a CSV file, for the Export CSV button on Stats.
 *
 * Pure and synchronous like the module it builds on, and served to the browser
 * from /lib/csv.js exactly as Node imports it, so the export can be checked
 * from the command line against the same figures the page shows. It imports
 * calc.js rather than living in it: calc.js imports nothing, ever, and this is
 * presentation rather than arithmetic.
 *
 * Every figure comes from `derive`, the one source of truth for a trade, so a
 * row in the file says what the History table and the stage cards say.
 */
import { derive, reachedStages, statsYear, todayISO } from './calc.js';

/**
 * The columns, in order. Each reads the raw row `t`, its derived figures `d`,
 * and `has(stage)`, which says whether the trade has reached that stage.
 *
 * A stage the trade has not reached is left empty in every column, inputs
 * included. That is what the cards and the fee totals do: a gas fee left
 * behind on a purchase that was later undone is not money the trade spent, and
 * writing it here would put a figure in the file that no total includes.
 */
//
// The amounts and fees as printed, to the cent, like every figure derived
// from them: `derive` works from them as printed, so written as typed a fee of
// 1.005 sat in the file as 1,005 beside a fees_usd that counted it as 1.01,
// and the fee columns did not add up to fees_usd. The quantities and the
// rates stay as stored, in full: `derive` works from them unrounded, though
// the cards print a quantity to its asset's places.
//
// A swap's column is its whole cost, `*_swap_cost_usd`: the form's "Costs &
// Fees (swap)" is gas plus the DEX or aggregator's fee. Headed `*_swap_gas_usd`
// it read as gas alone, and summing it as gas counted every DEX fee too.
//
// The quantities are `buy_qty` / `sell_qty`, in units of the row's `asset`:
// headed `buy_eth`, a cbBTC row's 0.1 read as a tenth of an ETH.
// A gas fee, blank on a Solana platform's trade (`d.gasless`): no fee counts
// there, and a figure kept from before its platform changed would not add up
// to the fees_usd and net_gain beside it.
const gas = (d, v) => (d.gasless ? null : money(v));
// Their total, though, is a known $0 there, as Stats counts it
// (`summaryReport`'s `feesPaid`): left blank, the file said a Jupiter trade's
// fees were not known where the Stats card above the Export button said $0.00.
const feesTotal = (d) => money(d.gasless ? 0 : d.feesUsd);

const COLUMNS = [
  ['id', (t) => t.id],
  ['status', (t, d) => d.status],
  ['stats_year', (t, d, has, asOf) => statsYear({ ...t, derived: d }, asOf)],
  ['currency', (t) => t.borrow_currency],
  // The id, as stored; empty on a trade from before it was asked for.
  ['platform', (t) => t.platform],
  // What was bought, by id ('eth', 'cbbtc'); empty until something was, as the
  // purchase's other columns are - before then it is only where the picker starts.
  ['asset', (t, d, has) => (has('buy') ? d.asset : null)],
  // The wallet the trade names, as the Wallets tab names it, with its address
  // and chain: a name can be changed, and one address on two chains is two
  // wallets. Empty when it names none. Resolved by the caller (`walletOf`),
  // which holds the wallets; this file imports `calc.js` and nothing else.
  ['wallet', (t, d, has, asOf, w) => w?.name, 'text'],
  ['wallet_address', (t, d, has, asOf, w) => w?.address, 'text'],
  ['wallet_chain', (t, d, has, asOf, w) => w?.chain, 'text'],

  ['borrow_date', (t) => t.borrow_date],
  ['borrow_amount', (t) => money(t.borrow_amount)],
  ['borrow_apr_pct', (t) => t.borrow_apr],
  ['borrow_fx', (t, d) => d.fx.borrow.rate],
  ['borrow_usd', (t, d) => money(d.borrowUsd)],
  ['borrow_gas_usd', (t, d) => gas(d, t.borrow_gas_usd)],

  ['buy_date', (t, d, has) => (has('buy') ? t.buy_date : null)],
  ['buy_amount', (t, d, has) => (has('buy') ? money(t.buy_amount) : null)],
  ['buy_qty', (t, d, has) => (has('buy') ? t.buy_eth : null)],
  ['buy_fx', (t, d, has) => (has('buy') ? d.fx.buy.rate : null)],
  ['buy_price_usd', (t, d) => money(d.buyPriceUsd)],
  ['buy_swap_cost_usd', (t, d, has) => (has('buy') ? gas(d, t.buy_gas_usd) : null)],
  ['buy_lend_gas_usd', (t, d, has) => (has('buy') ? gas(d, t.buy_lend_gas_usd) : null)],

  ['sell_date', (t, d, has) => (has('sell') ? t.sell_date : null)],
  ['sell_amount', (t, d, has) => (has('sell') ? money(t.sell_amount) : null)],
  ['sell_qty', (t, d, has) => (has('sell') ? t.sell_eth : null)],
  ['sell_fx', (t, d, has) => (has('sell') ? d.fx.sell.rate : null)],
  ['sell_price_usd', (t, d) => money(d.sellPriceUsd)],
  ['sell_unstake_gas_usd', (t, d, has) => (has('sell') ? gas(d, t.sell_unstake_gas_usd) : null)],
  ['sell_swap_cost_usd', (t, d, has) => (has('sell') ? gas(d, t.sell_gas_usd) : null)],

  ['repay_date', (t, d, has) => (has('repay') ? t.repay_date : null)],
  ['repay_amount', (t, d, has) => (has('repay') ? money(t.repay_amount) : null)],
  ['repay_fx', (t, d, has) => (has('repay') ? d.fx.repay.rate : null)],
  ['repay_usd', (t, d) => money(d.repayUsd)],
  ['repay_gas_usd', (t, d, has) => (has('repay') ? gas(d, t.repay_gas_usd) : null)],

  ['days', (t, d) => d.days],
  ['interest_paid', (t, d) => money(d.interestPaid)],
  ['loan_cost_usd', (t, d) => money(d.loanCostUsd)],
  ['gross_gain', (t, d) => money(d.grossGain)],
  ['gross_gain_usd', (t, d) => money(d.grossGainUsd)],
  ['fees_usd', (t, d) => feesTotal(d)],
  ['fees_not_recorded', (t, d) => d.feesMissing.join(' ')],
  ['net_gain', (t, d) => money(d.netGain)],
  ['net_gain_usd', (t, d) => money(d.netGainUsd)],
  // A sale not yet repaid, with the interest accrued so far, at the trade's own
  // stored rates. Not the "est" in the History table any more: that one is
  // marked at today's ETH price and exchange rate, counts the ETH still held
  // after a partial sale, and covers held trades too - figures that change by
  // the minute and have no place in a file. On a dollar loan sold in full the
  // two agree. Its own column, because a projection filed under net gain would
  // be summed by whoever opens the file as if it were realized.
  ['net_gain_estimate_usd', (t, d) => money(d.projectedNetGainUsd)],
  ['annualized_pct', (t, d) => percent(d.pct)],
  ['notes', (t) => t.notes, 'text'],
];

/**
 * Two decimals, as every money figure is printed. Unrounded, a net gain that
 * is exactly flat to the cent wrote -1.0915712778114537e-12. Null stays null:
 * a figure nobody measured is an empty cell, never 0.
 */
function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Rounded by the same call the page prints with, so the two cannot differ.
  // Math.round took -x.5 up - a net gain the page prints as -$1.38 written
  // -1,37 - and multiplying by 100 first rounded 1.005 to 1.00 where the page
  // prints $1.01. The magnitude, then the sign, as the page does it.
  const abs = Number(
    Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }),
  );
  return abs === 0 ? 0 : Math.sign(v) * abs;
}

/** A rate in percent, rounded as the page's `pct` prints it (`toFixed`). */
function percent(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const abs = Number(Math.abs(v).toFixed(2));
  return abs === 0 ? 0 : Math.sign(v) * abs;
}

/**
 * Laid out for Excel in a European locale, which is what opens this file: a
 * semicolon between fields and a comma for the decimal point. That pair is
 * what such an Excel reads on a double click. A comma-separated file opened
 * as one column, and splitting on semicolons alone is worse, because the same
 * Excel takes a point as a thousands separator and read a rate of 1.1862 as
 * 11,862.
 */
const SEPARATOR = ';';

/**
 * One cell. RFC 4180 with the separator above: a field holding a semicolon, a
 * quote or a line break is quoted, with its quotes doubled. A number gets a
 * decimal comma, and is never quoted, so it stays a number in the sheet.
 *
 * A text field that a spreadsheet would read as a formula is defused with a
 * leading apostrophe: a note typed as "=HYPERLINK(...)" is a formula the
 * moment the file is opened. Only text columns, because a negative gain is a
 * number and must stay one.
 */
function cell(value, kind) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return plain(value).replace('.', ',');
  let s = String(value);
  if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A number in plain digits. `String()` writes anything under 0.000001 in
 * exponent form, so 0.00000015 cbBTC went out as "1.5e-7", which a spreadsheet
 * reads as text rather than a quantity. These are the same digits `String()`
 * gives - the shortest that reads back as the same number - with the point
 * moved instead of an exponent.
 */
export function plain(n) {
  const s = String(n);
  const m = s.match(/^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/);
  if (!m) return s;
  const [, sign, lead, frac = '', expText] = m;
  const digits = lead + frac;
  const exp = Number(expText);
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const point = exp + 1;
  return digits.length <= point
    ? `${sign}${digits}${'0'.repeat(point - digits.length)}`
    : `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * The CSV text for these trades, oldest borrow first.
 *
 * Starts with a byte order mark, so Excel reads it as UTF-8 and an accented
 * note survives, and ends lines with CRLF as RFC 4180 has it.
 */
export function tradesCsv(trades, asOf = todayISO(), walletOf = () => null) {
  const rows = [...trades]
    .sort((a, b) =>
      a.borrow_date < b.borrow_date ? -1 : a.borrow_date > b.borrow_date ? 1 : a.id - b.id,
    )
    .map((t) => {
      const d = derive(t, asOf);
      const reached = new Set(reachedStages(d.stages));
      const has = (stage) => reached.has(stage);
      const w = t.wallet_id == null ? null : walletOf(t.wallet_id);
      return COLUMNS.map(([, read, kind]) => cell(read(t, d, has, asOf, w), kind)).join(SEPARATOR);
    });
  const header = COLUMNS.map(([name]) => name).join(SEPARATOR);
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

/** The file name for a year tab: eth-roundtrip-trades-2026.csv, or -all. */
export function csvFileName(year) {
  return `eth-roundtrip-trades-${/^\d{4}$/.test(String(year)) ? year : 'all'}.csv`;
}
