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
  ethPriceInRange,
  coinUnits,
  coinDp,
  inCoin,
  FIGURE_MAX,
  qtyAsPrinted,
  SELL_OVER_BUY,
  CURRENCIES,
  PLATFORMS,
  ASSETS,
  ASSET_META,
  assetOf,
  gasKey,
  OPTIONAL_GAS,
  cents,
} from './calc.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// The page's own figure formatting for the few numbers a message quotes: a coin
// amount to the coin's own places (the cent, or eight for WBTC), and a quantity
// to its asset's (four for ETH, eight for cbBTC), grouped the way the cards
// group them.
const amount = (v, dp) =>
  Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const assetQty = (v, t) => (isNum(v) ? amount(v, ASSET_META[assetOf(t)].dp) : '');

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
// Fields that are words, not figures: read as typed rather than as a number.
export const TEXT_FIELDS = new Set(['borrow_currency', 'platform', 'asset', 'notes']);

export function contextFrom(trade, values, except) {
  return {
    ...trade,
    ...Object.fromEntries(
      Object.entries(values)
        .filter(([k]) => k !== except)
        .map(([k, v]) => [k, k.endsWith('_date') || TEXT_FIELDS.has(k) ? v || null : parseAmount(v)]),
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
  asset: 'Asset',
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
  platform: 'Platform',
};

// Gas on the borrow and the repayment, and the Aave legs of a loop, are the
// only stage fields that may be left empty. Blank on the first two is "not
// recorded", which the card says rather than printing $0.00; blank on an Aave
// leg, which not every trade takes, is "none paid". The swaps' costs are
// required: a swap always costs something, and it is most of what a loop pays.
export const OPTIONAL_FIELDS = new Set([gasKey('borrow'), gasKey('repay'), ...Object.values(OPTIONAL_GAS).flat()]);

/**
 * A field's label for the trade it is on. The quantities and the goal are
 * named for what the trade bought - "cbBTC purchased", and a "BTC goal price",
 * since a cbBTC goal is a BTC price - and everything else as `FIELD_LABELS`
 * has it, which is the ETH trade's wording.
 */
export function labelOf(name, trade = {}) {
  const { ticker, market } = ASSET_META[assetOf(trade)];
  if (name === 'buy_eth') return `${ticker} purchased`;
  if (name === 'sell_eth') return `${ticker} sold`;
  if (name === 'goal_price') return `${market} goal price`;
  return FIELD_LABELS[name] || name;
}

/**
 * Check one field in the context of the trade it belongs to.
 * Returns an error string, or null when the value is acceptable.
 */
export function validateField(name, raw, trade = {}) {
  const label = labelOf(name, trade);
  const ticker = ASSET_META[assetOf(trade)].ticker;
  const text = String(raw ?? '').trim();

  if (text === '') return OPTIONAL_FIELDS.has(name) ? null : `${label} is required.`;

  // A word, not a figure: one of the platforms by id, as the server checks it.
  if (name === 'platform') return PLATFORMS.includes(text.toLowerCase()) ? null : 'Pick a platform.';
  if (name === 'asset') return ASSETS.includes(text.toLowerCase()) ? null : 'Pick an asset.';

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
  // The server's ceiling on every figure (`FIGURE_MAX`).
  if (value > FIGURE_MAX) return 'That looks like a slipped digit.';

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
  // The coin the amounts are in, and the places it prints to: the cent, or 8
  // for WBTC.
  const coin = unitOf(trade);
  const dp = coinDp(coin);
  // A quantity that prints as all zeros, as the server refuses it.
  if ((name === 'buy_eth' || name === 'sell_eth') && qtyAsPrinted(value, assetOf(trade)) === 0) {
    const dp = ASSET_META[assetOf(trade)].dp;
    return `${label} must be at least ${(10 ** -dp).toFixed(dp)}.`;
  }
  // An amount of the coin prints to the cent (8 places for WBTC), so one that
  // prints as all zeros is refused as the server refuses it.
  if (name.endsWith('_amount') && coinUnits(value, coin) === 0) {
    return `${label} must be at least ${(10 ** -dp).toFixed(dp)}.`;
  }

  // The server's own bounds, both ends, so a slipped digit is caught here
  // rather than after a round trip. Only the ceiling was matched, so a goal of
  // $0.50 passed, its preview vanished, and Save was refused.
  // On the goal as the server takes it, to the cent: on the raw figure, 0.999
  // was previewed as a $1.00 goal and saved by the server, but refused here.
  if (name === 'goal_price') {
    return priceInRange(cents(value) / 100) ? null : 'That looks like a slipped digit. The price is in dollars.';
  }

  // The price the purchase or sale implies, as the server checks it.
  const spent = name === 'buy_eth' ? trade.buy_amount : name === 'sell_eth' ? trade.sell_amount : null;
  // From the amount as printed, as the server and `derive` work it out.
  const price = isNum(spent) ? inCoin(spent, coin) / value : null;
  if (price !== null && !ethPriceInRange(price, coin)) {
    const shown = price.toLocaleString('en-US', { maximumSignificantDigits: 4 });
    return `That is ${shown} ${unitOf(trade)} per ${ticker}. Check the amount and the ${ticker}.`;
  }

  if (name === 'sell_eth' && isNum(trade.buy_eth) && value > trade.buy_eth * SELL_OVER_BUY) {
    return `That is more than 10% above the ${assetQty(trade.buy_eth, trade)} ${ticker} you bought.`;
  }
  // The same pair from the other side: cutting the purchase below what has
  // already been sold, or the loan below what has already been repaid.
  if (name === 'buy_eth' && isNum(trade.sell_eth) && value * SELL_OVER_BUY < trade.sell_eth) {
    return `You already sold ${assetQty(trade.sell_eth, trade)} ${ticker}.`;
  }
  if (name === 'borrow_amount' && isNum(trade.repay_amount)) {
    // In cents as printed, as the server and `derive` compare them - in the
    // coin's own last place for WBTC, and printed to it.
    if (coinUnits(trade.repay_amount, coin) < coinUnits(value, coin)) {
      return `You repaid ${amount(trade.repay_amount, dp)}, which is less than this.`;
    }
    if (trade.repay_amount > value * 2) {
      return `You repaid ${amount(trade.repay_amount, dp)}, more than double this.`;
    }
  }
  if (name === 'repay_amount' && isNum(trade.borrow_amount)) {
    if (coinUnits(value, coin) < coinUnits(trade.borrow_amount, coin)) {
      return `A repayment cannot be less than the ${amount(trade.borrow_amount, dp)} borrowed.`;
    }
    if (value > trade.borrow_amount * 2) {
      return `That is a long way above the ${amount(trade.borrow_amount, dp)} borrowed.`;
    }
  }
  return null;
}
