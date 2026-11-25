import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, prepare, closeDb, FIELDS, FX_COLUMNS } from './db.js';
import {
  derive,
  summaryReport,
  parseDate,
  parseAmount,
  priceInRange,
  unitPriceInRange,
  FIGURE_MAX,
  qtyAsPrinted,
  SELL_OVER_BUY,
  stages,
  reachedStages,
  tracksGas,
  gasKey,
  todayISO,
  intervalMs,
  cents,
  asPrinted,
  CURRENCIES,
  PLATFORMS,
  ASSETS,
  ASSET_META,
  MARKETS,
  assetMeta,
  assetOf,
  marketOf,
  FX_STAGES,
  STATUS,
} from './lib/calc.js';
import {
  fillFxColumns,
  staleFxColumns,
  backfillRates,
  resolveRate,
  fxStatus,
  startFxRefresher,
  stopFxRefresher,
} from './fx.js';
import { telegramConfig, reportConfig, configPath } from './config.js';
import { marketPrices, marketPrice, cachedMarketPrice, cachedMarketPrices, priceStatus } from './prices.js';
import { sendTelegramMessage } from './telegram.js';
import {
  armedAlerts,
  alertLog,
  saveAlert,
  deleteAlert,
  deleteAllAlerts,
  previewMessage,
  startAlertPoller,
  stopAlertPoller,
  alertSweepDone,
  closeUnwatched,
  closeForAssetChange,
  freshPrice,
} from './alerts.js';
import { startBotPoller, stopBotPoller, botTickDone } from './bot.js';
import { setting, oldSettingsNote } from './env.js';
import { labelOf } from './lib/input.js';
import { NETWORKS, NETWORK_META, parseAddress, parseTxHash, walletName, walletNameError } from './lib/address.js';
import { ANCHOR, TX_STAGES, findStageTx, stageRecorded, txBasis } from './etherscan.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// Says nothing about the stack to anyone who asks.
app.disable('x-powered-by');

/**
 * How this page may be embedded, and what a browser may assume about it.
 *
 * The ledger used to be reachable only from the machine running it, where
 * framing was moot. Behind a proxy it is not: without this an attacker's page
 * can frame the app against a logged in session and land a click on Delete
 * trade. `frame-ancestors` is the modern form and X-Frame-Options the one
 * older browsers read, so both are sent.
 *
 * It stops at framing on purpose. This header goes on everything served here,
 * and the landing page and the 404 page run inline scripts, so a script-src
 * policy would block them whenever the app runs without nginx; in production
 * nginx sets their policy, pinning those scripts by hash. The ledger page has
 * no inline script (its theme runs from public/theme.js).
 */
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// The ledger has no authentication; the loopback bind is the whole of its
// protection. A request has to be addressed to loopback as well, or a page on
// the internet can point its own hostname at 127.0.0.1 and reach this API as a
// same origin, reading and deleting the entire ledger.
//
// Running behind a reverse proxy is a legitimate deployment, and there the Host
// is the public name rather than loopback, so the proxy's hostname has to be
// named. Naming it explicitly is what keeps the protection above intact: a page
// on the internet that points its own hostname at 127.0.0.1 still fails this
// check, because its name is not on the list. Left unset, this is exactly the
// loopback-only ledger it has always been.
const EXTRA_HOSTS = (setting('ALLOWED_HOSTS') || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_HOSTS = new Set([
  ...['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [h, `${h}:${PORT}`]),
  ...EXTRA_HOSTS,
]);

app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    return res
      .status(403)
      .type('text/plain')
      .send(
        'This ledger only answers on localhost. Behind a proxy, name the host in ' +
          'ETHROUNDTRIP_ALLOWED_HOSTS.',
      );
  }
  next();
});

// Cross-site requests. In production the app sits behind basic auth, and a
// browser sends those credentials with any request to the origin - including
// a form another site posts at it. A hidden form on any page could press Send
// test message or Fetch rates on your behalf. Every write here is therefore
// required to come as JSON: an HTML form cannot send that content type, and a
// script on another site cannot either without a CORS preflight, which this
// server never answers. The app's own `api()` sends it on every call.
//
// Read from the header rather than through `req.is`, which answers null for a
// request with no body - and the app's own DELETEs have none.
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (READS.has(req.method) || type === 'application/json') return next();
  res.status(415).json({ error: 'Send this request as JSON, with Content-Type: application/json.' });
});

app.use(express.json());

// Everything here is a small local file, so correctness beats caching. Without
// this the browser can keep serving a stale stylesheet or script from memory
// after an edit, leaving the page looking unchanged.
const staticOptions = {
  etag: true,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
};

app.use(express.static(path.join(root, 'public'), staticOptions));
app.use('/lib', express.static(path.join(root, 'lib'), staticOptions));
// In production nginx serves landing/ itself and requests never arrive here.
// This is for running without a proxy, where the 404 page below would otherwise
// be handed to a browser that cannot fetch the stylesheet it asks for.
app.use('/landing', express.static(path.join(root, 'landing'), staticOptions));

// The landing page's three calls to action point at /app, and so does the
// recovery link on the 404 page. In production nginx maps that to the ledger
// and this never runs; served from here, as the mount above exists to allow,
// every one of them answered with the 404 page - including the one on the 404
// page itself. Same file the static mount serves at /, so there is one ledger
// at two paths rather than a redirect that argues with the link.
app.get('/app', (_req, res, next) => {
  res.sendFile(path.join(root, 'public', 'index.html'), (err) => {
    if (err) next(err);
  });
});

// API responses carried an ETag but no Cache-Control, which let the browser
// heuristically cache them and show a stale ledger after a change. These are
// live figures, so they must never be reused from cache.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ---------------------------------------------------------------- helpers */

class BadRequest extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * A save refused because a field it writes was changed by someone else since
 * the form was opened. Carries the row as it is now, so the page can show it.
 */
class Conflict extends Error {
  // `view` is how the row is sent back: a trade with its derived figures, a
  // wallet as it is stored.
  constructor(message, field, current, view = (row) => withDerived(row)) {
    super(message);
    this.field = field;
    this.current = current;
    this.view = view;
  }
}

/**
 * The fields of `patch` that someone else has changed since the form was
 * opened, read against `base`: what the page says those fields held then.
 *
 * Last write won. A Sold card left open on the Mac while the same sale was
 * corrected on the phone saved over the correction, with nothing said. The
 * trade's own `updated_at` cannot be the test: the server writes rows itself -
 * the hourly rate refresher fills a rate in - and a save would then be refused
 * for a change nobody made. So it is field by field, and only the fields this
 * save writes: an edit to another stage, or a rate filled in, is no conflict.
 * A caller that sends no `base` - an older page, a script - is not checked.
 */
function changedSince(base, patch, current) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return null;
  const same = (a, b) => (a ?? null) === (b ?? null);
  return Object.keys(patch).find((k) => Object.prototype.hasOwnProperty.call(base, k) && !same(current[k], base[k])) ?? null;
}

function conflictMessage(key, current) {
  const v = current[key];
  const now =
    key === 'wallet_id'
      ? walletNow(v)
      : v == null || v === ''
        ? 'blank'
        : typeof v === 'number'
          ? v.toLocaleString('en-US', { maximumFractionDigits: 8 })
          : String(v);
  return (
    `${labelOf(key, current)} was changed elsewhere after this form was opened: it is now ${now}. ` +
    'Your figures are still here; save again to replace it.'
  );
}

// A wallet is named in a conflict, never by its id: "it is now 3" says nothing.
function walletNow(id) {
  if (id == null) return 'no wallet';
  const w = prepare('SELECT name FROM wallets WHERE id = ?').get(id);
  return w ? `"${w.name}"` : `wallet #${id}`;
}

/**
 * The wallet a request links a trade to: null to unlink, or the id of a saved
 * wallet. Only a whole number, sent as one or as its digits - "1.5", "3abc"
 * and true were not ids, and SQLite would have stored the text and refused it
 * only as a foreign key, unreadably.
 */
function walletIdIn(raw) {
  if (isBlank(raw)) return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const id = /^[1-9]\d{0,15}$/.test(text) ? Number(text) : null;
  if (id === null || !Number.isSafeInteger(id) || !prepare('SELECT 1 FROM wallets WHERE id = ?').get(id)) {
    throw new BadRequest('Pick one of your saved wallets.', 'wallet_id');
  }
  return id;
}

