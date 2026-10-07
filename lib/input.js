/**
 * What the forms accept, and how a typed figure is read: the input half of the
 * interface, out of public/app.js so it can be checked.
 *
 * Served to the browser from /lib/input.js exactly as Node imports it, like
 * csv.js, so `npm run check` (scripts/check-input.mjs) runs the very code the
 * forms do. Several of the worst bugs this ledger has had lived here - a typed
 * "3,20" saved as a $320 fee, a pasted "1.5 ETH ($5175)" saved as 1.55175 ETH -
 * and none of them could be caught while it sat in a file nothing can import.
 *
 * Pure: no DOM, no fetch. It imports calc.js, which imports nothing, ever.
 */
import {
  todayISO,
  parseAmount,
  priceInRange,
  SELL_OVER_BUY,
  CURRENCIES,
  gasKey,
  OPTIONAL_GAS,
} from './calc.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The page's own figure formatting for the few numbers a message quotes: to the
// cent, and ETH to four places, grouped the way the cards group them.
const USD_DP = 2;
const ETH_DP = 4;
const amount = (v, dp) =>
  Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const ethQty = (v) => (isNum(v) ? amount(v, ETH_DP) : '');

/**
 * The coin a trade's amounts are in. A new trade starts on the first coin in
 * the picker, so its Amount field carries that ticker until another is picked.
 */
export const unitOf = (t) => t.borrow_currency || CURRENCIES[0];

/**
 * The trade a field is judged against: the saved one, with the values typed in
 * the form's other fields laid over it, so a sale is checked against the ETH
 * bought and the ETH against the amount as they stand in the form. `values` is
 * the form's fields as text, by name; `except` is the field being judged.
 */
export function contextFrom(trade, values, except) {
  return {
    ...trade,
    ...Object.fromEntries(
      Object.entries(values)
        .filter(([k]) => k !== except)
        .map(([k, v]) => [k, k.endsWith('_date') || k === 'borrow_currency' || k === 'notes' ? v || null : parseAmount(v)]),
    ),
  };
}

// Ethereum's genesis block. Nothing in this ledger can predate it.
export const EARLIEST_DATE = '2015-07-30';

/**
 * Strip what can never belong in a number, as the user types: anything but
 * digits, the two separators and a sign. The separators stay as typed, and
 * `parseAmount` - the server's own parser - reads the finished text, at blur,
 * at submit and on the save.
 *
 * Reading them here, a keystroke at a time, was the bug. "1,5" on its way to
 * "1,500" cannot be told from a decimal comma mid-typing, so commas were
 * dropped: typing "3,20" saved a $320 fee, "32.000,00" a loan of 32, and on a
 * phone whose decimal keypad offers only "," every decimal was multiplied. And
 * a paste the parser refuses was cut down to a different number that it then
 * accepted: "1.5 ETH ($5,175.00)" saved 1.55175 ETH, where the server, handed
 * the same text, says it is not a number.
 */
export function sanitizeNumeric(text) {
  const s = String(text ?? '');
  // Anything else between two runs of digits is left whole, for the parser to
  // refuse. Stripped, it glued two numbers into one it accepts: a pasted
  // "1.5 ETH ($5175)" saved 1.55175 ETH and "3 (≈$3.20)" saved 33.20. Spaces
  // alone do not count, so "1 234,56" still reads as 1234.56.
  if (/\d[^\d.,+\-\s]+[\s\S]*\d/.test(s.replace(/\s+/g, ''))) return s;
  // An exponent stays, so the parser can refuse it as the server does.
  // Stripped like any other letter, "1e5" became 15 and was saved. Only an
  // "e" straight after a digit - "1e", "1e5", "2E-3" - so the "E" of a pasted
  // "12,000 EURC" still goes. A trailing one is kept because the digit after
  // it has not been typed yet.
  const exponent = /\d[eE][+-]?(?:\d|$)/.test(s);
  return s.replace(exponent ? /[^0-9.,+\-eE]/g : /[^0-9.,+-]/g, '');
}

// A swap's cost is more than its gas: the DEX or aggregator takes a fee too,
// and both are typed as one dollar figure.
export const SWAP_FEE = 'Costs & Fees (swap)';

export const FIELD_LABELS = {
  goal_price: 'ETH goal price',
  borrow_date: 'Borrow date',
  borrow_amount: 'Amount borrowed',
  borrow_apr: 'Borrow APR',
  buy_date: 'Purchase date',
  buy_amount: 'Amount spent',
  buy_eth: 'ETH purchased',
  sell_date: 'Sale date',
  sell_eth: 'ETH sold',
  sell_amount: 'Amount received',
  repay_date: 'Repayment date',
  repay_amount: 'Amount repaid',
  borrow_gas_usd: 'Gas fee',
  buy_gas_usd: SWAP_FEE,
  sell_gas_usd: SWAP_FEE,
  repay_gas_usd: 'Gas fee',
  buy_lend_gas_usd: 'Gas fee to lend',
  sell_unstake_gas_usd: 'Gas fee to unstake',
};

