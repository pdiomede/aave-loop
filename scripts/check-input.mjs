#!/usr/bin/env node
/**
 * Checks for lib/input.js: how the forms read a typed or pasted figure, and
 * what they accept. `npm run check` runs them after the calc checks.
 *
 * The file is the very one the browser runs (it is served from /lib/input.js),
 * so a case here is a case on the page. Each one below is a figure a person
 * can type or paste, with what it must come to written out by hand, and most
 * are a bug this ledger has shipped: "3,20" saved as a $320 fee, "32.000,00" as
 * a loan of 32, "1.5 ETH ($5175)" as 1.55175 ETH, "1e5" as 15.
 */
import assert from 'node:assert/strict';
import { parseAmount } from '../lib/calc.js';
import { sanitizeNumeric, validateField, contextFrom, unitOf, labelOf } from '../lib/input.js';

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

// What the field holds after each keystroke, as the page's input handler
// leaves it, and what the form then reads from it.
const typed = (text) => [...text].reduce((field, ch) => sanitizeNumeric(field + ch), '');
// A paste, a drop or an autofill arrives whole.
const pasted = (text) => sanitizeNumeric(text);
const reads = (field) => parseAmount(field);

/* ----------------------------------------------------------- typed figures */

check('a typed decimal comma is a decimal point', () => {
  assert.equal(reads(typed('3,20')), 3.2);
  assert.equal(reads(typed('4,27')), 4.27);
  assert.equal(reads(typed('8,0773')), 8.0773);
  assert.equal(reads(typed('0,125')), 0.125);
  // A comma that cannot be grouping, typed a key at a time: the fee ",125"
  // and the loan "30000,125" were read as 125 and 30,000,125.
  assert.equal(reads(typed(',125')), 0.125);
  assert.equal(reads(typed('30000,125')), 30000.125);
  assert.equal(reads(typed('35 401,022')), 35401.022);
  assert.equal(validateField('buy_gas_usd', ',125'), null);
});

check('a typed European thousands figure keeps its size', () => {
  assert.equal(reads(typed('32.000,00')), 32000);
  assert.equal(reads(typed('3.450,50')), 3450.5);
});

check('typed thousands and a half-typed point read as meant', () => {
  assert.equal(reads(typed('1,500')), 1500);
  assert.equal(reads(typed('12,000')), 12000);
  assert.equal(reads(typed('1500.')), 1500);
});

check('a typed exponent is refused, not read as other digits', () => {
  assert.equal(typed('1e5'), '1e5');
  assert.equal(reads(typed('1e5')), null);
  assert.equal(validateField('borrow_amount', typed('1e5')), 'Amount borrowed must be a number.');
});

/* ---------------------------------------------------------- pasted figures */

check('a pasted symbol or unit is stripped', () => {
  assert.equal(reads(pasted('$12,000')), 12000);
  assert.equal(reads(pasted('12,000 EURC')), 12000);
  assert.equal(reads(pasted('€1.234,56')), 1234.56);
  assert.equal(reads(pasted('1 234,56')), 1234.56);
});

check('a paste with text between two numbers is refused, not glued into one', () => {
  for (const text of ['1.5 ETH ($5175)', '1.5 ETH ($5,175.00)', '3 (≈$3.20)', '0.000321 ETH ($1.03)']) {
    assert.equal(reads(pasted(text)), null, text);
  }
});

check('a pasted grouping the server refuses is refused here too', () => {
  for (const text of ['1,25.50', '1.234.567']) assert.equal(reads(pasted(text)), parseAmount(text), text);
});

/* ------------------------------------------------------------- the rules */

check('a required field must be filled, an optional fee may be blank', () => {
  assert.equal(validateField('borrow_amount', ''), 'Amount borrowed is required.');
  assert.equal(validateField('buy_gas_usd', ''), 'Costs & Fees (swap) is required.');
  assert.equal(validateField('borrow_gas_usd', ''), null);
  assert.equal(validateField('repay_gas_usd', ''), null);
  assert.equal(validateField('buy_lend_gas_usd', ''), null);
});