// A value of only whitespace is blank, not zero. Untrimmed, `toNumber(' ')`
// cleaned it to '' and `Number('')` made it 0, so a mistyped APR was stored as
// a silent 0% loan.
const isBlank = (v) =>
  v === undefined || v === null || (typeof v === 'string' ? v.trim() === '' : v === '');

const REQUIRED_BORROW = [
  ['borrow_date', 'Borrow date'],
  ['borrow_amount', 'Borrow amount'],
  ['borrow_currency', 'Currency'],
  ['borrow_apr', 'Borrow APR'],
  ['platform', 'Platform'],
];

function toNumber(value, field, label, { allowZero = false, money = false } = {}) {
  // Same parser the browser uses, so the two can no longer disagree about what
  // a value means: "1e5" was 15 in the form and 100000 here.
  const n = parseAmount(value);
  if (n === null) throw new BadRequest(`${label} must be a number.`, field);
  if (allowZero ? n < 0 : n <= 0) {
    throw new BadRequest(
      `${label} must be ${allowZero ? 'zero or more' : 'greater than zero'}.`,
      field,
    );
  }
  if (n > FIGURE_MAX) throw new BadRequest('That looks like a slipped digit.', field);
  // An amount of the coin is printed to the cent, and `derive` works from the
  // printed figure, so one that prints as 0.00 is zero however it was typed:
  // 0.004 USDC for 0.000002 ETH passed "greater than zero" and the price check
  // on its raw figures, and was saved as ETH bought at $0.00.
  if (money && cents(n) === 0) throw new BadRequest(`${label} must be at least 0.01.`, field);
  return n;
}

function toDate(value, field, label) {
  // Text only. `String()` on an object with a `toString` key threw, and the
  // request was answered 500 with a stack in the log instead of a 400.
  if (typeof value !== 'string') throw new BadRequest(`${label} must be a valid date.`, field);
  const iso = value.trim();
  const ts = parseDate(iso);
  if (ts === null) throw new BadRequest(`${label} must be a valid date.`, field);
  // One calendar day of slack, counted in calendar days and no more. The old
  // 36 hour slack was measured from `Date.now()` while `parseDate` returns UTC
  // midnight, so it was never the bound it claimed to be. Then the check was
  // tightened to the server's own today, assuming the browser and the server
  // were one machine - which in production they are not: a reader in Rome with
  // the service on UTC is a day ahead of it from midnight to two, and the
  // form's own default date was refused as being in the future.
  //
  // No timezone is more than a day ahead of another, so tomorrow by the
  // server's clock is the latest anyone's today can be, and the form still
  // caps the date at the reader's own today. The negative span the tighter
  // check prevented only exists by the server's clock, for those hours: the
  // browser derives with its own date and never sees it, and on the server
  // `accruedInterest` answers null for a negative span, so a Telegram report
  // in that window says the gain is unknown rather than printing a wrong one.
  const now = parseDate(todayISO());
  const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);
  if (iso > tomorrow) {
    throw new BadRequest(`${label} cannot be in the future.`, field);
  }
  if (ts < Date.UTC(2015, 6, 30)) {
    throw new BadRequest(`${label} is before Ethereum existed. Check the year.`, field);
  }
  return iso;
}

/**
 * Normalise an incoming payload into database columns.
 * Only keys actually present are returned, so PATCH can send one stage.
 * A key sent as null or '' clears that column, which is how a stage is undone.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

function normalise(body, { requireBorrow, asset = null }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  const numericField = (key, label, opts) => {
    if (!has(key)) return;
    out[key] = isBlank(body[key]) ? null : toNumber(body[key], key, label, opts);
  };
  const dateField = (key, label) => {
    if (!has(key)) return;
    out[key] = isBlank(body[key]) ? null : toDate(body[key], key, label);
  };

  dateField('borrow_date', 'Borrow date');
  numericField('borrow_amount', 'Borrow amount', { money: true });
  // A promotional or incentivised borrow really can sit at 0%.
  numericField('borrow_apr', 'Borrow APR', { allowZero: true });
  // Gas can genuinely be nothing - a sponsored or batched transaction - so 0
  // is a figure. Blank is stored as NULL, not recorded, on the borrow and the
  // repayment; `checkSwapFee` refuses it on a swap being written.
  numericField('borrow_gas_usd', 'Borrow gas fee', { allowZero: true });
  if (has('borrow_currency')) {
    const c = typeof body.borrow_currency === 'string' ? body.borrow_currency.toUpperCase() : '';
    if (!CURRENCIES.includes(c)) throw new BadRequest('Pick a supported currency.', 'borrow_currency');
    out.borrow_currency = c;
  }
  // Blank falls through to the required check below, which names the field;
  // anything else has to be one of the platforms, by id, in any case.
  if (has('platform')) {
    if (isBlank(body.platform)) out.platform = null;
    else {
      const p = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : '';
      if (!PLATFORMS.includes(p)) throw new BadRequest('Pick a platform.', 'platform');
      out.platform = p;
    }
  }

  // Optional: blank unlinks the trade from its wallet.
  if (has('wallet_id')) out.wallet_id = walletIdIn(body.wallet_id);

  // One of ASSETS, by id in any case. Never blank: the column is NOT NULL and a
  // purchase is always of something. Absent on a new trade, it starts on ETH
  // as the picker does (the column's default).
  if (has('asset')) {
    const a = typeof body.asset === 'string' ? body.asset.trim().toLowerCase() : '';
    if (!ASSETS.includes(a)) throw new BadRequest('Pick an asset.', 'asset');
    out.asset = a;
  }
  // The quantities are named for the asset they count: the one this request
  // sets, else the trade's own (`asset`, read by the caller), else ETH.
  const ticker = ASSET_META[out.asset ?? (ASSETS.includes(asset) ? asset : ASSETS[0])].ticker;

  dateField('buy_date', 'Purchase date');
  numericField('buy_amount', 'Purchase amount', { money: true });
  numericField('buy_eth', `${ticker} purchased`);
  numericField('buy_gas_usd', SWAP_FEE, { allowZero: true });
  // Optional: not every loop supplies the ETH (or cbBTC) on Aave, so blank is accepted.
  numericField('buy_lend_gas_usd', 'Lending gas fee', { allowZero: true });

  dateField('sell_date', 'Sale date');
  numericField('sell_amount', 'Sale amount', { money: true });
  numericField('sell_eth', `${ticker} sold`);
  numericField('sell_gas_usd', SWAP_FEE, { allowZero: true });
  numericField('sell_unstake_gas_usd', 'Unstaking gas fee', { allowZero: true });

  // A quantity prints to its asset's places, so one that prints 0.0000 is no
  // quantity on its card: 0.00004 ETH for 0.12 USDC was saved, and read
  // "Bought 0.0000 ETH" at $3,000.00 - the quantity's side of the amounts
  // refused above for printing 0.00.
  const assetKey = out.asset ?? (ASSETS.includes(asset) ? asset : ASSETS[0]);
  const dp = ASSET_META[assetKey].dp;
  for (const [key, verb] of [['buy_eth', 'purchased'], ['sell_eth', 'sold']]) {
    if (typeof out[key] === 'number' && qtyAsPrinted(out[key], assetKey) === 0) {
      throw new BadRequest(`${ticker} ${verb} must be at least ${(10 ** -dp).toFixed(dp)}.`, key);
    }
  }

  dateField('repay_date', 'Repayment date');
  numericField('repay_amount', 'Repaid amount', { money: true });
  numericField('repay_gas_usd', 'Repayment gas fee', { allowZero: true });

  if (has('notes')) {
    // Text or nothing. Anything else was coerced - {"a":1} stored as
    // "[object Object]" - or threw on a `toString` key and answered 500.
    if (!isBlank(body.notes) && typeof body.notes !== 'string') {
      throw new BadRequest('Notes must be text.', 'notes');
    }
    // Cut by visible character, not by UTF-16 unit or code point: `slice`
    // split an emoji at the 2000th unit and stored half of it, which read back
    // as three U+FFFD, and a cut by code point still split a flag or a
    // skin-toned emoji into a stray letter.
    out.notes = isBlank(body.notes)
      ? null
      : [...GRAPHEMES.segment(body.notes)].slice(0, 2000).map((g) => g.segment).join('');
  }

  // Exchange rates are resolved here from a published source, never accepted
  // from the caller. A request that could set its own rate could move every
  // dollar figure in the ledger without touching a single amount.
  for (const stage of FX_STAGES) {
    for (const key of [`${stage}_fx`, `${stage}_fx_date`]) {
      if (has(key)) throw new BadRequest('Exchange rates are looked up, not submitted.', key);
    }
  }
  if (has('fx_source')) throw new BadRequest('Exchange rates are looked up, not submitted.', 'fx_source');

  for (const [key, label] of REQUIRED_BORROW) {
    // On create the field has to be there. On update it may be absent, but if
    // it was sent it cannot be blanked: the column is NOT NULL, so clearing it
    // used to fail deep in SQLite as an opaque 500.
    if (requireBorrow ? isBlank(out[key]) : has(key) && isBlank(out[key])) {
      throw new BadRequest(`${label} is required.`, key);
    }
  }

  // APR is a percentage, not a fraction. Reject an obviously wrong magnitude.
  if (out.borrow_apr != null && out.borrow_apr > 100) {
    throw new BadRequest('APR looks too high. Enter it as a percent, for example 4.27.', 'borrow_apr');
  }

  return out;
}

/** A stage cannot be dated before the loan that funded it. */
function checkChronology(row) {
  const ticker = assetMeta(row).ticker;
  const order = [
    ['buy_date', 'The purchase'],
    ['sell_date', 'The sale'],
    ['repay_date', 'The repayment'],
  ];
  for (const [key, label] of order) {
    if (row[key] && parseDate(row[key]) < parseDate(row.borrow_date)) {
      throw new BadRequest(`${label} cannot be dated before the borrow.`, key);
    }
  }
  if (row.sell_date && row.buy_date && parseDate(row.sell_date) < parseDate(row.buy_date)) {
    throw new BadRequest('The sale cannot be dated before the purchase.', 'sell_date');
  }
  if (row.repay_date && row.sell_date && parseDate(row.repay_date) < parseDate(row.sell_date)) {
    throw new BadRequest('The repayment cannot be dated before the sale.', 'repay_date');
  }
  // The interface only opens a stage once the previous one is filled in. The
  // API enforces the same order, otherwise a trade can reach states the maths
  // has no answer for, such as repaid without ever having been sold.
  if (row.sell_date != null && row.buy_date == null) {
    throw new BadRequest(`Record the ${ticker} purchase before the sale.`, 'sell_date');
  }
  if (row.repay_date != null && row.sell_date == null) {
    throw new BadRequest(`Record the ${ticker} sale before the repayment.`, 'repay_date');
  }

  // Those checks only look at the dates. Clearing `buy_amount` or `sell_eth`
  // through the API left a row still labelled CLOSED whose net gain had become
  // null, so it silently dropped out of every realized total while being
  // counted as an open position. A stage counts as filled only when its
  // amounts are there too.
  const st = stages(row);
  if (st.sold && !st.bought) {
    throw new BadRequest(`Record the ${ticker} purchase before the sale.`, 'buy_amount');
  }
  if (st.repaid && !st.sold) {
    throw new BadRequest(`Record the ${ticker} sale before the repayment.`, 'sell_amount');
  }

  if (row.sell_eth != null && row.buy_eth != null && row.sell_eth > row.buy_eth * SELL_OVER_BUY) {
    throw new BadRequest(`That is more than 10% above the ${ticker} you bought.`, 'sell_eth');
  }

  if (row.repay_amount != null && row.borrow_amount != null) {
    // Repaying less than the principal made the implied interest negative,
    // which the net gain then counted as profit. A $20,000 repayment on a
    // $32,000 loan reported a $12,000 gain out of nowhere.
    // Compared as printed, in whole cents, because that is how `derive` takes
    // them: a raw 0.005 of slack let 10,000.00 repay a 10,000.005 loan, which
    // the cards print as 10,000.01 - interest of -$0.01 and a flat trade
    // scored a win.
    //
    // Quoted as printed too, to the cent as the card and the form show it: the
    // default format quoted a loan typed as 10,000.005 as "10,000.005", a
    // figure shown nowhere else.
    const loan = row.borrow_amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (cents(row.repay_amount) < cents(row.borrow_amount)) {
      throw new BadRequest(
        `A repayment cannot be less than the ${loan} borrowed.`,
        'repay_amount',
      );
    }
    // Interest can never double a loan over the spans this tracks, so a figure
    // that far out is a slipped digit rather than a real number.
    if (row.repay_amount > row.borrow_amount * 2) {
      throw new BadRequest(
        `That is a long way above the ${loan} borrowed. Check the figure.`,
        'repay_amount',
      );
    }
  }
}

