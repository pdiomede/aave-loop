/**
 * Formatting for the things this app says in Telegram.
 *
 * Server only, and at the root rather than in lib/ for the usual reason: the
 * browser is served lib/ wholesale, and nothing in here is any use to it.
 *
 * `public/app.js` keeps its own copies of `fmtDate` and friends on purpose, so
 * this is not a duplicate waiting to be tidied away. The browser cannot import
 * a file from the root, and its version escapes its own output for innerHTML,
 * which would be wrong here. The two agree on what a date looks like because
 * a figure read in the group and the same figure read on the page should not
 * look like two different figures.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A dash, not a zero, for a figure nobody measured. */
export const MISSING = '-';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Grouped to a fixed number of places.
 *
 * Guarded like everything else here. These two were the exception: handed
 * undefined they returned the string "NaN", which is not a figure and is
 * exactly the sort of thing that reaches a chat message unnoticed, because
 * every other formatter in this file quietly says "-" instead.
 */
const fixed = (v, dp) =>
  isNum(v)
    ? Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : MISSING;

export const n2 = (v) => fixed(v, 2);
export const n4 = (v) => fixed(v, 4);

/** The same "20 Sep 2026" the interface shows, so the two read alike. */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * The sign comes from the figure as printed, not as held.
 *
 * A value too small to show rounds to zero at two places, and taking the sign
 * from the raw number then wrote "-$0.00" - a loss, in red, of nothing. The
 * same went for "-0.0%". Rounding first and deciding after means a figure that
 * prints as zero reads as zero.
 */
const signOf = (v, dp) => (Number(Math.abs(v).toFixed(dp)) === 0 ? '' : v < 0 ? '-' : '');

export const usd = (v) => (isNum(v) ? `${signOf(v, 2)}$${n2(Math.abs(v))}` : MISSING);

/** Always carries its sign, because a gain and a loss must not look alike. */
export const signedUsd = (v) =>
  isNum(v) ? `${signOf(v, 2) || '+'}$${n2(Math.abs(v))}` : MISSING;

export const pct1 = (v) =>
  isNum(v) ? `${signOf(v, 1) || '+'}${Math.abs(v).toFixed(1)}%` : MISSING;

export const pct2 = (v) => (isNum(v) ? `${signOf(v, 2)}${Math.abs(v).toFixed(2)}%` : MISSING);

export const padLeft = (s, w) => String(s).padStart(w, ' ');
export const padRight = (s, w) => String(s).padEnd(w, ' ');

/**
 * The three characters that matter inside a Telegram HTML message. Everything
 * the bot sends is numbers it computed itself, but a currency ticker and a
 * group name both come from outside, and a message that fails to parse is a
 * message that never arrives.
 */
export const escHtml = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