check('a fee of 0 is a figure, a negative one is not', () => {
  assert.equal(validateField('buy_gas_usd', '0'), null);
  assert.equal(validateField('repay_gas_usd', '-1'), 'A gas fee cannot be negative.');
});

check('an APR is a percent between 0 and 100', () => {
  assert.equal(validateField('borrow_apr', '0'), null);
  assert.equal(validateField('borrow_apr', pasted('-1.2')), 'APR cannot be negative.');
  assert.equal(validateField('borrow_apr', '427'), 'APR looks too high. Enter it as a percent, for example 4.27.');
});

check('a date is between Ethereum and today, in stage order', () => {
  assert.equal(validateField('buy_date', '2999-01-01'), 'Purchase date cannot be in the future.');
  assert.equal(validateField('borrow_date', '2015-07-29'), 'Borrow date is before Ethereum existed. Check the year.');
  assert.equal(
    validateField('sell_date', '2026-09-01', { buy_date: '2026-09-05' }),
    'Sale date cannot be before the purchase.',
  );
  assert.equal(
    validateField('buy_date', '2026-09-10', { sell_date: '2026-09-05' }),
    'Purchase date cannot be after the sale.',
  );
});

check('an alert goal is between $1 and $1,000,000', () => {
  assert.equal(validateField('goal_price', '0.5'), 'That looks like a slipped digit. The price is in dollars.');
  assert.equal(validateField('goal_price', '3500'), null);
});

check('the ETH price a purchase implies must be one ETH could trade at', () => {
  // 25,000 for 80,773 ETH is 0.3095 an ETH: 8.0773 typed without its point.
  assert.equal(
    validateField('buy_eth', '80773', { buy_amount: 25000, borrow_currency: 'USDC' }),
    'That is 0.3095 USDC per ETH. Check the amount and the ETH.',
  );
  assert.equal(validateField('buy_eth', '8.0773', { buy_amount: 25000 }), null);
});

check('a sale may run 10% over the ETH bought, not past it', () => {
  assert.equal(validateField('sell_eth', '10.03', { buy_eth: 10 }), null);
  assert.equal(validateField('sell_eth', '11.5', { buy_eth: 10 }), 'That is more than 10% above the 10.0000 ETH you bought.');
});

check('a repayment is at least the loan and not double it', () => {
  assert.equal(
    validateField('repay_amount', '29000', { borrow_amount: 30000 }),
    'A repayment cannot be less than the 30,000.00 borrowed.',
  );
  assert.equal(validateField('repay_amount', '60001', { borrow_amount: 30000 }), 'That is a long way above the 30,000.00 borrowed.');
  assert.equal(validateField('repay_amount', '30098.63', { borrow_amount: 30000 }), null);
});

check('an amount must be more than zero', () => {
  assert.equal(validateField('borrow_amount', '0'), 'Amount borrowed must be greater than zero.');
  assert.equal(validateField('buy_eth', '0'), 'ETH purchased must be greater than zero.');
  assert.equal(validateField('borrow_amount', '0,01'), null);
});

// The mirrors: editing an earlier stage into a conflict with a later one, which
// only the server used to catch, naming a field that was not on screen.
check('an earlier stage cannot be moved or cut past a later one', () => {
  assert.equal(validateField('borrow_date', '2026-03-10', { buy_date: '2026-03-05' }), 'Borrow date cannot be after the purchase.');
  assert.equal(validateField('borrow_date', '2026-03-05', { buy_date: '2026-03-05' }), null, 'the same day is fine');
  // 6 ETH sold: 5 bought is too few even with Aave's 10%, 5.5 is not (6.05).
  assert.equal(validateField('buy_eth', '5', { sell_eth: 6 }), 'You already sold 6.0000 ETH.');
  assert.equal(validateField('buy_eth', '5.5', { sell_eth: 6 }), null);
  // 30,100 repaid: a loan of 31,000 is more than was paid back, 10,000 under half.
  assert.equal(validateField('borrow_amount', '31000', { repay_amount: 30100 }), 'You repaid 30,100.00, which is less than this.');
  assert.equal(validateField('borrow_amount', '10000', { repay_amount: 30100 }), 'You repaid 30,100.00, more than double this.');
  assert.equal(validateField('borrow_amount', '30000', { repay_amount: 30100 }), null);
});