/**
 * A swap costs something - gas, and the DEX or aggregator's own fee - so a
 * purchase or a sale being written has to say how much. The borrow and the
 * repayment may leave their gas blank, as not recorded.
 *
 * Scoped to the stages this request touches. Trades recorded before fees were
 * asked for have none, and requiring both on every write would refuse a sale
 * on such a trade until its purchase, long since done, was edited too. A swap
 * this request writes and that ends up reached must leave with a cost;
 * clearing a stage altogether needs none, since it is no longer reached.
 */
const SWAP_FEE = 'Costs & Fees (swap)';
const SWAP_KEYS = {
  buy: ['buy_date', 'buy_amount', 'buy_eth'],
  sell: ['sell_date', 'sell_amount', 'sell_eth'],
};

function checkSwapFee(patch, row) {
  // A Solana platform's trade records no gas, swap costs included (`tracksGas`).
  if (!tracksGas(row)) return;
  const reached = new Set(reachedStages(stages(row)));
  for (const [stage, keys] of Object.entries(SWAP_KEYS)) {
    const key = gasKey(stage);
    const touched = [...keys, key].some((k) => k in patch);
    if (touched && reached.has(stage) && row[key] == null) {
      throw new BadRequest(`${SWAP_FEE} is required.`, key);
    }
  }
}

/**
 * The price a purchase or sale implies, per ETH or per cbBTC, has to be one it
 * could trade at (`unitPriceInRange`, its asset's own range). Scoped to the stages this request writes,
 * like `checkSwapFee`, so a row saved before the check existed is not refused
 * an unrelated edit - and to a change of asset, which changes what the price
 * is a price of.
 */
function checkUnitPrice(patch, row, current = null) {
  const ticker = assetMeta(row).ticker;
  // A change of asset, not its mere presence: the Bought form always sends the
  // asset it shows, so editing a purchase's fee re-checked the sale's price,
  // and an old row's refused the edit with an error about a field not in it.
  const assetChanged = 'asset' in patch && (current === null || patch.asset !== assetOf(current));
  for (const stage of ['buy', 'sell']) {
    const [amountKey, ethKey] = [`${stage}_amount`, `${stage}_eth`];
    if (!(amountKey in patch || ethKey in patch || assetChanged)) continue;
    if (row[amountKey] == null || row[ethKey] == null) continue;
    // From the amount as printed, as `derive` works out the price the card shows.
    const price = asPrinted(row[amountKey]) / row[ethKey];
    if (!unitPriceInRange(price, assetOf(row))) {
      const shown = price.toLocaleString('en-US', { maximumSignificantDigits: 4 });
      throw new BadRequest(
        `That is ${shown} ${row.borrow_currency} per ${ticker}. Check the amount and the ${ticker}.`,
        ethKey,
      );
    }
  }
}

const withDerived = (row) => ({ ...row, derived: derive(row) });

/**
 * A row id from the path: digits, as the page writes them, or null. Read with
 * `Number()`, "0x1", "1e0", "+1" and "1.0" were all trade 1, so a malformed id
 * edited, armed or deleted a real row rather than finding nothing.
 */
