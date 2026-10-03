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
const COLUMNS = [
  ['id', (t) => t.id],
  ['status', (t, d) => d.status],
  ['stats_year', (t, d, has, asOf) => statsYear({ ...t, derived: d }, asOf)],
  ['currency', (t) => t.borrow_currency],

  ['borrow_date', (t) => t.borrow_date],
  ['borrow_amount', (t) => t.borrow_amount],
  ['borrow_apr_pct', (t) => t.borrow_apr],
  ['borrow_fx', (t, d) => d.fx.borrow.rate],
  ['borrow_usd', (t, d) => money(d.borrowUsd)],
  ['borrow_gas_usd', (t) => t.borrow_gas_usd],

  ['buy_date', (t, d, has) => (has('buy') ? t.buy_date : null)],
  ['buy_amount', (t, d, has) => (has('buy') ? t.buy_amount : null)],
  ['buy_eth', (t, d, has) => (has('buy') ? t.buy_eth : null)],
  ['buy_fx', (t, d, has) => (has('buy') ? d.fx.buy.rate : null)],
  ['buy_price_usd', (t, d) => money(d.buyPriceUsd)],
  ['buy_swap_gas_usd', (t, d, has) => (has('buy') ? t.buy_gas_usd : null)],
  ['buy_lend_gas_usd', (t, d, has) => (has('buy') ? t.buy_lend_gas_usd : null)],

  ['sell_date', (t, d, has) => (has('sell') ? t.sell_date : null)],
  ['sell_amount', (t, d, has) => (has('sell') ? t.sell_amount : null)],
  ['sell_eth', (t, d, has) => (has('sell') ? t.sell_eth : null)],
  ['sell_fx', (t, d, has) => (has('sell') ? d.fx.sell.rate : null)],
  ['sell_price_usd', (t, d) => money(d.sellPriceUsd)],
  ['sell_unstake_gas_usd', (t, d, has) => (has('sell') ? t.sell_unstake_gas_usd : null)],
  ['sell_swap_gas_usd', (t, d, has) => (has('sell') ? t.sell_gas_usd : null)],

  ['repay_date', (t, d, has) => (has('repay') ? t.repay_date : null)],
  ['repay_amount', (t, d, has) => (has('repay') ? t.repay_amount : null)],
  ['repay_fx', (t, d, has) => (has('repay') ? d.fx.repay.rate : null)],
  ['repay_usd', (t, d) => money(d.repayUsd)],
  ['repay_gas_usd', (t, d, has) => (has('repay') ? t.repay_gas_usd : null)],

  ['days', (t, d) => d.days],
  ['interest_paid', (t, d) => money(d.interestPaid)],
  ['loan_cost_usd', (t, d) => money(d.loanCostUsd)],
  ['gross_gain', (t, d) => money(d.grossGain)],
  ['gross_gain_usd', (t, d) => money(d.grossGainUsd)],
  ['fees_usd', (t, d) => money(d.feesUsd)],
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
  ['annualized_pct', (t, d) => money(d.pct)],
  ['notes', (t) => t.notes, 'text'],
];

/**
 * Two decimals, as every money figure is printed. Unrounded, a net gain that
 * is exactly flat to the cent wrote -1.0915712778114537e-12. Null stays null:
 * a figure nobody measured is an empty cell, never 0.
 */
function money(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const r = Math.round(v * 100) / 100;
  // Math.round(-0.4) is -0, which String() prints as "0" anyway, but say it.
  return Object.is(r, -0) ? 0 : r;
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
  if (typeof value === 'number') return String(value).replace('.', ',');
  let s = String(value);
  if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The CSV text for these trades, oldest borrow first.
 *
 * Starts with a byte order mark, so Excel reads it as UTF-8 and an accented
 * note survives, and ends lines with CRLF as RFC 4180 has it.
 */
export function tradesCsv(trades, asOf = todayISO()) {
  const rows = [...trades]
    .sort((a, b) =>
      a.borrow_date < b.borrow_date ? -1 : a.borrow_date > b.borrow_date ? 1 : a.id - b.id,
    )
    .map((t) => {
      const d = derive(t, asOf);
      const reached = new Set(reachedStages(d.stages));
      const has = (stage) => reached.has(stage);
      return COLUMNS.map(([, read, kind]) => cell(read(t, d, has, asOf), kind)).join(SEPARATOR);
    });
  const header = COLUMNS.map(([name]) => name).join(SEPARATOR);
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

/** The file name for a year tab: aave-loop-trades-2026.csv, or -all. */
export function csvFileName(year) {
  return `aave-loop-trades-${/^\d{4}$/.test(String(year)) ? year : 'all'}.csv`;
}
