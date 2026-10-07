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
import { sanitizeNumeric, validateField, contextFrom, unitOf } from '../lib/input.js';

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

if (process.exitCode) console.error(`\n${passed} passed, some failed.`);
else console.log(`ok - ${passed} input checks`);