/* --------------------------------------------------- the form's own context */

check('a field is judged against what is typed beside it, not the saved trade', () => {
  // Saved: 30,000 for 10 ETH. Typed: 30 for 0.01 ETH, which is $3,000 an ETH.
  // Against the saved 30,000 the same 0.01 ETH reads $3,000,000 and is refused.
  const saved = { buy_amount: 30000, buy_eth: 10, borrow_currency: 'EURC' };
  const ctx = contextFrom(saved, { buy_amount: '30', buy_eth: '0.01' }, 'buy_eth');
  assert.equal(ctx.buy_amount, 30);
  assert.equal(ctx.buy_eth, 10, 'the field being judged is not laid over');
  assert.equal(ctx.borrow_currency, 'EURC');
  assert.equal(validateField('buy_eth', '0.01', ctx), null);
  assert.notEqual(validateField('buy_eth', '0.01', saved), null);
});

check('a field typed blank counts as blank, not as the saved figure', () => {
  assert.equal(contextFrom({ buy_amount: 30000 }, { buy_amount: '' }, 'buy_eth').buy_amount, null);
});

check('a new trade is in the first coin until another is picked', () => {
  assert.equal(unitOf({}), 'DAI');
  assert.equal(unitOf({ borrow_currency: 'EURC' }), 'EURC');
});

check('a repayment is judged against the loan as printed, to the cent', () => {
  // 10,000.005 prints as 10,000.01, so 10,000.00 would be interest of -$0.01.
  assert.notEqual(validateField('repay_amount', '10000', { borrow_amount: 10000.005 }), null);
  assert.equal(validateField('repay_amount', '10000.01', { borrow_amount: 10000.005 }), null);
  assert.notEqual(validateField('borrow_amount', '10000.005', { repay_amount: 10000 }), null);
});

check('the platform is required, one of Aave, Ether.fi or Morpho, and kept as a word', () => {
  assert.equal(validateField('platform', ''), 'Platform is required.');
  assert.equal(validateField('platform', 'uniswap'), 'Pick a platform.');
  assert.equal(validateField('platform', 'aave'), null);
  assert.equal(validateField('platform', 'EtherFi'), null);
  assert.equal(validateField('platform', 'Morpho'), null);
  assert.equal(contextFrom({}, { platform: 'etherfi' }).platform, 'etherfi');
});

check('the asset is required, ETH or cbBTC, and kept as a word', () => {
  assert.equal(validateField('asset', ''), 'Asset is required.');
  assert.equal(validateField('asset', 'doge'), 'Pick an asset.');
  assert.equal(validateField('asset', 'cbbtc'), null);
  assert.equal(validateField('asset', 'ETH'), null);
  assert.equal(contextFrom({}, { asset: 'cbbtc' }).asset, 'cbbtc');
});

check('a cbBTC trade names its fields and its messages for cbBTC, and its goal for BTC', () => {
  const t = { asset: 'cbbtc', borrow_currency: 'USDC' };
  assert.equal(labelOf('buy_eth', t), 'cbBTC purchased');
  assert.equal(labelOf('sell_eth', t), 'cbBTC sold');
  assert.equal(labelOf('goal_price', t), 'BTC goal price');
  assert.equal(validateField('buy_eth', '', t), 'cbBTC purchased is required.');
  assert.equal(validateField('goal_price', '', t), 'BTC goal price is required.');
  // 30,000 for 0.01 is 3,000,000 a coin: a slipped digit, named per cbBTC.
  assert.equal(
    validateField('buy_eth', '0.01', { ...t, buy_amount: 30000 }),
    'That is 3,000,000 USDC per cbBTC. Check the amount and the cbBTC.',
  );
  // Quantities to cbBTC's own eight places, as the card prints them.
  assert.equal(
    validateField('sell_eth', '0.5', { ...t, buy_eth: 0.01234567 }),
    'That is more than 10% above the 0.01234567 cbBTC you bought.',
  );
  assert.equal(
    validateField('buy_eth', '0.001', { ...t, buy_amount: 100, sell_eth: 0.01234567 }),
    'You already sold 0.01234567 cbBTC.',
  );
  // An ETH trade reads exactly as it did.
  assert.equal(labelOf('buy_eth', {}), 'ETH purchased');
  assert.equal(labelOf('goal_price', {}), 'ETH goal price');
});