function idParam(raw) {
  const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * One writer at a time per trade.
 *
 * PATCH became asynchronous when rate lookups moved into it, so two requests
 * for the same trade now interleave across the await: the second reads the row
 * before the first has written, decides which rates are stale from that older
 * snapshot, and answers the browser with a row missing the change the first one
 * just made. Two tabs, or a rate backfill overlapping an edit, is enough.
 */
const tradeLocks = new Map();

function withTradeLock(id, fn) {
  const run = (tradeLocks.get(id) ?? Promise.resolve()).then(() => fn());
  // The next waiter must not inherit this one's rejection.
  const tail = run.then(
    () => {},
    () => {},
  );
  tradeLocks.set(id, tail);
  tail.then(() => {
    if (tradeLocks.get(id) === tail) tradeLocks.delete(id);
  });
  return run;
}

const selectAll = prepare('SELECT * FROM trades ORDER BY borrow_date DESC, id DESC');
const selectOne = prepare('SELECT * FROM trades WHERE id = ?');

/* ------------------------------------------------------------------ routes */

app.get('/api/version', (_req, res) => res.json({ version: pkg.version }));

app.get('/api/trades', (_req, res) => {
  res.json(selectAll.all().map(withDerived));
});

app.get('/api/summary', (_req, res) => {
  res.json(summaryReport(selectAll.all()));
});

app.post('/api/trades', async (req, res, next) => {
  try {
    const patch = normalise(req.body || {}, { requireBorrow: true });
    // Built over both lists before the INSERT names them, or better-sqlite3
    // refuses the statement for a parameter it was never handed.
    const row = Object.fromEntries([...FIELDS, ...FX_COLUMNS].map((f) => [f, patch[f] ?? null]));
    // Named, because the INSERT names every column: a NULL would not fall back
    // to the column's default, it would fail NOT NULL.
    row.asset = patch.asset ?? ASSETS[0];
    checkChronology(row);
    checkSwapFee(patch, row);
    checkUnitPrice(patch, row);
    Object.assign(row, await fillFxColumns(row));

    const now = new Date().toISOString();
    const cols = [...FIELDS, ...FX_COLUMNS, 'created_at', 'updated_at'];
    const stmt = prepare(
      `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    );
    const info = stmt.run({ ...row, created_at: now, updated_at: now });
    res.status(201).json(withDerived(selectOne.get(info.lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trades/:id', async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    if (id === null) return res.status(404).json({ error: 'Trade not found.' });
    // Validate the body before queueing, so a bad request is refused at once
    // rather than after waiting behind someone else's rate lookup.
    // The trade's asset only names the fields in an error ("cbBTC purchased
    // must be a number"); the checks below run on the row as read in the lock.
    const patch = normalise(req.body || {}, { requireBorrow: false, asset: selectOne.get(id)?.asset });

    const row = await withTradeLock(id, async () => {
      // The lock only orders writers in this process. The other copy of the
      // app can change the row while the rate lookup below is away - seconds,
      // for a euro trade - and writing regardless pinned a rate looked up for
      // the old date to the new one (`buy_fx` for 2 September on a purchase
      // moved to the 10th, never asked about again) and let a purchase be
      // moved past a sale recorded meanwhile, checked against a row that was
      // no longer the row. So the write only lands on the row it was worked
      // out from, and is worked out again from a fresh read when it was not:
      // the rates are cached by then, so the second pass is quick.
      for (let pass = 0; pass < 3; pass += 1) {
        // Read inside the lock: anything queued ahead of us has finished writing.
        const current = selectOne.get(id);
        if (!current) return null;
        if (Object.keys(patch).length === 0) return current;

        // Against the row as read here, on every pass: a field changed by the
        // other copy while this save waited is changed all the same.
        const changed = changedSince(req.body?.base, patch, current);
        if (changed) throw new Conflict(conflictMessage(changed, current), changed, current);

        const merged = { ...current, ...patch };
        checkChronology(merged);
        checkSwapFee(patch, merged);
        checkUnitPrice(patch, merged, current);

        // An edit can invalidate a rate that was right when it was stored. Clear
        // those first, then look up replacements, so the write carries the change
        // and its consequences in one statement rather than two.
        const stale = staleFxColumns(current, patch);
        Object.assign(merged, stale);
        const fresh = await fillFxColumns(merged);

        const write = { ...patch, ...stale, ...fresh };
        const keys = Object.keys(write);

        // A change of asset ends the armed alert in the same transaction as
        // the write: its goal is a price in the other market, and a sweep
        // claiming it between the two would send "BTC reached your $3,000.00
        // goal" off ETH's figure. The claim re-reads the status, so after this
        // commits it finds nothing to send.
        const assetChanged = 'asset' in patch && patch.asset !== current.asset;
        const written = db.transaction(() => {
          const info = prepare(
            `UPDATE trades SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at ` +
              'WHERE id = @id AND updated_at IS @seen',
          ).run({ ...write, updated_at: new Date().toISOString(), id: current.id, seen: current.updated_at });
          if (info.changes === 1 && assetChanged) closeForAssetChange(current.id);
          // A hash found on Etherscan from figures this edit changes no longer
          // stands for them: gone with the write that made it so. Pasted ones
          // stay (`stage_tx` in db.js).
          if (info.changes === 1) {
            const moved = TX_STAGES.filter((st) =>
              txBasis(st).some((k) => k in patch && (patch[k] ?? null) !== (current[k] ?? null)),
            );
            for (const st of moved) {
              prepare("DELETE FROM stage_tx WHERE trade_id = ? AND stage = ? AND source = 'search'").run(current.id, st);
            }
            // Moved to a wallet on another chain, or to none: a pasted hash is
            // a transaction on the old chain, and kept it was drawn as a link
            // to the new chain's explorer, a page for no such transaction.
            if ('wallet_id' in patch && chainOfWallet(patch.wallet_id) !== chainOfWallet(current.wallet_id)) {
              prepare('DELETE FROM stage_tx WHERE trade_id = ?').run(current.id);
            }
            // A stage undone takes its hash, pasted or found: kept, it stood
            // for a stage the trade no longer records, out of sight on its
            // card and read by the audit as "the purchase is 0.00".
            const after = { ...current, ...write };
            for (const st of TX_STAGES) {
              if (!stageRecorded(after, st)) prepare('DELETE FROM stage_tx WHERE trade_id = ? AND stage = ?').run(current.id, st);
            }
          }
          return info;
        }).immediate();
        if (written.changes !== 1) continue;

        // A sale just recorded ends the trade's alert, now rather than at the
        // next sweep, so the Alerts list says so as soon as it is opened.
        closeUnwatched();
        return selectOne.get(current.id);
      }
      // Overtaken three times running: the other copy is busy with this very
      // trade. Answered as the busy ledger it is, so the form says try again.
      throw Object.assign(new Error('The trade kept changing while it was being saved.'), {
        code: 'SQLITE_BUSY_RETRY',
      });
    });

    if (!row) return res.status(404).json({ error: 'Trade not found.' });
    res.json(withDerived(row));
  } catch (err) {
    next(err);
  }
});

/*
 * The rate endpoints answer 200 even when they could not reach anything. Being
 * unable to look a rate up is a result the interface is built to show, not a
 * server fault, and the browser's api() helper throws on any status that is not
 * ok, which would turn "no rate yet" into an error toast.
 */

app.get('/api/fx/rate', async (req, res, next) => {
  try {
    await rateLookup(req, res);
  } catch (err) {
    // Express 4 does not catch a rejected async handler. Without this the
    // rejection became an uncaughtException, the process exited, and the
    // request was left hanging with no response at all.
    next(err);
  }
});

async function rateLookup(req, res) {
  const currency = typeof req.query.currency === 'string' ? req.query.currency.toUpperCase() : '';
  const raw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  // The same bounds as a trade's own dates. Any parseable date was asked for:
  // one before 1999 is refused by the service, which put every rate lookup -
  // saves included - to sleep for a minute, and one in the future cached a
  // stand-in under a day that has not happened.
  let date = null;
  try {
    date = toDate(raw, 'date', 'Date');
  } catch {
    date = null;
  }
  if (!CURRENCIES.includes(currency) || date === null) {
    return res.json({ currency, date: raw, rate: null, reason: 'That is not a currency and date I can look up.' });
  }
  const hit = await resolveRate(currency, date);
  if (!hit) {
    const status = fxStatus();
    return res.json({
      currency, date, rate: null,
      reason: status.offline
        ? 'Rate lookups are switched off.'
        : status.lastError || 'No rate has been published for that date yet.',
    });
  }
  res.json({ currency, date, rate: hit.rate, rateDate: hit.rateDate, source: hit.source });
}

app.get('/api/fx/status', (_req, res) => {
  const trades = selectAll.all().map(withDerived);
  const missing = trades.filter((t) => !t.derived.fxComplete);
  res.json({
    ...fxStatus(),
    missing: {
      count: missing.length,
      tradeIds: missing.map((t) => t.id),
    },
  });
});

app.post('/api/fx/backfill', async (req, res, next) => {
  try {
    res.json(await backfillRates({ refresh: req.body?.refresh === true }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ price alerts */

/**
 * How fresh the header ticker asks for its price to be, and how often the page
 * polls for it. One number so the two cannot drift: asking more often than the
 * cache allows would return the same figure and spend a request doing it.
 *
 * Overridable for the same reason `ETHROUNDTRIP_ALERT_POLL_MS` is - five minutes is
 * a long time to sit watching a ticker to find out whether it ticks. The page
 * refuses anything under thirty seconds whatever this says.
 */
const PRICE_TICKER_MS = intervalMs(setting('ETH_POLL_MS'), 300_000);

/**
 * One quote as the page reads it: the header ticker and the alert window take
 * the same shape, so the two cannot come to show different figures for one
 * price. `stale` is `freshPrice`'s answer, the very test a goal's save and
 * the sweep apply, so the window never shows as "now" a price the save is
 * about to ignore. It was `ageMs > alertPollMs` - fifteen minutes against the
 * sweep's ten - and the window was never told: a twelve-minute-old $3,000 read
 * "ETH now", a goal of $2,800 was saved to wait for a rise from the purchase
 * price, and fired at once. An age nobody knows is stale too.
 */
function quoteView(quote) {
  if (!quote) return { price: null, fetchedAt: null, stale: true, reason: priceStatus().lastError };
  return {
    price: quote.price,
    fetchedAt: quote.fetchedAt,
    ageMs: quote.ageMs,
    stale: freshPrice(quote) === null,
    change1h: quote.change1h,
    change24h: quote.change24h,
    change7d: quote.change7d,
  };
}

/** Every market's quote, keyed by `MARKETS`, as `quoteView` gives each. */
const pricesView = (quotes) => Object.fromEntries(MARKETS.map((m) => [m, quoteView(quotes[m])]));

/**
 * Everything the alert window needs, in one call: whether there is anywhere to
 * send a message, what each market last cost, and every alert keyed by its
 * trade.
 *
 * `alerts` is the *armed* ones, keyed by trade, which is what the bell on a
 * card reads. A trade can have many alerts now that a fired one is kept, so a
 * map keyed by trade is only well defined for the one status it can have at
 * most one of. The whole list lives at /api/alerts/log.
 *
 * The bot token and the chat id are not in here and must never be. The browser
 * needs to know that sending works and what the chat is called; it has no use
 * for the credentials, and this server answers anything that can reach
 * loopback.
 */
app.get('/api/alerts', async (req, res, next) => {
  try {
    // `refresh` asks for a price fetched now rather than whatever the last
    // sweep left behind. The window opening is the one moment that figure is
    // read by a person and compared against a goal, and on a ledger with no
    // armed alerts nothing has asked for a price in hours. Page load does not
    // send it, because a boot should not wait on an outside service.
    //
    // Its answer is used, rather than the cache read back after it: a write to
    // the cache that was refused left the window on a price from days before.
    const quotes = req.query.refresh === '1' ? await marketPrices() : cachedMarketPrices();

    const { configured, chatName, reason } = telegramConfig();
    res.json({
      // The file's own name, for the window's "once ... is filled in": it named
      // config.env whatever ETHROUNDTRIP_CONFIG pointed at. Not the path.
      config: { configured, chatName, reason, file: path.basename(configPath) },
      // The change windows ride along, so this answer can feed the header
      // ticker as well as the window. Without them the page had two sources
      // for one price: opening the bell refreshes at a tighter freshness than
      // the ticker polls at, so the window showed $3,333 while the header
      // beside it still said $3,000.
      prices: pricesView(quotes),
      alerts: armedAlerts(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * What every market costs, for the ticker in the page header (BTC, ETH and
 * SOL, `TICKER_MARKETS`) and every estimate (WBTC's and PSOL's too): `{ pollMs,
 * prices }`, keyed by `MARKETS`, one quote per market in the shape `quoteView` gives. It was
 * /api/eth while ETH was the only one.
 *
 * Its own route rather than a field on /api/alerts, which is the same argument
 * that split the alert log out below: that one carries the armed-alert map and
 * the Telegram configuration, and a header that asks every five minutes has no
 * use for either. It also strips the change windows, which are the whole point
 * here.
 *
 * `maxAgeMs` is the refresh interval the page polls at, so a cached price is
 * served without a fetch and this endpoint reaches the price service at most
 * once in five minutes however many tabs are open - `marketPrices` shares one
 * request between concurrent callers and caches the answer on disk, and the
 * alert sweep asks on the same window. Going past the free tier's limit would
 * not just stop the ticker: a 429 parks the whole module for ten minutes and
 * takes the alert sweep's price lookups with it.
 */
app.get('/api/prices', async (_req, res, next) => {
  try {
    const quotes = await marketPrices({ maxAgeMs: PRICE_TICKER_MS });
    // `pollMs` is served rather than written into the page, so the cadence the
    // browser polls at and the freshness this endpoint enforces are one number.
    res.json({ pollMs: PRICE_TICKER_MS, prices: pricesView(quotes) });
  } catch (err) {
    next(err);
  }
});

/**
 * Every alert ever set, newest first, for the Alerts view.
 *
 * Its own call rather than a field on the one above: that one is fetched at
 * boot and again every time the alert window opens, where `refresh` sends it
 * to the price service, and a tab sitting on the Alerts view has no business
 * doing that. Its map is also keyed by trade, which a history of several
 * alerts on one trade cannot be.
 */
app.get('/api/alerts/log', (_req, res) => res.json({ alerts: alertLog() }));

/**
 * Set the goal price for a trade. Scoped to the trade, because that is what a
 * goal belongs to, and a PUT because a trade has one *armed* alert: saving the
 * same goal twice is the same ledger either way.
 *
 * Everything under /api/alerts is scoped to an alert instead, now that they
 * have ids of their own. Moving this rather than redefining
 * `DELETE /api/alerts/:id` is deliberate: a browser tab left open from before
 * the change still holds the old script, and its delete would otherwise have
 * removed a different trade's alert and answered 204. This way it 404s.
 */
/**
 * A goal ETH or BTC could plausibly be asked to reach, in dollars. Under a dollar was
 * saved and armed - "fell to your $0.00 goal", a goal that never fires - and
 * the preview rendered goals above the ceiling that the save then refused.
 */
const goalInRange = priceInRange;

app.put('/api/trades/:id/alert', async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    const trade = id === null ? undefined : selectOne.get(id);
    if (!trade) return res.status(404).json({ error: 'Trade not found.' });

    const { ticker } = assetMeta(trade);
    if (derive(trade).status !== STATUS.HOLDING) {
      throw new BadRequest(`A price alert only applies while the ${ticker} is held.`, 'goal_price');
    }

    // The same parser the browser uses, so "3,000" cannot mean one thing in
    // the form and another here.
    // To the cent, as every place that shows a goal prints it: kept whole,
    // 3449.996 was shown as $3,450.00 and did not fire with ETH at $3,450.00
    // from below, so the goal on screen was not the goal being watched.
    // A goal is a price in the trade's market: BTC's for a cbBTC trade.
    const market = marketOf(trade);
    // The window sends the market it was drawn in. One opened while the trade
    // held ETH and saved after its asset became cbBTC elsewhere stored the
    // $3,500 typed as an ETH goal as a BTC one, which fired at once. Optional,
    // so a caller that names no market is held to the trade's, as before.
    if (req.body?.market != null && req.body.market !== market) {
      throw new BadRequest('The trade changed since this window opened. Close it and open it again.', 'goal_price');
    }
    const goal = asPrinted(toNumber(req.body?.goal_price, 'goal_price', `${market} goal price`));
    if (!goalInRange(goal)) {
      throw new BadRequest('That looks like a slipped digit. The price is in dollars.', 'goal_price');
    }

    // Before the save, not after: the direction is decided from this price, so
    // a goal set while the last quote is hours old would be read against the
    // wrong side of the market. `marketPrice` never throws and falls back to
    // the cache, so an unreachable service costs a moment and nothing else.
    const quote = await marketPrice(market);

    // Asked again after the wait, which can be seconds: a sale recorded in the
    // meantime still had a goal saved on it - an armed alert on a sold trade -
    // and a delete made the insert fail its foreign key and answer 500.
    const live = selectOne.get(id);
    if (!live) return res.status(404).json({ error: 'Trade not found.' });
    if (derive(live).status !== STATUS.HOLDING) {
      throw new BadRequest(`A price alert only applies while the ${ticker} is held.`, 'goal_price');
    }
    // Nor across a change of asset meanwhile: the price read above was the
    // other market's, and the goal was typed against it.
    if (marketOf(live) !== market) {
      throw new BadRequest('The trade changed while the alert was being saved. Try again.', 'goal_price');
    }
    // A stale quote is no price: the direction comes from what was paid, as
    // it does when no price could be had at all (`freshPrice`).
    const saved = saveAlert(live, goal, freshPrice(quote));
    // A second copy of the app can still sell it between that read and this
    // save; the sweep would close the alert, but there is no reason to wait.
    closeUnwatched();
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

/** One alert, by its own id. */
app.delete('/api/alerts/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (id === null || !deleteAlert(id)) {
    return res.status(404).json({ error: 'No such alert.' });
  }
  res.status(204).end();
});

/**
 * Everything, armed ones included. Answers with the count rather than 204,
 * because the only honest thing the interface can say afterwards is how many
 * went.
 *
 * A sweep can be away at Telegram while this lands. Its follow-up write then
 * matches nothing, which is correct: the message was already sent, and there is
 * no row left to record that on.
 */
//
// A strict path. Express routes ignore a trailing slash by default, so
// `DELETE /api/alerts/` - an alert id that came out empty - matched this rather
// than `/api/alerts/:id` and deleted every alert. It now falls to the JSON 404.
//
// `?through=<id>` deletes only up to the newest alert the page showed (see
// `deleteAllAlerts`). Digits only, like a trade id; anything else is refused
// rather than read as "everything".
app.delete(/^\/api\/alerts$/i, (req, res) => {
  const raw = req.query.through;
  if (raw !== undefined && !(typeof raw === 'string' && /^[1-9]\d*$/.test(raw))) {
    throw new BadRequest('Not an alert id.', 'through');
  }
  res.json({ deleted: deleteAllAlerts(raw === undefined ? null : Number(raw)) });
});

/*
 * A dry run. Proving the token and the chat id are right by waiting for ETH to
 * move is no way to find out they are wrong, so this sends one message now.
 *
 * It answers 200 even when the send fails, for the same reason the rate
 * endpoints above do: "Telegram would not take it" is a result this interface
 * is built to show, not a fault in this server.
 */
let lastTestAt = 0;
const TEST_EVERY_MS = 10_000;

app.post('/api/alerts/test', async (req, res, next) => {
  try {
    const since = Date.now() - lastTestAt;
    if (since < TEST_EVERY_MS) {
      return res.json({ ok: false, error: 'Give it a few seconds before testing again.' });
    }
    lastTestAt = Date.now();

    const { chatName } = telegramConfig();
    const sent = await sendTelegramMessage(
      `Test message from the ETH Roundtrip ledger. Price alerts will arrive here, in ${chatName}.`,
    );
    res.json({ ok: sent.ok, error: sent.error });
  } catch (err) {
    next(err);
  }
});

/**
 * The message a goal would send, shown in the window while it is being typed.
 *
 * Takes the goal as a query rather than reading a saved alert, because the
 * moment it is most worth reading is before anything has been saved. Answers
 * 200 with a null text when the goal is not a number yet, since a half typed
 * figure is an ordinary state of a form and not an error.
 */
app.get('/api/trades/:id/alert/preview', (req, res) => {
  const id = idParam(req.params.id);
  const trade = id === null ? undefined : selectOne.get(id);
  if (!trade) return res.status(404).json({ error: 'Trade not found.' });

  // To the cent, as the save takes it.
  const goal = asPrinted(parseAmount(req.query.goal));
  // The save's own bounds, so the window never previews a goal it would refuse
  // - the trade's as well as the goal's. Without the status test a trade sold
  // while the window was open went on previewing a message the save then
  // refused, and one with no purchase read "Bought: - ETH".
  // Nor a goal typed in another market than the trade's now (see the save).
  const asked = req.query.market;
  if (
    goal === null ||
    !goalInRange(goal) ||
    derive(trade).status !== STATUS.HOLDING ||
    (asked != null && asked !== '' && asked !== marketOf(trade))
  ) {
    return res.json({ text: null });
  }

  // The live price only settles which way the alert reads; the message itself
  // is written at the goal, because that is the position it will describe when
  // it goes out. Quoting today's price in it read as a contradiction.
  res.json({ text: previewMessage(trade, goal, cachedMarketPrice(marketOf(trade))?.price ?? null) });
});

app.delete('/api/trades/:id', (req, res) => {
  const id = idParam(req.params.id);
  const info = id === null ? { changes: 0 } : prepare('DELETE FROM trades WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Trade not found.' });
  res.status(204).end();
});

/* ---------------------------------------------------------------- wallets */

/*
 * The addresses kept on the Wallets tab (`wallets` in db.js). Each write runs in an
 * immediate transaction, so its checks for a duplicate and the write itself
 * hold the write lock together: the other copy of the app cannot save the same
 * address, or the same name, between the two, and a duplicate is answered with
 * the sentence below rather than a constraint error as a 500.
 */
const selectWallets = prepare('SELECT * FROM wallets ORDER BY name COLLATE NOCASE, id');
const selectWallet = prepare('SELECT * FROM wallets WHERE id = ?');
const walletAt = prepare('SELECT * FROM wallets WHERE network = ? AND address = ?');
const walletNamed = prepare('SELECT * FROM wallets WHERE name = ? COLLATE NOCASE');

const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/** The name a request asks for, as it is stored, or a 400 naming the field. */
function walletNameIn(body) {
  const error = walletNameError(body.name);
  if (error) throw new BadRequest(error, 'name');
  return walletName(body.name);
}

/** Names are how a wallet will be picked, so two cannot share one in any case. */
function refuseTakenName(name, ownId) {
  const other = walletNamed.get(name);
  if (other && other.id !== ownId) throw new BadRequest(`Another address is already called "${other.name}".`, 'name');
}

app.get('/api/wallets', (_req, res) => res.json({ wallets: selectWallets.all() }));

app.post('/api/wallets', (req, res) => {
  const body = bodyOf(req);
  const network =
    body.network === undefined ? NETWORKS[0] : typeof body.network === 'string' ? body.network.trim().toLowerCase() : '';
  // Absent is Ethereum, for a caller from before chains could be picked; the
  // page's form makes its reader pick one.
  if (!NETWORKS.includes(network)) {
    throw new BadRequest(`Pick a chain: ${NETWORKS.map((n) => NETWORK_META[n].label).join(', ')}.`, 'network');
  }
  // In the form's order, so the first field it flags is the first one wrong.
  // The chain first: it says how the address is read (base58 on Solana).
  const name = walletNameIn(body);
  const parsed = parseAddress(body.address, network);
  if (parsed.error) throw new BadRequest(parsed.error, 'address');

  const row = db
    .transaction(() => {
      const same = walletAt.get(network, parsed.address);
      if (same) {
        throw new BadRequest(`That address is already saved on ${NETWORK_META[network].label}, as "${same.name}".`, 'address');
      }
      refuseTakenName(name, null);
      const now = new Date().toISOString();
      const info = prepare(
        'INSERT INTO wallets (network, address, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(network, parsed.address, name, now, now);
      return selectWallet.get(info.lastInsertRowid);
    })
    .immediate();
  res.status(201).json(row);
});

/**
 * A new name, and nothing else. The address is what trades will be linked by,
 * so changing it in place would move every one of them to another wallet
 * unseen: it is deleted and added again instead.
 *
 * `base` is the name the page showed when Rename was pressed. Renamed in the
 * meantime from another tab, the save is refused with the name as it is now,
 * as a stage save is (`changedSince`), rather than writing over it unseen.
 */
app.patch('/api/wallets/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (id === null) return res.status(404).json({ error: 'No such address.' });
  const body = bodyOf(req);
  for (const key of ['address', 'network']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new BadRequest("An address can't be changed: delete it and add it again.", key);
    }
  }
  const name = walletNameIn(body);
  const base = body.base && typeof body.base === 'object' && !Array.isArray(body.base) ? body.base : null;

  const row = db
    .transaction(() => {
      const current = selectWallet.get(id);
      if (!current) return null;
      if (base && Object.prototype.hasOwnProperty.call(base, 'name') && base.name !== current.name) {
        throw new Conflict(
          `This address was renamed elsewhere after you pressed Rename: it is now "${current.name}". ` +
            'Your name is still here; save again to replace it.',
          'name',
          current,
          (r) => r,
        );
      }
      if (name === current.name) return current;
      refuseTakenName(name, id);
      prepare('UPDATE wallets SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), id);
      return selectWallet.get(id);
    })
    .immediate();
  if (!row) return res.status(404).json({ error: 'No such address.' });
  res.json(row);
});

/**
 * Refused while a trade is linked to the wallet: the trade would lose it
 * unseen. Said in words, naming the trades, inside the same immediate
 * transaction as the delete; the foreign key on `trades.wallet_id` still holds
 * if the other copy links one in between (the error handler answers that).
 */
app.delete('/api/wallets/:id', (req, res) => {
  const id = idParam(req.params.id);
  const gone = () => res.status(404).json({ error: 'No such address.' });
  if (id === null) return gone();
  const deleted = db
    .transaction(() => {
      const w = selectWallet.get(id);
      if (!w) return false;
      const used = prepare('SELECT id FROM trades WHERE wallet_id = ? ORDER BY id DESC').all(id).map((t) => t.id);
      if (used.length) {
        const shown = used.slice(0, 5).map((t) => `#${t}`).join(', ');
        const more = used.length > 5 ? ` and ${used.length - 5} more` : '';
        throw new Conflict(
          `${w.name} is linked to ${used.length} trade${used.length === 1 ? '' : 's'} (${shown}${more}). ` +
            'Pick another wallet, or none, on their Borrowed card first.',
          'wallet_id',
          { ...w, trades: used.length },
          (r) => r,
        );
      }
      return prepare('DELETE FROM wallets WHERE id = ?').run(id).changes === 1;
    })
    .immediate();
  if (!deleted) return gone();
  res.status(204).end();
});

