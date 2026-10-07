#!/usr/bin/env node
/**
 * Checks for the arithmetic in lib/calc.js. `npm run check`.
 *
 * Not a test framework: the repo has no dependencies for one and this needs
 * none. Every trade is built here, never read from a database, and every figure
 * is derived on a fixed day, so the answer is the same on any machine on any
 * date. Expected values are worked out by hand from the inputs, not by calling
 * the function under test a second time - a check that recomputes the code's
 * own formula agrees with any bug in it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  derive,
  unrealisedUsd,
  estimatedGainUsd,
  estimatedGainPct,
  hasEstimate,
  estimateNeedsPrice,
  openGainsUsd,
  parseAmount,
  summaryReport,
  derivedOn,
  intervalMs,
  parseDate,
  isProvisionalFx,
  accruedInterest,
  annualizedPct,
  stages,
  statsYear,
  statsYears,
  summarize,
} from '../lib/calc.js';
import { tradesCsv, csvFileName } from '../lib/csv.js';

const AS_OF = '2026-10-01';
const PRICE = 3450;
// 30,000 at 4% a year for the 30 days from 1 September to 1 October, simple
// interest on a 365 day year.
const INTEREST = (30000 * 0.04 * 30) / 365;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err.message.split('\n').join('\n  ')}`);
    process.exitCode = 1;
  }
}
const near = (actual, expected, what) =>
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6,
    `${what}: expected ${expected}, got ${actual}`,
  );

/* ------------------------------------------------------------------ trades */

// Borrowed 30,000, all of it spent on 10 ETH at 3,000, $3 + $5 of gas so far.
const held = (over = {}) => ({
  id: 1,
  borrow_date: '2026-09-01',
  borrow_amount: 30000,
  borrow_currency: 'USDT',
  borrow_apr: 4,
  borrow_gas_usd: 3,
  buy_date: '2026-09-01',
  buy_amount: 30000,
  buy_eth: 10,
  buy_gas_usd: 5,
  ...over,
});
// The same, sold in full for 33,000 on 20 September with $4 of gas.
const sold = (over = {}) =>
  held({ sell_date: '2026-09-20', sell_amount: 33000, sell_eth: 10, sell_gas_usd: 4, ...over });
// Repaid on 1 October for principal plus the interest.
const closed = (over = {}) =>
  sold({ repay_date: '2026-10-01', repay_amount: 30000 + INTEREST, repay_gas_usd: 0, ...over });
const eur = (rate) => ({ borrow_currency: 'EURC', borrow_fx: rate, buy_fx: rate, sell_fx: rate, repay_fx: rate });

const est = (t, price = PRICE, fxNow = {}) => estimatedGainUsd(t, derive(t, AS_OF), price, fxNow);

/* -------------------------------------------------------------- the module */