check('a figure past a trillion, or an amount that prints as 0.00, is refused as the server refuses it', () => {
  assert.equal(validateField('buy_gas_usd', '2000000000000', {}), 'That looks like a slipped digit.');
  assert.equal(validateField('borrow_amount', '2000000000000', {}), 'That looks like a slipped digit.');
  assert.match(validateField('borrow_amount', '0.004', {}), /must be at least 0\.01\.$/);
  assert.equal(validateField('borrow_amount', '0.01', {}), null);
  // A fee or a quantity is not an amount of the coin: 0.004 stays a figure.
  assert.equal(validateField('buy_gas_usd', '0.004', {}), null);
  assert.equal(validateField('buy_eth', '0.004', { buy_amount: 12 }), null);
  // The implied price from the amount as printed: 0.014 prints 0.01, and
  // 0.01 for 0.014 ETH is $0.71 an ETH.
  assert.match(validateField('buy_eth', '0.014', { buy_amount: 0.014, borrow_currency: 'USDC' }), /^That is 0\.7143 USDC per ETH/);
});

check('a goal is judged to the cent, and a quantity that prints as zero is refused, as the server does', () => {
  // 0.999 is a $1.00 goal to the server; the form refused it on the raw figure.
  assert.equal(validateField('goal_price', '0.999', {}), null);
  assert.equal(validateField('goal_price', '1000000.004', {}), null);
  assert.match(validateField('goal_price', '0.994', {}), /slipped digit/);
  assert.match(validateField('goal_price', '1000000.005', {}), /slipped digit/);
  assert.equal(validateField('buy_eth', '0.00004', { buy_amount: 0.12 }), 'ETH purchased must be at least 0.0001.');
  assert.equal(validateField('sell_eth', '0.00004', {}), 'ETH sold must be at least 0.0001.');
  assert.equal(validateField('buy_eth', '0.00000001', { asset: 'cbbtc', buy_amount: 0.01 }), null);
});

check('a WBTC figure keeps all 8 places, and its ETH price is judged in WBTC', () => {
  assert.equal(reads(typed('0.35012345')), 0.35012345);
  assert.equal(reads(typed('0,35012345')), 0.35012345);
  const wbtc = { borrow_currency: 'WBTC', buy_amount: 0.35012345 };
  // 0.035 WBTC an ETH is a price; 350 would have been refused as cents.
  assert.equal(validateField('buy_eth', '10', wbtc), null);
  assert.equal(
    validateField('buy_eth', '0.001', wbtc),
    'That is 350.1 WBTC per ETH. Check the amount and the ETH.',
  );
  // Judged to the satoshi and said to it: to the cent, 0.35012345 repaid on a
  // loan of 0.35012346 would have passed as the same 0.35.
  assert.equal(
    validateField('repay_amount', '0.35012345', { borrow_currency: 'WBTC', borrow_amount: 0.35012346 }),
    'A repayment cannot be less than the 0.35012346 borrowed.',
  );
  assert.equal(validateField('repay_amount', '0.35012346', { borrow_currency: 'WBTC', borrow_amount: 0.35012346 }), null);
  // 0.004 is a real loan in WBTC, hundreds of dollars; under a satoshi is not.
  assert.equal(validateField('borrow_amount', '0.004', { borrow_currency: 'WBTC' }), null);
  assert.equal(
    validateField('borrow_amount', '0.000000004', { borrow_currency: 'WBTC' }),
    'Amount borrowed must be at least 0.00000001.',
  );
  assert.equal(validateField('borrow_amount', '0.004', { borrow_currency: 'USDC' }), 'Amount borrowed must be at least 0.01.');
});

if (process.exitCode) console.error(`\n${passed} passed, some failed.`);
else console.log(`ok - ${passed} input checks`);