/* ----------------------------------------------------------- transactions */

/*
 * The transaction behind each stage of a trade (`stage_tx` in db.js), for
 * Wallets > Onchain Data: found on Etherscan once and kept, or pasted.
 */
const selectStageTx = prepare('SELECT * FROM stage_tx WHERE trade_id = ? AND stage = ?');
const txView = (row) => ({ hash: row.hash, source: row.source, found_at: row.found_at });
const STAGE_NAMES = { borrow: 'loan', buy: 'purchase', sell: 'sale', repay: 'repayment' };

app.get('/api/stage-txs', (_req, res) => {
  const out = {};
  for (const row of prepare('SELECT * FROM stage_tx').all()) {
    (out[row.trade_id] ??= {})[row.stage] = txView(row);
  }
  res.json(out);
});

/** The trade and stage a request names, or null after answering 404. */
function txTarget(req, res) {
  const id = idParam(req.params.id);
  const stage = req.params.stage;
  const trade = id === null || !TX_STAGES.includes(stage) ? null : selectOne.get(id);
  if (!trade) {
    res.status(404).json({ error: 'No such trade or stage.' });
    return null;
  }
  return { trade, stage };
}

/**
 * The hashes other trades already hold, at any stage: never offered again. A
 * transaction is one stage of one trade; excluded only from the same stage,
 * one trade's purchase was linked as another's repayment.
 */