// Gas on the borrow and the repayment, and the Aave legs of a loop, are the
// only stage fields that may be left empty. Blank on the first two is "not
// recorded", which the card says rather than printing $0.00; blank on an Aave
// leg, which not every trade takes, is "none paid". The swaps' costs are
// required: a swap always costs something, and it is most of what a loop pays.
export const OPTIONAL_FIELDS = new Set([gasKey('borrow'), gasKey('repay'), ...Object.values(OPTIONAL_GAS).flat()]);

/**
 * Check one field in the context of the trade it belongs to.
 * Returns an error string, or null when the value is acceptable.
 */
export function validateField(name, raw, trade = {}) {
  const label = FIELD_LABELS[name] || name;
  const text = String(raw ?? '').trim();

  if (text === '') return OPTIONAL_FIELDS.has(name) ? null : `${label} is required.`;

  if (name.endsWith('_date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${label} must be a valid date.`;
    if (text > todayISO()) return `${label} cannot be in the future.`;
    if (text < EARLIEST_DATE) return `${label} is before Ethereum existed. Check the year.`;

    const after = (other, otherLabel) =>
      trade[other] && text < trade[other] ? `${label} cannot be before the ${otherLabel}.` : null;
    // The mirror of `after`. Moving an early stage forward past a later one is
    // exactly as wrong as dragging a late stage back, but only the server
    // caught it, and its message names the stage it collided with rather than
    // the one being edited. That field is not in the form on screen, so the
    // message fell through to the form's error line with no field marked.
    const before = (other, otherLabel) =>
      trade[other] && text > trade[other] ? `${label} cannot be after the ${otherLabel}.` : null;
    if (name === 'borrow_date') {
      return before('buy_date', 'purchase') || before('sell_date', 'sale') || before('repay_date', 'repayment');
    }
    if (name === 'buy_date') {
      return after('borrow_date', 'borrow') || before('sell_date', 'sale') || before('repay_date', 'repayment');
    }
    if (name === 'sell_date') {
      return (
        after('buy_date', 'purchase') || after('borrow_date', 'borrow') || before('repay_date', 'repayment')
      );
    }
    if (name === 'repay_date') return after('sell_date', 'sale') || after('borrow_date', 'borrow');
    return null;
  }

  const value = parseAmount(text);
  if (value === null) return `${label} must be a number.`;

  if (name === 'borrow_apr') {
    if (value < 0) return 'APR cannot be negative.';
    if (value > 100) return 'APR looks too high. Enter it as a percent, for example 4.27.';
    return null;
  }

  // Gas can be nothing at all - a sponsored transaction - so 0 is a figure
  // here, the way 0% is for an APR. Blank is let through above, and stored as
  // NULL: an unrecorded fee, not a free one.
  if (name.endsWith('_gas_usd')) {
    return value < 0 ? 'A gas fee cannot be negative.' : null;
  }

  if (value <= 0) return `${label} must be greater than zero.`;

  // The server's own bounds, both ends, so a slipped digit is caught here
  // rather than after a round trip. Only the ceiling was matched, so a goal of
  // $0.50 passed, its preview vanished, and Save was refused.
  if (name === 'goal_price') {
    return priceInRange(value) ? null : 'That looks like a slipped digit. The price is in dollars.';
  }

  // The price the purchase or sale implies, as the server checks it.
  const spent = name === 'buy_eth' ? trade.buy_amount : name === 'sell_eth' ? trade.sell_amount : null;
  if (isNum(spent) && !priceInRange(spent / value)) {
    const shown = (spent / value).toLocaleString('en-US', { maximumSignificantDigits: 4 });
    return `That is ${shown} ${unitOf(trade)} per ETH. Check the amount and the ETH.`;
  }

  if (name === 'sell_eth' && isNum(trade.buy_eth) && value > trade.buy_eth * SELL_OVER_BUY) {
    return `That is more than 10% above the ${ethQty(trade.buy_eth)} ETH you bought.`;
  }
  // The same pair from the other side: cutting the purchase below what has
  // already been sold, or the loan below what has already been repaid.
  if (name === 'buy_eth' && isNum(trade.sell_eth) && value * SELL_OVER_BUY < trade.sell_eth) {
    return `You already sold ${ethQty(trade.sell_eth)} ETH.`;
  }
  if (name === 'borrow_amount' && isNum(trade.repay_amount)) {
    if (trade.repay_amount < value - 0.005) {
      return `You repaid ${amount(trade.repay_amount, USD_DP)}, which is less than this.`;
    }
    if (trade.repay_amount > value * 2) {
      return `You repaid ${amount(trade.repay_amount, USD_DP)}, more than double this.`;
    }
  }
  if (name === 'repay_amount' && isNum(trade.borrow_amount)) {
    if (value < trade.borrow_amount - 0.005) {
      return `A repayment cannot be less than the ${amount(trade.borrow_amount, USD_DP)} borrowed.`;
    }
    if (value > trade.borrow_amount * 2) {
      return `That is a long way above the ${amount(trade.borrow_amount, USD_DP)} borrowed.`;
    }
  }
  return null;
}