check('lib/calc.js imports nothing, so it still runs in the browser', () => {
  const src = readFileSync(new URL('../lib/calc.js', import.meta.url), 'utf8');
  // Static imports, re-exports and dynamic imports alike.
  assert.doesNotMatch(src, /^\s*import[\s{*'"]/m);
  assert.doesNotMatch(src, /^\s*export\s[^;]*\sfrom\s/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

/* ---------------------------------------------------------- held positions */

check('held dollar loan: ETH at today\'s price less cost, interest and gas', () => {
  near(est(held()), 10 * PRICE - 30000 - INTEREST - 8, 'estimate');
});

check('held dollar loan agrees with unrealisedUsd, which Telegram alerts use', () => {
  const t = held();
  near(est(t), unrealisedUsd(derive(t, AS_OF), PRICE), 'estimate');
});

check('held euro loan: gain % is the return on the 30,000 EURC spent, at today\'s rate both sides', () => {
  // 30,000 EURC bought at 1.05, EURC at 1.17 today: the gain at today's rate
  // over the 30,000 EURC at today's rate too, so -2.06%, not over $31,500.
  const t = held(eur(1.05));
  const gain = 10 * PRICE - (30000 + INTEREST) * 1.17 - 8;
  near(estimatedGainPct(t, derive(t, AS_OF), PRICE, { EURC: 1.17 }), (gain / (30000 * 1.17)) * 100, 'pct');
});

check('a sale within 0.01% of the purchase is a full exit, its whole cost taken off', () => {
  // 9.9995 of 10 ETH sold for 33,000 and 30,000 repaid, fees 0: the card shows
  // a full exit, so 33,000 - 30,000 = 3,000, not 33,000 - 29,998.50.
  const t = { ...held({ borrow_apr: 0, borrow_gas_usd: 0, buy_gas_usd: 0 }), sell_date: '2026-09-20',
    sell_amount: 33000, sell_eth: 9.9995, sell_gas_usd: 0, repay_date: '2026-09-20', repay_amount: 30000, repay_gas_usd: 0 };
  const d = derive(t, AS_OF);
  assert.equal(d.isPartialSale, false);
  near(d.netGainUsd, 3000, 'net gain');
});

check('held dollar loan: gain % is over the 30,000 spent on the ETH', () => {
  const t = held();
  near(estimatedGainPct(t, derive(t, AS_OF), PRICE), ((34500 - 30000 - INTEREST - 8) / 30000) * 100, 'pct');
});

check('a loan with nothing bought has no gain %', () => {
  const t = { ...held(), buy_date: null, buy_amount: null, buy_eth: null, buy_gas_usd: null };
  assert.equal(estimatedGainPct(t, derive(t, AS_OF), PRICE), null);
});

check('held dollar loan ignores any rate it is handed', () => {
  near(est(held(), PRICE, { USDT: 2 }), 10 * PRICE - 30000 - INTEREST - 8, 'estimate');
});

check('held euro loan is marked at today\'s rate, not the purchase rate', () => {
  near(est(held(eur(1.05)), PRICE, { EURC: 1.17 }), 10 * PRICE - (30000 + INTEREST) * 1.17 - 8, 'estimate');
});

check('held euro loan falls back to its stored rates without today\'s', () => {
  near(est(held(eur(1.05))), 10 * PRICE - 30000 * 1.05 - INTEREST * 1.05 - 8, 'estimate');
});

check('held euro loan saved before any rate is converted at today\'s', () => {
  near(est(held(eur(null)), PRICE, { EURC: 1.1225 }), 10 * PRICE - (30000 + INTEREST) * 1.1225 - 8, 'estimate');
});

check('held euro loan with no rate at all has no estimate, not a zero', () => {
  assert.equal(est(held(eur(null))), null);
});

check('held position with no ETH price has no estimate', () => {
  assert.equal(est(held(), null), null);
});

/* ------------------------------------------------------- sold, not repaid */

check('sold in full: the projection, whatever ETH does now', () => {
  const expected = 33000 - 30000 - INTEREST - 12;
  near(est(sold()), expected, 'at a price');
  near(est(sold(), null), expected, 'with no price');
});

check('sold in full agrees with the CSV\'s projectedNetGainUsd', () => {
  const t = sold();
  near(est(t), derive(t, AS_OF).projectedNetGainUsd, 'estimate');
});

check('partial sale counts the ETH still held at today\'s price', () => {
  // 6 of 10 ETH sold for 21,000: the gain on those, plus 4 ETH at today's
  // price less the 12,000 they cost.
  const t = sold({ sell_amount: 21000, sell_eth: 6 });
  near(est(t), 21000 - 18000 - INTEREST - 12 + (4 * PRICE - 12000), 'estimate');
});

check('partial sale needs the ETH price, a full one does not', () => {
  const part = sold({ sell_amount: 21000, sell_eth: 6 });
  assert.equal(est(part, null), null);
  assert.equal(estimateNeedsPrice(derive(part, AS_OF)), true);
  assert.equal(estimateNeedsPrice(derive(sold(), AS_OF)), false);
});

check('partial euro sale is marked at today\'s rate, like a held one', () => {
  const t = sold({ ...eur(1.1), sell_amount: 21000, sell_eth: 6 });
  const expected = (21000 - 18000 - INTEREST) * 1.2 - 12 + (4 * PRICE - 12000 * 1.2);
  near(est(t, PRICE, { EURC: 1.2 }), expected, 'estimate');
});

check('partial euro sale falls back to its stored rates without today\'s', () => {
  const t = sold({ ...eur(1.1), sell_amount: 21000, sell_eth: 6 });
  const expected = (21000 - 18000) * 1.1 - INTEREST * 1.1 - 12 + (4 * PRICE - 12000 * 1.1);
  near(est(t, PRICE), expected, 'estimate');
});

check('selling a sliver of a euro position moves its estimate by the sliver only', () => {
  // 0.01 ETH sold at today's price, no gas on the sale: closing today should
  // come to the same thing either way. At 1.15 the sliver's $34.50 is exactly
  // 30.00 EURC, a figure a card can print; at 1.17 it was 29.487179..., which
  // the Sold card shows as 29.49.
  const fx = { EURC: 1.15 };
  const before = est(held(eur(1.05)), PRICE, fx);
  const after = est(sold({ ...eur(1.05), sell_amount: 30, sell_eth: 0.01, sell_gas_usd: 0 }), PRICE, fx);
  near(before, 10 * PRICE - (30000 + INTEREST) * 1.15 - 8, 'held');
  near(after, before, 'after the sliver');
});

check('euro sale saved before any rate is converted at today\'s', () => {
  near(est(sold(eur(null)), PRICE, { EURC: 1.2 }), (33000 - 30000 - INTEREST) * 1.2 - 12, 'estimate');
});

check('euro partial sale with no stored rate: the ETH kept costs today\'s rate too', () => {
  const t = sold({ ...eur(null), sell_amount: 21000, sell_eth: 6 });
  const expected = (21000 - 18000 - INTEREST) * 1.2 - 12 + (4 * PRICE - 12000 * 1.2);
  near(est(t, PRICE, { EURC: 1.2 }), expected, 'estimate');
});

/* ------------------------------------------------- nothing to estimate */

check('a closed trade has its result, not an estimate', () => {
  const d = derive(closed(), AS_OF);
  assert.equal(hasEstimate(d), false);
  assert.equal(estimatedGainUsd(closed(), d, PRICE, {}), null);
  // Repaid 30,098.630137..., which the Repaid card prints 30,098.63: the result
  // is what the card adds up to, 33,000 - 30,098.63 - 12.
  near(d.netGainUsd, 2889.37, 'net gain');
});

check('a closed partial sale is the gain on the ETH sold, nothing more', () => {
  const t = closed({ sell_amount: 21000, sell_eth: 6 });
  const d = derive(t, AS_OF);
  near(d.netGainUsd, 21000 - 18000 - 98.63 - 12, 'net gain'); // interest as printed
  // In the coin too, which is what a dollar coin's Sold card prints: 6 of the
  // 10 ETH bought for 30,000 cost 18,000.
  assert.equal(d.costOfSoldEth, 18000);
  assert.equal(d.grossGain, 3000);
});

check('a loan with nothing bought holds no position to value', () => {
  const t = { id: 9, borrow_date: '2026-09-01', borrow_amount: 30000, borrow_currency: 'USDT', borrow_apr: 4, borrow_gas_usd: 3 };
  assert.equal(hasEstimate(derive(t, AS_OF)), false);
});

/* ------------------------------------------------------------ the header */

check('openGainsUsd sums the open positions and skips the rest', () => {
  const g = openGainsUsd([closed({ id: 3 }), sold({ id: 2 }), held({ id: 1 })], PRICE, {}, AS_OF);
  assert.deepEqual(g.rows.map((r) => r.id), [1, 2]);
  // The lines as printed: 34,500 - 30,000 - 98.6301 - 8 = 4,393.37 held, and
  // 33,000 - 30,000 - 98.6301 - 12 = 2,889.37 sold. The total is their sum.
  near(g.total, 4393.37 + 2889.37, 'total');
  assert.equal(g.missing, 0);
});

check('openGainsUsd: no ETH price, no total, rather than the sold ones alone', () => {
  const g = openGainsUsd([held({ id: 1 }), sold({ id: 2 })], null, {}, AS_OF);
  assert.equal(g.total, null);
  assert.equal(g.missing, 1);
});

check('openGainsUsd: no ETH price is fine when nothing depends on it', () => {
  const g = openGainsUsd([sold({ id: 2 })], null, {}, AS_OF);
  near(g.total, 2889.37, 'total'); // 33,000 - 30,000 - 98.6301 - 12, to the cent
});

check('openGainsUsd: an unknown position is missing, never a zero', () => {
  const g = openGainsUsd([held({ id: 1 }), held({ id: 2, ...eur(null) })], PRICE, {}, AS_OF);
  near(g.total, 4393.37, 'total'); // 34,500 - 30,000 - 98.6301 - 8, to the cent
  assert.equal(g.missing, 1);
});

/* ------------------------------------------------------- typed amounts */

check('amounts in either convention, including three decimals', () => {
  const cases = {
    '1.234,567': 1234.567, '26.810,928': 26810.928, '1.234,5678': 1234.5678,
    '32.000,00': 32000, '12,345.67': 12345.67, '1.234.567,89': 1234567.89,
    '12,000': 12000, '0,125': 0.125, '8,0773': 8.0773, '$1.234,56': 1234.56,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(parseAmount(text), want, text);
});

check('malformed grouping is refused, not read as some other number', () => {
  for (const text of ['1,5.3', '12,34.56', '1,25.50', '1.2.3,4']) assert.equal(parseAmount(text), null, text);
});

/* ---------------------------------------------- rounding as printed */

// A dollar loan flat but for its gas, so the net gain is minus the gas.
const flat = (gas) => ({
  id: 7, borrow_date: '2026-09-01', borrow_amount: 10000, borrow_currency: 'USDC', borrow_apr: 0,
  borrow_gas_usd: 0, buy_date: '2026-09-02', buy_amount: 10000, buy_eth: 3, buy_gas_usd: gas,
  sell_date: '2026-09-03', sell_amount: 10000, sell_eth: 3, sell_gas_usd: 0,
  repay_date: '2026-09-04', repay_amount: 10000, repay_gas_usd: 0, created_at: '2026-09-01T00:00:00Z',
});

check('the CSV rounds a half cent away from zero, as the page prints it', () => {
  const [head, row] = tradesCsv([flat(1.375)]).trim().split(/\r?\n/).map((l) => l.split(';'));
  assert.equal(row[head.indexOf('net_gain_usd')], '-1,38');
  assert.equal(row[head.indexOf('fees_usd')], '1,38');
});

check('the CSV rounds 1.005 to 1.01, as the page prints it', () => {
  // Multiplying by 100 first lands on 100.49999999999999 and rounds down.
  const [head, row] = tradesCsv([flat(1.005)]).trim().split(/\r?\n/).map((l) => l.split(';'));
  assert.equal(row[head.indexOf('fees_usd')], '1,01');
  assert.equal(row[head.indexOf('net_gain_usd')], '-1,01');
});

check('the CSV defuses a note a spreadsheet would run as a formula', () => {
  const [head, row] = tradesCsv([{ ...flat(1), notes: '=1+1' }]).trim().split(/\r?\n/).map((l) => l.split(';'));
  assert.equal(row[head.indexOf('notes')], "'=1+1");
  assert.equal(row[head.indexOf('net_gain_usd')], '-1', 'a negative figure stays a number');
});

check('the blended rate weighs each trade by its loan and its days', () => {
  // $50 on 10,000 over 1 day (182.5% annualized) and $900 on 30,000 over 90
  // days (12.17%). Blended is all the gain over all the capital-days:
  // 950 * 36500 / (10,000 * 1 + 30,000 * 90) = 12.7952%. Unweighted it would
  // read 97.33%, weighted by size alone 54.75%.
  const usdc = (id, from, to, loan, gain) => ({
    id, borrow_currency: 'USDC', borrow_date: from, borrow_amount: loan, borrow_apr: 0, borrow_gas_usd: 0,
    buy_date: from, buy_amount: loan, buy_eth: 4, buy_gas_usd: 0, sell_date: to, sell_amount: loan + gain,
    sell_eth: 4, sell_gas_usd: 0, repay_date: to, repay_amount: loan, repay_gas_usd: 0,
  });
  const r = summaryReport([usdc(1, '2026-09-01', '2026-09-02', 10000, 50), usdc(2, '2026-06-01', '2026-08-30', 30000, 900)], AS_OF);
  near(r.avgPct, (950 * 36500) / 2710000, 'blended');
});

// The file as Excel will read it: rows split on CRLF, cells on the semicolon.
const csvRows = (trades, asOf = AS_OF) => {
  const text = tradesCsv(trades, asOf);
  const [head, ...rows] = text.replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => l.split(';'));
  return { text, head, rows, at: (row, k) => row[head.indexOf(k)] };
};

check('the CSV is UTF-8 with a byte order mark, CRLF lines, oldest borrow first', () => {
  const later = { ...flat(1), id: 8, borrow_date: '2026-09-01' };
  const earlier = { ...flat(1), id: 9, borrow_date: '2026-08-01' };
  const { text, rows, at } = csvRows([later, earlier]);
  assert.ok(text.startsWith('﻿'));
  assert.equal(text.split('\r\n').length, 4, 'header, two rows, and a final CRLF');
  assert.deepEqual(rows.map((r) => at(r, 'id')), ['9', '8']);
});

check('the CSV leaves an unknown figure and an unreached stage empty, never 0', () => {
  // Borrowed only, with a swap fee left behind on the purchase it never made.
  const t = { id: 3, borrow_date: '2026-09-01', borrow_amount: 1000, borrow_currency: 'USDC', borrow_apr: 4, borrow_gas_usd: 0, buy_gas_usd: 5 };
  const { rows, at } = csvRows([t]);
  for (const k of ['net_gain_usd', 'buy_date', 'buy_swap_gas_usd', 'annualized_pct']) assert.equal(at(rows[0], k), '', k);
  assert.equal(at(rows[0], 'borrow_gas_usd'), '0', 'a recorded 0 is a 0');
});

check('the CSV quotes a note holding a semicolon or a quote', () => {
  const { text } = csvRows([{ ...flat(1), notes: 'a; "b"' }]);
  assert.ok(text.includes(';"a; ""b"""\r\n'));
});

check('the CSV keeps an estimate out of net_gain_usd and rounds the rate as the page does', () => {
  // Sold, not repaid: no result yet, only the projection.
  const open = { ...flat(1), repay_date: null, repay_amount: null, repay_gas_usd: null };
  const { rows, at } = csvRows([open]);
  assert.equal(at(rows[0], 'net_gain_usd'), '');
  assert.notEqual(at(rows[0], 'net_gain_estimate_usd'), '');
  // Closed: -1 on 10,000 over 3 days is -1.2167% annualized, printed -1.22%.
  const closed1 = csvRows([flat(1)]);
  assert.equal(closed1.at(closed1.rows[0], 'annualized_pct'), '-1,22');
});

check('the CSV files a trade by the year it was repaid, and names the file by year', () => {
  const across = { ...flat(1), borrow_date: '2025-12-30', buy_date: '2025-12-30', sell_date: '2026-01-02', repay_date: '2026-01-02' };
  const { rows, at } = csvRows([across]);
  assert.equal(at(rows[0], 'stats_year'), '2026');
  assert.equal(csvFileName('2026'), 'aave-loop-trades-2026.csv');
  assert.equal(csvFileName('all'), 'aave-loop-trades-all.csv');
  assert.equal(csvFileName('../x'), 'aave-loop-trades-all.csv');
});

check('the CSV\'s gas columns add up to its fees_usd', () => {
  // Two fees typed as 1.005, which the cards print $1.01 each and fees_usd
  // counts as 2.02. Written as typed, the columns read 1,005 and 1,005.
  const t = { ...flat(1.005), borrow_gas_usd: 1.005 };
  const [head, row] = tradesCsv([t]).trim().split(/\r?\n/).map((l) => l.split(';'));
  assert.equal(row[head.indexOf('borrow_gas_usd')], '1,01');
  assert.equal(row[head.indexOf('fees_usd')], '2,02');
});

check('a timer interval from the environment stays where a timer can use it', () => {
  assert.equal(intervalMs(undefined, 3600000), 3600000);
  assert.equal(intervalMs('abc', 3600000), 3600000);
  assert.equal(intervalMs('-5', 3600000), 3600000);
  assert.equal(intervalMs('2000', 3600000), 2000);
  // Above 2^31 - 1 Node fires every millisecond instead.
  assert.equal(intervalMs('99999999999', 3600000), 2147483647);
});

/* ------------------------------------------------- totals add up as printed */

// A dollar trade that nets 99.004: 1,100 for the ETH that cost 1,000, less a
// swap fee of 0.996 (fees take three decimals). It prints $99.00.
const cent = (id, month, over = {}) => ({
  id, borrow_currency: 'USDT', borrow_date: `2026-${month}-01`, borrow_amount: 1000, borrow_apr: 0, borrow_gas_usd: 0,
  buy_date: `2026-${month}-01`, buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0.996,
  sell_date: `2026-${month}-02`, sell_amount: 1100, sell_eth: 1, sell_gas_usd: 0,
  repay_date: `2026-${month}-02`, repay_amount: 1000, repay_gas_usd: 0, ...over,
});

check('every money total is the sum of its lines as printed', () => {
  // Three trades of $99.00 each, in three months. The total of the raw
  // figures, 297.012, printed $297.01 over three lines of $99.00.
  const r = summaryReport([cent(1, '03'), cent(2, '04'), cent(3, '05')], AS_OF);
  assert.deepEqual(r.byMonth.map((m) => m.netGain), [99, 99, 99]);
  assert.equal(r.byCurrency[0].netGain, 297);
  assert.equal(r.netGain, 297);
  assert.equal(r.feesPaid, 3, 'three fees of 0.996, each printed $1.00');
});

check('a half cent is a cent in a total, as the page prints it', () => {
  // A fee of 1.005 prints $1.01; multiplying by 100 first rounded it to 1.00.
  const r = summaryReport([cent(1, '03', { buy_gas_usd: 1.005 }), cent(2, '04', { buy_gas_usd: 1.005 })], AS_OF);
  assert.equal(r.feesPaid, 2.02);
  // Each card: Gross +100.00, less the fee it prints, $1.01, is $98.99. Taking
  // off the raw 1.005 left 98.995, printed $99.00 under lines adding to 98.99.
  assert.equal(r.netGain, 197.98);
});

check('the header\'s estimate is the sum of the positions under it', () => {
  // Held 1 ETH bought for 1,000 at 0%, fee 0.996, ETH at 1,100: 99.004 each.
  const held1 = (id) => ({ ...cent(id, '09'), sell_date: null, sell_amount: null, sell_eth: null, repay_date: null, repay_amount: null });
  const g = openGainsUsd([held1(1), held1(2)], 1100, {}, AS_OF);
  assert.equal(g.total, 198);
});

check('a loss that prints as -$0.01 is counted as a loss', () => {
  const r = summaryReport([flat(0.005)], AS_OF);
  assert.equal(r.losses, 1);
  assert.equal(r.wins, 0);
});

check('a trade dated after today is derived on its own day', () => {
  assert.equal(derivedOn(held({ borrow_date: '2026-10-02', buy_date: '2026-10-02' }), AS_OF), '2026-10-02');
  assert.equal(derivedOn(held(), AS_OF), AS_OF);
});

/* ------------------------------------------- production's script policy */

// The hashes production's nginx Content Security Policy admits, one per inline
// script on the public pages. Editing a script changes its hash and the browser
// then blocks it - silently, in production only. That is how the 1.3.5 theme
// fix shipped and never ran. If a check below fails on purpose, the new hash
// has to go into nginx's Content-Security-Policy line too, and then here.
const CSP_PINNED = [
  'sha256-idlxi/vmZQzRC4UbiGOUSbMaK2QEuIqX4WVbMpag3Bk=',
  'sha256-4gctYiGTReoQs9WljWvM7zE5fYNvf1ArhhVsTPQedWU=',
  'sha256-0khB/vQfDtt4wssJcCymFCpQnpQAFWWDyDOe2sacm6I=',
];

const inlineScriptHashes = (file) => {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`,
  );
};

check('the landing pages\' inline scripts are the ones nginx admits', () => {
  for (const file of ['landing/index.html', 'landing/404.html']) {
    for (const h of inlineScriptHashes(file)) assert.ok(CSP_PINNED.includes(h), `${file}: ${h} is not in nginx's CSP`);
  }
});

check('the ledger page has no inline script for the CSP to block', () => {
  assert.deepEqual(inlineScriptHashes('public/index.html'), []);
});

/* ----------------------------------------------- dates, spans and stages */

check('an impossible date is not a date', () => {
  assert.equal(parseDate('2026-02-31'), null);
  assert.equal(parseDate('2026-02-28'), Date.UTC(2026, 1, 28));
});

check('a stand-in rate is asked about again only while its day is recent', () => {
  // A Saturday trade on Friday's rate, asked about the Monday after: still
  // replaceable. Eleven days on, the rate it has is the rate.
  assert.equal(isProvisionalFx('2026-09-19', '2026-09-18', '2026-09-21'), true);
  assert.equal(isProvisionalFx('2026-09-19', '2026-09-18', '2026-09-30'), false);
  assert.equal(isProvisionalFx('2026-09-19', '2026-09-19', '2026-09-20'), false, 'its own day\'s rate');
});

check('a backwards span has no interest and no rate; a same-day one counts as a day', () => {
  assert.equal(accruedInterest(1000, 4, -1), null);
  assert.equal(annualizedPct(10, 1000, -1), null);
  // 10 on 1,000 in a day: 1% a day, 365% a year.
  near(annualizedPct(10, 1000, 0), 365, 'same day');
});

check('a stage with an amount of 0 is not filled in', () => {
  assert.equal(stages(held({ buy_amount: 0 })).bought, false);
  assert.equal(stages(held()).bought, true);
});

check('selling more ETH than was bought leaves none held, not a negative', () => {
  // Aave's interest: 10.5 ETH sold of 10 bought.
  assert.equal(derive(sold({ sell_eth: 10.5 }), AS_OF).retainedEth, 0);
});

check('an unrecorded fee is not a free one, and a blank Aave fee is not unrecorded', () => {
  const none = derive(held({ borrow_gas_usd: null, buy_gas_usd: null }), AS_OF);
  assert.equal(none.feesUsd, null);
  assert.deepEqual(none.feesMissing, ['borrow', 'buy']);
  // The swap fee is there and the lend fee left blank: nothing is missing.
  assert.deepEqual(derive(held({ buy_lend_gas_usd: null }), AS_OF).feesMissing, []);
});

/* ---------------------------------------------------------- the year tabs */

check('an open trade counts in the current year, and the tabs run newest first', () => {
  const open = held({ id: 1, borrow_date: '2025-12-01', buy_date: '2025-12-01' });
  assert.equal(statsYear(open, AS_OF), '2026');
  const old = closed({ id: 2, borrow_date: '2024-03-01', buy_date: '2024-03-01', sell_date: '2024-03-05', repay_date: '2024-03-06' });
  assert.deepEqual(statsYears([old, open], AS_OF), ['2026', '2024']);
});

/* --------------------------------------------------------------- Stats */

// A dollar trade closed on `to`: 1,000 on 1 ETH, sold for 1,000 + gain.
const shut = (id, to, gain, over = {}) => ({
  id, borrow_currency: 'USDC', borrow_date: '2026-03-01', borrow_amount: 1000, borrow_apr: 0, borrow_gas_usd: 0,
  buy_date: '2026-03-01', buy_amount: 1000, buy_eth: 1, buy_gas_usd: 0, sell_date: to, sell_amount: 1000 + gain,
  sell_eth: 1, sell_gas_usd: 0, repay_date: to, repay_amount: 1000, repay_gas_usd: 0, ...over,
});

check('Stats: months run newest first, and a flat trade is neither won nor lost', () => {
  const r = summaryReport([shut(1, '2026-03-11', 50), shut(2, '2026-05-11', 0)], AS_OF);
  assert.deepEqual(r.byMonth.map((m) => m.label), ['May 2026', 'Mar 2026']);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 0);
});

check('Stats: Total borrowed counts open trades; Average hold only closed ones with a result', () => {
  // Closed in 10 days, a 2,000 loan still open, and a closed euro trade with
  // no rate held 30 days, which has no dollar result to average.
  const open = { id: 3, borrow_currency: 'USDC', borrow_date: '2026-09-01', borrow_amount: 2000, borrow_apr: 0 };
  const rateless = shut(4, '2026-03-31', 10, { borrow_currency: 'EURC' });
  const r = summaryReport([shut(1, '2026-03-11', 50), open, rateless], AS_OF);
  assert.equal(r.totalBorrowed, 3000, '1,000 closed + 2,000 open; the euro trade has no rate');
  assert.equal(r.avgHoldDays, 10);
});

check('Stats: a closed trade whose rate cannot be worked out is not ranked by rate', () => {
  // Dated backwards, so annualizedPct answers null. Compared as a number it
  // sat below every positive rate and took "smallest".
  const odd = shut(2, '2026-02-20', 5);
  const r = summaryReport([shut(1, '2026-03-11', 50), odd], AS_OF);
  assert.equal(r.worstPct.id, 1);
});

check('Stats: open capital is what has not been repaid', () => {
  // Repaid without a sale - the server refuses it, the maths must not count
  // it as capital still out either way.
  const repaidUnsold = held({ id: 5, repay_date: '2026-09-10', repay_amount: 30000 });
  assert.equal(summarize([repaidUnsold], AS_OF).deployed, null);
});

check('a euro loan cost splits into interest and currency rows that add up to it', () => {
  // Several fractional cases: the two rows as printed always sum to the cost.
  for (const [b, r, bf, rf] of [[30000.55, 30123.99, 1.1234, 1.1412], [9999.99, 10055.5, 1.0507, 1.0731], [12345.67, 12400.01, 1.1789, 1.0923]]) {
    const d = derive(closed({ ...eur(bf), repay_fx: rf, borrow_amount: b, repay_amount: r }), AS_OF);
    const P = (v) => Math.round(Number(Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })) * 100) * Math.sign(v);
    assert.equal(P(d.interestPaidUsd) + P(d.principalFxUsd), P(d.loanCostUsd), `${b} at ${bf} to ${rf}`);
  }
  // One the two rates alone would miss by a cent: borrowed 9,999.99 at 1.1234
  // ($11,233.99), repaid 10,040.99 at 1.1111 ($11,156.54), so the loan cost
  // -$77.45 with $45.56 of it interest (41 x 1.1111). The rates give the
  // currency -122.9999, printed -$123.00, and the rows -$77.44; what is left
  // of the cost is -$123.01, and they add up.
  const d = derive(closed({ ...eur(1.1234), repay_fx: 1.1111, borrow_amount: 9999.99, repay_amount: 10040.99 }), AS_OF);
  near(d.loanCostUsd, -77.45, 'loan cost');
  near(d.interestPaidUsd, 45.56, 'of which interest');
  near(d.principalFxUsd, -123.01, 'of which currency');
});

if (process.exitCode) console.error(`\n${passed} passed, some failed.`);
else console.log(`ok - ${passed} checks`);