function claimedHashes(tradeId) {
  return new Set(prepare('SELECT hash FROM stage_tx WHERE trade_id != ?').all(tradeId).map((r) => r.hash));
}

// One search per trade and stage at a time: a second click, or a second tab,
// waits for the first rather than asking Etherscan the same thing again.
const txSearches = new Map();

/** The chain of a wallet by id, or null for none. */
function chainOfWallet(id) {
  return id == null ? null : (prepare('SELECT network FROM wallets WHERE id = ?').get(id)?.network ?? null);
}

/**
 * The trade's own pasted hashes, by stage: what a loan's or repayment's tie is
 * settled against. Pasted only. A searched one may itself have been a guess
 * between equal fits, and that doubt is not stored, so it is worked out again
 * with its doubt, which the loan then carries; taken as fact, a guessed
 * purchase made the loan it settled read as certain.
 */
function ownHashes(tradeId) {
  return Object.fromEntries(
    prepare("SELECT stage, hash FROM stage_tx WHERE trade_id = ? AND source = 'manual'").all(tradeId).map((r) => [r.stage, r.hash]),
  );
}

// Which stage's searched hash was found by way of this one's (`ANCHOR`).
const DEPENDENT = Object.fromEntries(Object.entries(ANCHOR).map(([stage, anchor]) => [anchor, stage]));

