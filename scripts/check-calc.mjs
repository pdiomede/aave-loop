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
  hasEstimate,
  estimateNeedsPrice,
  openGainsUsd,
  parseAmount,
  summaryReport,
  derivedOn,
  intervalMs,
} from '../lib/calc.js';
import { tradesCsv } from '../lib/csv.js';

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
  // come to the same thing either way.
  const fx = { EURC: 1.17 };
  const before = est(held(eur(1.05)), PRICE, fx);
  const after = est(sold({ ...eur(1.05), sell_amount: (0.01 * PRICE) / 1.17, sell_eth: 0.01, sell_gas_usd: 0 }), PRICE, fx);
  near(before, 10 * PRICE - (30000 + INTEREST) * 1.17 - 8, 'held');
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
  near(d.netGainUsd, 33000 - 30000 - INTEREST - 12, 'net gain');
});

check('a closed partial sale is the gain on the ETH sold, nothing more', () => {
  const t = closed({ sell_amount: 21000, sell_eth: 6 });
  near(derive(t, AS_OF).netGainUsd, 21000 - 18000 - INTEREST - 12, 'net gain');
});

check('a loan with nothing bought holds no position to value', () => {
  const t = { id: 9, borrow_date: '2026-09-01', borrow_amount: 30000, borrow_currency: 'USDT', borrow_apr: 4, borrow_gas_usd: 3 };
  assert.equal(hasEstimate(derive(t, AS_OF)), false);
});

/* ------------------------------------------------------------ the header */

check('openGainsUsd sums the open positions and skips the rest', () => {
  const g = openGainsUsd([closed({ id: 3 }), sold({ id: 2 }), held({ id: 1 })], PRICE, {}, AS_OF);
  assert.deepEqual(g.rows.map((r) => r.id), [1, 2]);
  near(g.total, 10 * PRICE - 30000 - INTEREST - 8 + (33000 - 30000 - INTEREST - 12), 'total');
  assert.equal(g.missing, 0);
});

check('openGainsUsd: no ETH price, no total, rather than the sold ones alone', () => {
  const g = openGainsUsd([held({ id: 1 }), sold({ id: 2 })], null, {}, AS_OF);
  assert.equal(g.total, null);
  assert.equal(g.missing, 1);
});

check('openGainsUsd: no ETH price is fine when nothing depends on it', () => {
  const g = openGainsUsd([sold({ id: 2 })], null, {}, AS_OF);
  near(g.total, 33000 - 30000 - INTEREST - 12, 'total');
});

check('openGainsUsd: an unknown position is missing, never a zero', () => {
  const g = openGainsUsd([held({ id: 1 }), held({ id: 2, ...eur(null) })], PRICE, {}, AS_OF);
  near(g.total, 10 * PRICE - 30000 - INTEREST - 8, 'total');
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

check('a timer interval from the environment stays where a timer can use it', () => {
  assert.equal(intervalMs(undefined, 3600000), 3600000);
  assert.equal(intervalMs('abc', 3600000), 3600000);
  assert.equal(intervalMs('-5', 3600000), 3600000);
  assert.equal(intervalMs('2000', 3600000), 2000);
  // Above 2^31 - 1 Node fires every millisecond instead.
  assert.equal(intervalMs('99999999999', 3600000), 2147483647);
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

if (process.exitCode) console.error(`\n${passed} passed, some failed.`);
else console.log(`ok - ${passed} checks`);