/** Forget the searched hash that was settled by this stage's, now changed. */
function dropDependent(tradeId, stage) {
  if (!DEPENDENT[stage]) return 0;
  return prepare("DELETE FROM stage_tx WHERE trade_id = ? AND stage = ? AND source = 'search'").run(tradeId, DEPENDENT[stage]).changes;
}

const takenBy = (hash, tradeId) =>
  prepare('SELECT trade_id, stage FROM stage_tx WHERE hash = ? AND trade_id != ?').get(hash, tradeId);

async function searchAndStore(trade, stage, wallet) {
  // Twice at most: a hash another trade took while this one searched is
  // searched past, as it would have been had it been taken first; and a
  // purchase or sale pasted meanwhile is searched against, as it would have
  // been had it been pasted first.
  const anchor = ANCHOR[stage];
  for (let pass = 0; pass < 2; pass += 1) {
    const own = ownHashes(trade.id);
    const r = await findStageTx(trade, stage, wallet, claimedHashes(trade.id), own);
    if (!r.found) return r;
    // Seconds have passed. Stored only if what the search went by is
    // unchanged, if no other trade took that hash meanwhile - the hashes it
    // excluded were read before the wait, and two magnifiers pressed together
    // linked one loan to both trades - and if nothing was stored for this
    // stage meanwhile, by a paste or the other copy, which then stands and is
    // what is answered.
    const out = db
      .transaction(() => {
        const now = selectOne.get(trade.id);
        if (!now) return { found: false, reason: 'The trade was deleted while it was being searched.' };
        if (txBasis(stage).some((k) => (now[k] ?? null) !== (trade[k] ?? null))) {
          return { found: false, reason: 'The trade was edited while it was being searched. Search again.' };
        }
        // The loan or repayment was settled against the pasted purchase or
        // sale as it was read before the wait. Pasted, replaced or forgotten
        // since, this is not its answer: a loan searched while its purchase
        // was pasted was stored from the guessed purchase, beside the pasted
        // one, and the paste's `dropDependent` had found no loan to drop yet.
        if (anchor && (ownHashes(trade.id)[anchor] ?? null) !== (own[anchor] ?? null)) {
          return { again: `The ${STAGE_NAMES[anchor]}'s hash changed while this was searched. Search again.` };
        }
        const taken = takenBy(r.hash, trade.id);
        if (taken) {
          return { again: `That transaction was linked to trade #${taken.trade_id} while this one was searched. Search again.` };
        }
        prepare(
          'INSERT INTO stage_tx (trade_id, stage, hash, source, found_at) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT (trade_id, stage) DO NOTHING',
        ).run(trade.id, stage, r.hash, 'search', new Date().toISOString());
        const row = selectStageTx.get(trade.id, stage);
        const mine = row.hash === r.hash;
        return { found: true, ...txView(row), at: mine ? r.at : null, others: mine ? r.others : 0 };
      })
      .immediate();
    if (!out.again) return out;
    if (pass === 1) return { found: false, reason: out.again };
  }
  return { found: false, reason: 'The search failed. Try again.' };
}

/**
 * Find a stage's transaction: the stored one when there is one - found once,
 * never asked for again - otherwise a search. Found or not, the answer is
 * 200: not finding one is a result the card shows, as the rate endpoints do.
 */
app.post('/api/trades/:id/tx/:stage/find', async (req, res, next) => {
  try {
    const target = txTarget(req, res);
    if (!target) return;
    const { trade, stage } = target;
    const stored = selectStageTx.get(trade.id, stage);
    if (stored) return res.json({ found: true, ...txView(stored) });
    if (!stageRecorded(trade, stage)) throw new BadRequest(`Record the ${STAGE_NAMES[stage]} before searching for it.`, 'stage');
    if (trade.wallet_id == null) throw new BadRequest('Link a wallet on the Borrowed card first.', 'wallet_id');
    const wallet = selectWallet.get(trade.wallet_id);
    const key = `${trade.id}:${stage}`;
    let run = txSearches.get(key);
    if (!run) {
      run = searchAndStore(trade, stage, wallet).finally(() => txSearches.delete(key));
      txSearches.set(key, run);
    }
    res.json(await run);
  } catch (err) {
    next(err);
  }
});

/** A hash pasted by hand, kept over anything stored: its reader vouched for it. */
app.put('/api/trades/:id/tx/:stage', (req, res) => {
  const target = txTarget(req, res);
  if (!target) return;
  const { trade, stage } = target;
  if (!stageRecorded(trade, stage)) throw new BadRequest(`Record the ${STAGE_NAMES[stage]} first.`, 'stage');
  // A hash is a transaction on one chain, the trade's wallet's: with no
  // wallet, its link would guess one.
  if (trade.wallet_id == null) throw new BadRequest('Link a wallet on the Borrowed card first: a hash is on its chain.', 'wallet_id');
  // Read for that chain: an EVM hash lowercase, a Solana signature exactly as
  // pasted - lowercased, it named a transaction that does not exist.
  const parsed = parseTxHash(bodyOf(req).hash, chainOfWallet(trade.wallet_id));
  if (parsed.error) throw new BadRequest(parsed.error, 'hash');
  const { hash } = parsed;
  const row = db
    .transaction(() => {
      const other = takenBy(hash, trade.id);
      if (other) {
        throw new BadRequest(`That transaction is already the ${STAGE_NAMES[other.stage]} of trade #${other.trade_id}.`, 'hash');
      }
      // A loan or repayment found by way of the purchase or sale this
      // replaces was settled against the old one.
      if (selectStageTx.get(trade.id, stage)?.hash !== hash) dropDependent(trade.id, stage);
      prepare(
        'INSERT INTO stage_tx (trade_id, stage, hash, source, found_at) VALUES (?, ?, ?, ?, ?) ' +
          "ON CONFLICT (trade_id, stage) DO UPDATE SET hash = excluded.hash, source = 'manual', found_at = excluded.found_at",
      ).run(trade.id, stage, hash, 'manual', new Date().toISOString());
      return selectStageTx.get(trade.id, stage);
    })
    .immediate();
  res.json(txView(row));
});

app.delete('/api/trades/:id/tx/:stage', (req, res) => {
  const target = txTarget(req, res);
  if (!target) return;
  const info = db
    .transaction(() => {
      const gone = prepare('DELETE FROM stage_tx WHERE trade_id = ? AND stage = ?').run(target.trade.id, target.stage);
      if (gone.changes) dropDependent(target.trade.id, target.stage);
      return gone;
    })
    .immediate();
  if (info.changes === 0) return res.status(404).json({ error: 'No transaction is stored for that stage.' });
  res.status(204).end();
});

/**
 * Anything reaching here matched no route and no file on disk.
 *
 * An API caller gets JSON, because every other answer from /api is JSON and
 * handing a client an HTML page is a confusing way to say "no such path". A
 * browser gets the same page nginx serves for a missing public file, so the two
 * layers agree on what a missing page looks like.
 *
 * This sits after every route and before the error handler below on purpose.
 * Earlier and it would answer for the static mounts before they could; after
 * the error handler and it would never run at all, since Express dispatches a
 * four argument handler only when something has thrown.
 */
app.use((req, res, next) => {
  // `/api` exactly, as well as anything under it. Matching only the trailing
  // slash handed an API caller the browser's HTML error page for the one path
  // most likely to be typed by hand.
  // Any case, as the routes and the guards above match it: `/API/nope` was
  // handed the HTML page while `/API/version` answered JSON.
  const p = req.path.toLowerCase();
  if (p === '/api' || p.startsWith('/api/')) {
    return res.status(404).json({ error: 'No such endpoint.' });
  }
  res.status(404).sendFile(path.join(root, 'landing', '404.html'), (err) => {
    // The page is part of the repo, so a failure here means a broken checkout
    // rather than a bad request. Fall back to something rather than hanging.
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message, field: err.field });
  }
  if (err instanceof Conflict) {
    return res.status(409).json({ error: err.message, field: err.field, current: err.view(err.current) });
  }
  // express.json() rejects unparseable bodies with a SyntaxError.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'That request body was not valid JSON.' });
  }
  // An oversized body is the caller's problem, not a server fault.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request body was too large.' });
  }
  // `trades.wallet_id` naming a wallet that is no longer there, or a wallet
  // deleted from under a trade: each checked first, so only the other copy of
  // the app, acting between that check and the write - a wallet deleted while
  // a new trade's rate was looked up - gets here. Not a server fault.
  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(409).json({
      error: 'That wallet was deleted or linked elsewhere just now. Reload, then try again.',
      field: 'wallet_id',
    });
  }
  // A second instance on the same file held the write lock for longer than the
  // busy timeout. Reporting that as a 500 read as data loss.
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')) {
    return res.status(503).json({
      error: 'The ledger is busy, probably a second copy of the app writing to it. Try again.',
    });
  }
  // Anything else Express or the body parser already judged the caller's fault:
  // a path that is not valid percent-encoding, a body compressed in a way it
  // is not. Both are tagged 4xx and were answered 500, read as a server fault.
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'That request could not be read.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Loopback only. This is a personal ledger with no authentication, so it has
// no business being reachable from the rest of the network.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`ETH Roundtrip v${pkg.version} running at http://localhost:${PORT}`);
  const oldNames = oldSettingsNote();
  if (oldNames) console.log(oldNames);
  // Started here rather than at import, so the port being taken below cannot
  // leave a poller running in a process that is on its way out.
  reportConfig();
  // Alerts left armed on trades sold before alerts were closed on a sale.
  const closed = closeUnwatched();
  if (closed) console.log(`Closed ${closed} alert${closed === 1 ? '' : 's'} on trades no longer holding what they bought.`);
  startAlertPoller();
  startBotPoller();
  startFxRefresher();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try ./runETHRoundTrip.sh, which picks a free one.`);
  } else {
    console.error(err);
  }
  stopAlertPoller();
  stopBotPoller();
  stopFxRefresher();
  closeDb();
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down.`);
  // Before the database closes, or a tick landing mid-shutdown finds the
  // connection gone. The bot poller also aborts its long poll here, without
  // which stopping would wait out the rest of a fifty second request.
  stopAlertPoller();
  stopBotPoller();
  stopFxRefresher();
  // A sweep mid-send is let finish before the database closes, so its result
  // is written: closed under it, an alert claimed as fired stayed fired though
  // the send failed or never completed (`alertSweepDone`). So is a bot batch
  // being answered: its offset is already confirmed, so commands cut off here
  // are never handed out again (`botTickDone`). A send gives up after ten
  // seconds, so twelve is enough to wait.
  const finish = async () => {
    await Promise.race([
      Promise.all([alertSweepDone(), botTickDone()]),
      new Promise((r) => setTimeout(r, 12_000).unref()),
    ]);
    closeDb();
    process.exit(0);
  };
  server.close(finish);
  // Do not let a hung connection hold the database open indefinitely - but
  // later than the sweep above may take, or this would cut it short.
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 13_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
process.on('uncaughtException', (err) => {
  console.error(err);
  stopAlertPoller();
  stopBotPoller();
  stopFxRefresher();
  closeDb();
  process.exit(1);
});
